// Project Manager core logic - a faithful port of ../manager/manager.py.
// No chrome.* APIs here, so this module runs unchanged in the service worker,
// the popup, and node (see test/).
//
// Do not "improve" the check logic or verdict rules: they are validated against
// a real 19-round corpus. Any behavioural change must be made in manager.py
// first and then ported here; test/diff_test.py verifies parity.

import { EXTRACT_PROMPT } from "./prompt.js";
import { contentWords } from "./setup.js";

export { EXTRACT_PROMPT };

export const DEFAULT_MODEL = "gpt-4o";

// Why a model call failed, in the words the panel shows. Credit is told apart
// from a rate limit by OpenAI's error code: both are HTTP 429, and only the
// second is cured by waiting.
export const CALL_FAILURES = Object.freeze({
  noKey: "No OpenAI key entered. Add one in Options.",
  rejected: "OpenAI rejected this key, so it is probably mistyped. Check it in Options.",
  noCredit: "Key valid but the account has no credit. Add credit in your OpenAI account's billing settings, then capture again.",
  unreachable: "OpenAI unreachable. Check your connection and try again.",
  slow: "OpenAI unreachable: it took too long to answer. Try again.",
  rateLimited: "OpenAI is limiting how fast this key can make calls. Wait a minute and try again.",
});
const NO_CREDIT_CODES = new Set(["insufficient_quota", "billing_hard_limit_reached", "billing_not_active"]);
// status: the HTTP status. error: the "error" object of OpenAI's response, if any.
export function callFailureMessage(status, error) {
  if (status === 401) return CALL_FAILURES.rejected;
  if (NO_CREDIT_CODES.has(error?.code) || NO_CREDIT_CODES.has(error?.type)) return CALL_FAILURES.noCredit;
  if (status === 429) return CALL_FAILURES.rateLimited;
  // OpenAI error messages can include a masked key; strip anything key-shaped.
  const msg = String(error?.message || "").replace(/sk-[A-Za-z0-9_\-*]{4,}/g, "sk-…");
  return `OpenAI error ${status}. ${msg}`.trim();
}

export const SHAPES = ["SCREEN", "SELECTION", "PLAN", "CRITIQUE", "BUILD", "DEPLOY",
  "MEASUREMENT", "OTHER"];

// ---------------------------------------------------------- python helpers

// Python s[:n] - slices by code point, not UTF-16 unit.
function cut(s, n) {
  const a = Array.from(s ?? "");
  return a.length <= n ? (s ?? "") : a.slice(0, n).join("");
}

// Display truncation for evidence and handoff text: cut at a word boundary
// and mark it with an ellipsis, instead of manager.py's raw s[:n] (which can
// stop mid-word, e.g. "and delivered "). Only affects wording, never a
// status or verdict. test/diff_test.py switches to exact Python slicing so it
// can still compare every string byte-for-byte.
let exactPythonSlicing = false;
export function useExactPythonSlicing(on = true) { exactPythonSlicing = on; }

// manager.py parity mode: exact slicing AND manager.py's original C2 rule
// (no UNVERIFIABLE grace, no user resolutions). test/replay.mjs turns it on
// so test/diff_test.py can still compare every check byte-for-byte.
let managerPyParity = false;
export function useManagerPyParity(on = true) {
  managerPyParity = on;
  exactPythonSlicing = on;
}

// C2 grace: the extension only reads assistant output, so a commitment the
// user carried out themselves looks "not addressed". Such a round is
// UNVERIFIABLE (a WARN) until the commitment has been open this many rounds
// without the user confirming or closing it; only then is it a FAIL.
export const DEFAULT_GRACE_ROUNDS = 3;

// ---------------------------------------------------------- dates & phase
// A commitment may carry a due_date (YYYY-MM-DD). While that date is later
// than the round being judged it is SCHEDULED: not open for C2/C3, not judged
// by the next round, listed separately. "Now" is the round's capture date,
// so a past round keeps the verdict it had.
//
// A project's phase is ACTIVE or WAITING (deliberately accumulating data).
// WAITING relaxes C1 (repeated shapes are expected) and makes C5 context only.

export function normalizeDue(v) {
  const m = String(v ?? "").trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return "";
  const mo = +m[2], day = m[3] ? +m[3] : 1;
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return "";
  return `${m[1]}-${m[2]}-${String(day).padStart(2, "0")}`;
}

const dayOf = iso => String(iso || "").slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
function asOfRound(r) { return dayOf(r?.read_at) || today(); }

export function isScheduled(c, asOf) {
  return !managerPyParity && Boolean(c?.due_date) && c.due_date > asOf;
}

// Open commitments that count for C2/C3 at round `cur`, with age measured
// from when they fell due (a commitment can't be overdue before its date).
const isWaitingOn = c => c.modality === "offered" || c.modality === "contingent";
function actionableOpen(rounds, cur) {
  if (managerPyParity) return cur._open_commitments;
  const asOf = asOfRound(cur);
  // Offers and contingencies wait on an answer or an event: not aged by C3.
  return cur._open_commitments.filter(c => !isScheduled(c, asOf) && !isConfirmation(c.text) && !isWaitingOn(c)).map(c => {
    if (!c.due_date) return c;
    const age = rounds.filter(r => r.round > c.round && r.round <= cur.round && asOfRound(r) >= c.due_date).length;
    return { ...c, age_rounds: age };
  });
}

// ---------------------------------------------------------- confirmations
// A line awaiting a keystroke ("Confirm you want to install the development
// app.", "Press y to continue", "Type the label to confirm") - or awaiting the
// user's reply ("Tell me what appears in the search results") - is not a task.
// It never enters the ledger, and one that slipped in earlier never drives
// C2, C3 or the handoff. Deliberately narrow: "Confirm the pricing with the
// vendor" is a real commitment.
const CONFIRMATION_RES = [
  /^\s*(?:please\s+)?confirm\s+(?:that\s+)?you\s+(?:want|wish|agree|intend|are sure)\b/i,
  /^\s*(?:please\s+)?(?:press|hit|tap)\s+(?:y|n|yes|no|enter|return|any key|the \w+ key)\b/i,
  /^\s*(?:please\s+)?(?:type|enter)\b.*\bto\s+confirm\b/i,
  /^\s*(?:answer|reply|respond|enter|type)\s+["'“]?(?:y|yes|n|no)["'”]?\b/i,
  /\[(?:y\/n|y\/N|Y\/n|yes\/no)\]/,
  /^\s*(?:accept|approve)\s+the\s+(?:prompt|confirmation|dialog)\b/i,
  /^\s*(?:please\s+)?(?:tell|let)\s+me\s+(?:know\s+)?(?:what|whether|if|how|which|when)\b/i,
  /^\s*(?:please\s+)?(?:paste|share|send)\s+(?:me\s+)?(?:back\s+)?(?:the|your)\s+(?:full\s+)?(?:output|results?|errors?|logs?|screenshot)\b/i,
];
export function isConfirmation(text) {
  const t = String(text || "").trim();
  return Boolean(t) && CONFIRMATION_RES.some(re => re.test(t));
}

// The stale questions asked at capture (opt-in): open commitments three or
// more rounds old, oldest first, three at most. today: "YYYY-MM-DD".
// As in C3: offers and contingencies wait on an answer or an event, so they
// are never asked about as overdue, and an accepted offer ages from its
// acceptance.
export function staleQuestions(ledger, today) {
  const day = r => String(r.read_at || "").slice(0, 10);
  const list = [];
  for (const c of ledger.commitments) {
    if (c.status !== "OPEN") continue;
    if (c.due_date && c.due_date > today) continue;           // scheduled
    if (isWaitingOn(c)) continue;                              // offered or contingent
    const since = Math.max(c.accepted?.round ?? c.round, (c.still_open_round || 0) - 1);
    const rounds = ledger.rounds.filter(r => r.round > since && (!c.due_date || day(r) >= c.due_date)).length + 1;
    if (rounds > 2) list.push({ id: c.id, text: c.text, rounds, round: c.round, substeps: c.substeps?.length || 0 });
  }
  // Never interrogate: the oldest three at most.
  list.sort((a, b) => a.round - b.round);
  return { list: list.slice(0, 3), total: list.length };
}

function scheduledOpen(cur) {
  const asOf = asOfRound(cur);
  return cur._open_commitments.filter(c => isScheduled(c, asOf));
}

const isWaiting = opts => !managerPyParity && opts?.phase === "WAITING";

// Why the user's message was not read, in the words the panel shows. No reason
// (rounds from before v0.36.0, or nothing known): the cause was not recorded.
export const USER_READ_TEXT = Object.freeze({
  pasted: "your message was a pasted attachment, which the extension can't read",
  attachment: "your message was an attachment, which the extension can't read",
  "row-missing": "your message wasn't on the page when this was captured",
});
export const USER_READ_UNKNOWN = "couldn't read your message";
export const USER_PARTIAL_TEXT = Object.freeze({
  pasted: "read your typed text only: the pasted attachment beside it can't be read",
  attachment: "read your typed text only: the attachment beside it can't be read",
});
// Unread messages by what the row looked like, per site. A typed-looking message
// going unread is the regression signal for the readers of v0.36.0 and v0.37.0.
// Older rounds: a recorded reason says what the row looked like; otherwise
// nothing was recorded, and nothing is claimed.
export function unreadCounts(rounds = []) {
  const bySite = new Map();
  const siteOf = url => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown site"; } };
  for (const r of rounds) {
    const site = siteOf(r.source_url);
    if (!bySite.has(site)) bySite.set(site, { site, rounds: 0, unread: 0, paste: 0, typed: 0, unknown: 0, unrecorded: 0, partial: 0, unflagged: 0 });
    const c = bySite.get(site);
    c.rounds++;
    if (r.user_message_partial) c.partial++;
    if (r.user_messages_missing) {
      c.unread++;
      const why = r.user_message_reason;
      const looked = r.user_message_looked || (why === "pasted" || why === "attachment" ? "paste" : why === "row-missing" ? "unknown" : "unrecorded");
      c[looked]++;
    } else if (!r.user_excerpt) c.unflagged++;
  }
  return [...bySite.values()];
}
export function unreadLine(c) {
  if (!c?.unread) return "";
  const parts = [`${c.paste} looked like a paste`, `${c.typed} looked like ordinary typed text`, `${c.unknown} can't tell`];
  if (c.unrecorded) parts.push(`${c.unrecorded} from before this was recorded`);
  return `Messages not read on ${c.site}: ${c.unread} of ${c.rounds} round${c.rounds === 1 ? "" : "s"}. ${parts.join(", ")}.` +
    (c.partial ? ` ${c.partial} more read typed text only.` : "") +
    (c.typed ? " Typed text going unread means the reader is missing real messages." : "");
}
// A captured user message that is empty, or made only of private-use code
// points (icon-font glyphs) and whitespace, is a failed capture, not the
// user's words. Short replies ("go", "ok") are genuine.
export function usableUserText(s) {
  return String(s || "").replace(/[\p{Co}\s]/gu, "").length > 0;
}

export function clip(s, n) {
  if (exactPythonSlicing) return cut(s, n);
  const a = Array.from(s ?? "");
  if (a.length <= n) return s ?? "";
  let head = a.slice(0, n).join("");
  // Back up to the last whitespace, unless that would throw away most of it.
  const ws = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"), head.lastIndexOf("\t"));
  if (!/\s/.test(a[n]) && ws >= n * 0.6) head = head.slice(0, ws);
  return head.replace(/[\s.,;:!?\-–—]+$/u, "") + "…";
}

// ------------------------------------------------------------- drop record
// Every place that truncates, caps, skips, merges or overwrites data writes
// one entry when it actually drops something. The entries are stored with the
// round and shown on the panel: a debug-log line is not a record, because
// nobody sees it. kind: "truncated" | "capped" | "skipped" | "merged" |
// "overwritten" | "not run". lost: how much, in unit. detail: what, when short.
export function dropEntry(where, kind, lost, unit, detail) {
  return { where, kind, lost, unit, ...(detail ? { detail: String(detail) } : {}) };
}
const nChars = s => Array.from(String(s ?? "")).length;
// clip(), recording what it cut (the "…" it adds is not kept text).
export function clipNoting(s, n, drops, where) {
  const t = clip(s, n);
  if (drops && t !== (s ?? "")) drops.push(dropEntry(where, "truncated", nChars(s) - nChars(String(t).replace(/…$/, "")), "characters"));
  return t;
}

// What a capture sends to the model and keeps, and what that cuts.
export const PROMPT_CHARS = 60000;    // the reply, in the extraction and scope prompts
export const USER_CHARS = 8000;       // the user's message, sent to the model
export const EXCERPT_CHARS = 4000;    // text kept with the round for later reviews
export function captureTexts(text, userText) {
  const drops = [];
  if (nChars(text) > PROMPT_CHARS) {
    drops.push(dropEntry("reply, as sent to the extractor and scope checks", "truncated", nChars(text) - PROMPT_CHARS, "characters"));
  }
  const user = clipNoting(userText || "", USER_CHARS, drops, "your message, as sent to the model");
  const excerpt = clipNoting(text || "", EXCERPT_CHARS, drops, "reply text kept for later reviews");
  const userExcerpt = userText ? clipNoting(userText, EXCERPT_CHARS, drops, "your message kept for later reviews") : "";
  return { user, excerpt, userExcerpt, drops };
}

// Python len(s)
function plen(s) {
  return Array.from(s).length;
}

// Python s.split() with no argument
function psplit(s) {
  return s.split(/\s+/).filter(Boolean);
}

// Python f"{x:.0f}" - round half to even
function fmt0(x) {
  const f = Math.floor(x);
  const d = x - f;
  let r;
  if (d > 0.5) r = f + 1;
  else if (d < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return String(r);
}

// Python dict.get(key, default): default only when the key is missing
function get(o, k, dflt) {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : dflt;
}

// Python str(x) for values interpolated into f-strings
function pstr(x) {
  if (x === null || x === undefined) return "None";
  if (x === true) return "True";
  if (x === false) return "False";
  return String(x);
}

// Python str.format for EXTRACT_PROMPT: {{ }} are literal braces, {name} is a field.
export function formatPrompt(template, fields) {
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, name) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    if (!(name in fields)) throw new Error(`missing prompt field ${name}`);
    return fields[name];
  });
}

// ------------------------------------------------ difflib.SequenceMatcher port

// Port of difflib.SequenceMatcher(None, a, b).ratio(), including the autojunk
// "popular element" heuristic that applies when len(b) >= 200.
export function sequenceRatio(aStr, bStr) {
  const a = Array.from(aStr);
  const b = Array.from(bStr);
  const la = a.length, lb = b.length;
  if (la + lb === 0) return 1.0;

  const b2j = new Map();
  b.forEach((elt, i) => {
    if (!b2j.has(elt)) b2j.set(elt, []);
    b2j.get(elt).push(i);
  });
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [elt, idxs] of [...b2j]) {
      if (idxs.length > ntest) b2j.delete(elt);
    }
  }

  const NOTHING = [];
  function findLongestMatch(alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of (b2j.get(a[i]) || NOTHING)) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    // No junk (isjunk=None), so only the non-junk extension loops can fire;
    // they extend over "popular" elements removed from b2j.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi &&
           a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  let matches = 0;
  const queue = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return 2.0 * matches / (la + lb);
}

// ------------------------------------------------------------------- checks

// ------------------------------------------------- C7 asks piling up
// v2 counts the open commitments by who must act (the extraction's actor) and
// does not fire: v1's thresholds were fitted to counts that included almost
// every commitment, so they describe nothing once only the user's steps
// count. They are refitted from real rounds where the actor is known.
// A commitment with no actor (from before v0.21) counts as unclear.
const actorOfCommitment = c => (ACTORS.includes(c.actor) ? c.actor : "unclear");

// ------------------------------------------------ out-of-scope items (C6)
// HARD items bar something outright. CONDITIONAL items bar it only under a
// condition ("without sufficient justification", "prematurely") that C6
// can't evaluate. A temporal condition ("before the checkpoints") is not one:
// it is checkable against the record, so such an item stays HARD. The marker found, and the
// condition (the item from the marker on), are kept with the classification.
// The marker list is a correctness surface: an item it matches can no longer
// FAIL C6. Changing it must be deliberate; the unit tests pin the exact set.
export const SCOPE_CONDITION_MARKERS = Object.freeze(["without sufficient", "without adequate", "prematurely", "too early",
  "unless", "necessarily", "always", "merely", "only if", "insufficient"]);
const SCOPE_CONDITION_RE = new RegExp(`\\b(${SCOPE_CONDITION_MARKERS.join("|")})\\b`, "i");
export function classifyScopeItem(line) {
  const t = String(line || "");
  const m = t.match(SCOPE_CONDITION_RE);
  if (!m) return { kind: "HARD", marker: "", condition: "" };
  return { kind: "CONDITIONAL", marker: m[1], condition: t.slice(m.index).replace(/[\s.;,:]+$/, "") };
}
// One scope_checks entry per out-of-scope item, as stored on the round at
// capture: the model's answer, its quote check, and the item's classification.
export function scopeCheckEntries(lines, answers, text, drops) {
  return lines.map((line, i) => {
    const r = answers[i] || {};
    const breached = r.breached === true;
    const evidence = clipNoting(String(r.evidence || "").trim(), 300, drops, `scope check ${i + 1}: evidence`);
    const reason = breached ? clipNoting(String(r.reason || "").replace(/\s+/g, " ").trim(), 240, drops, `scope check ${i + 1}: reason`) : "";
    return { line, index: i + 1, ...classifyScopeItem(line), breached, evidence,
      verified: breached && quoteInText(evidence, text), ...(breached ? { reason } : {}), ...(r.error ? { error: r.error } : {}) };
  });
}

// opts.graceRounds: see DEFAULT_GRACE_ROUNDS.
export function runChecks(rounds, opts = {}) {
  if (!rounds.length) return [];
  const cur = rounds[rounds.length - 1];
  const prev = rounds.length > 1 ? rounds[rounds.length - 2] : null;
  const out = [];
  // state: optional refinement of status (only "UNVERIFIABLE" today).
  const add = (id, name, status, evidence, state) =>
    out.push(state ? { id, name, status, evidence, state } : { id, name, status, evidence });

  // C1 SHAPE REPETITION
  const shapes = rounds.map(r => r.output_shape);
  const last = shapes[shapes.length - 1];
  let run = 1;
  for (let i = shapes.length - 2; i >= 0; i--) {
    if (shapes[i] === last) run++;
    else break;
  }
  if (run >= 2 && isWaiting(opts)) {
    add("C1", "Shape repetition", "PASS",
      `Waiting phase: ${run} consecutive rounds of shape ${pstr(last)} - expected, not penalised`, "WAITING");
  } else if (run >= 3) {
    add("C1", "Shape repetition", "FAIL", `${run} consecutive rounds of shape ${pstr(last)}`);
  } else if (run === 2) {
    add("C1", "Shape repetition", "WARN", `Two consecutive rounds of shape ${pstr(last)}`);
  } else {
    add("C1", "Shape repetition", "PASS",
      `Shape changed from ${prev ? pstr(prev.output_shape) : "n/a"} to ${pstr(last)}`);
  }

  // C2 COMMITMENT EXECUTION  (highest weight)
  const st = get(cur, "prev_commitment_status", "NO_PREVIOUS");
  const ur = managerPyParity ? null : cur.user_resolution;
  const actionable = actionableOpen(rounds, cur);
  // The judged commitment as the ledger had it after this round: still open?
  const judgedOpen = managerPyParity ? null
    : (cur._open_commitments || []).find(c => c.text === get(cur, "judged_commitment", "")) || null;
  const judgedSuggestion = judgedOpen?.suggested_done?.round === cur.round ? judgedOpen.suggested_done : null;
  if (ur) {
    // The user resolved the judged commitment in one click (popup / panel).
    const jc = clip(get(cur, "judged_commitment", ""), 120);
    add("C2", "Commitment execution", "PASS",
      ur.status === "EXECUTED" ? `Marked executed by you: "${jc}"`
      : ur.status === "DEFERRED" ? `Deferred by you until ${ur.note}: "${jc}"`
      : `Closed by you: ${clip(ur.note || "", 120)}`);
  } else if (!managerPyParity && isConfirmation(get(cur, "judged_commitment", ""))) {
    add("C2", "Commitment execution", "PASS",
      `Not a commitment - an interactive confirmation: "${clip(get(cur, "judged_commitment", ""), 120)}"`);
  } else if (st === "NO_OPEN_COMMITMENT") {
    if (managerPyParity) add("C2", "Commitment execution", "PASS", "No open commitment to act on");
    else add("C2", "Commitment execution", "INFO", "No open commitment of the assistant's to judge", "NO_ASSISTANT_COMMITMENT");
  } else if (st === "RESTATED") {
    add("C2", "Commitment execution", "WARN",
      `Open commitment restated, not executed: "${clip(get(cur, "judged_commitment", ""), 120)}"`);
  } else if (judgedOpen && st === "SUPERSEDED") {
    // C2 reads the ledger (v0.33.0): the reply replacing the plan leaves it
    // open unless you decide, so it is not a PASS.
    add("C2", "Commitment execution", "WARN",
      `The reply replaces this plan, but it stays open until you decide: "${clip(judgedOpen.text, 120)}"`, "REPLACED");
  } else if (judgedOpen && (["EXECUTED", "CLOSED_WITH_REASON"].includes(st) || judgedSuggestion)) {
    // "Done" that is not in your words is a suggestion on the panel: C2 says
    // the same, never "executed" for a commitment still open.
    const q = judgedSuggestion?.quote || get(cur, "prev_commitment_evidence", "");
    add("C2", "Commitment execution", "WARN",
      `${judgedSuggestion?.from === "user" ? "Your message says" : "The reply says"} this is done; it stays open until you confirm it: "${clip(judgedOpen.text, 120)}"${q ? ` - “${clip(q, 160)}”` : ""}`, "SUGGESTED");
  } else if (["EXECUTED", "CLOSED_WITH_REASON", "SUPERSEDED", "NO_PREVIOUS"].includes(st)) {
    add("C2", "Commitment execution", "PASS", get(cur, "prev_commitment_evidence", ""));
  } else if (st === "DEFERRED_WITH_REASON") {
    add("C2", "Commitment execution", "WARN", get(cur, "prev_commitment_evidence", ""));
  } else if (st === "IN_PROGRESS" && !managerPyParity) {
    // This round worked on a sub-step of the judged commitment. Progress, but
    // a parent that stays open past the grace period is still circling.
    const pc = get(cur, "judged_commitment", "");
    const age = actionable.find(c => c.text === pc)?.age_rounds ?? 0;
    const grace = opts.graceRounds ?? DEFAULT_GRACE_ROUNDS;
    const parent = cur._open_commitments.find(c => c.text === pc);
    const steps = parent?.substeps?.length ?? 0;
    const step = cur.commitment_attached?.text || parent?.substeps?.at(-1)?.text || "";
    if (age < grace) {
      add("C2", "Commitment execution", "WARN",
        `In progress: sub-step "${clip(step, 80)}" toward "${clip(pc, 100)}"`, "IN_PROGRESS");
    } else {
      add("C2", "Commitment execution", "FAIL",
        `Still not done after ${age} rounds and ${steps} sub-step${steps === 1 ? "" : "s"}: "${clip(pc, 120)}"`);
    }
  } else if (managerPyParity) {
    const pc = get(cur, "judged_commitment", "");
    add("C2", "Commitment execution", "FAIL", `Previous commitment not addressed: "${clip(pc, 120)}"`);
  } else {
    // Not addressed in the assistant's output - but it may have been done by
    // the user, which this extension can't see.
    const pc = get(cur, "judged_commitment", "");
    const age = actionable.find(c => c.text === pc)?.age_rounds ?? 0;
    const grace = opts.graceRounds ?? DEFAULT_GRACE_ROUNDS;
    if (age < grace) {
      add("C2", "Commitment execution", "WARN",
        `Commitment may have been executed outside this conversation. Confirm or close it: "${clip(pc, 120)}"`,
        "UNVERIFIABLE");
    } else {
      add("C2", "Commitment execution", "FAIL",
        `Previous commitment not addressed, and not confirmed or closed after ${age} rounds: "${clip(pc, 120)}"`);
    }
  }

  // C3 SILENT ABANDONMENT  (open commitments ageing)
  const openC = actionable.filter(c => c.age_rounds >= 2);
  if (openC.length >= 3) {
    add("C3", "Silent abandonment", "FAIL",
      `${openC.length} commitments open for 2+ rounds, oldest from round ${openC[0].round}`);
  } else if (openC.length >= 1) {
    add("C3", "Silent abandonment", "WARN", `${openC.length} commitment(s) open 2+ rounds`);
  } else {
    add("C3", "Silent abandonment", "PASS", "No stale open commitments");
  }

  // C4 FAILURE-REASON REPETITION
  const reasons = rounds.map(r => get(r, "failure_reason", "")).filter(Boolean);
  const curR = (cur.failure_reason || "").toLowerCase();
  if (curR) {
    const kw = new Set(psplit(curR).filter(w => plen(w) > 5));
    let similar = 0;
    for (const r of reasons.slice(0, -1)) {
      const words = new Set(psplit(r.toLowerCase()).filter(w => plen(w) > 5));
      let common = 0;
      for (const w of kw) if (words.has(w)) common++;
      if (common >= 2) similar++;
    }
    if (similar >= 2) {
      add("C4", "Failure-reason repetition", "FAIL",
        `Similar failure reason in ${similar} prior rounds: "${clip(curR, 90)}"`);
    } else if (similar === 1) {
      add("C4", "Failure-reason repetition", "WARN", "Similar failure reason appeared once before");
    } else {
      add("C4", "Failure-reason repetition", "PASS", "New failure reason");
    }
  } else {
    add("C4", "Failure-reason repetition", "PASS", "No rejection in this round");
  }

  // C5 LEDGER RATIO - parity mode only (retired in the extension in v0.18.0).
  // Both counts are the model's reading of the captured reply, added up from
  // round 1: anything built outside the reply (Claude Code, a terminal) is
  // invisible to it, so the project that ships most scored worst. It never
  // drove a verdict; its only effects were a FAIL pill and a line in the
  // handoff. items_considered / artefacts_produced stay in the extraction and
  // the round (the verdict's "shipped" rule reads artefacts_produced).
  if (managerPyParity) {
  const items = rounds.reduce((s, r) => s + get(r, "items_considered", 0), 0);
  const arte = rounds.reduce((s, r) => s + get(r, "artefacts_produced", 0), 0);
  const ratio = items / Math.max(arte, 1);
  if (isWaiting(opts)) {
    add("C5", "Ledger ratio", "PASS",
      `Waiting phase: ${items} items considered, ${arte} artefacts - context only, not scored`, "WAITING");
  } else if (arte === 0 && items >= 25) {
    add("C5", "Ledger ratio", "FAIL", `${items} items considered, 0 artefacts produced`);
  } else if (ratio > 25) {
    add("C5", "Ledger ratio", "FAIL", `${items} items considered, ${arte} artefacts (${fmt0(ratio)}:1)`);
  } else if (ratio > 10) {
    add("C5", "Ledger ratio", "WARN", `${items} items considered, ${arte} artefacts (${fmt0(ratio)}:1)`);
  } else {
    add("C5", "Ledger ratio", "PASS", `${items} items considered, ${arte} artefacts`);
  }
  }

  // C6 GOAL ALIGNMENT
  // A CONDITIONAL out-of-scope item ("... without sufficient justification")
  // bars something only under a condition C6 can't evaluate, so a match is a
  // WARN that names the condition, never a FAIL and never a quoted "proof".
  // Rounds captured since v0.17.1 carry the classification; older ones are
  // classified here from the item's text.
  const ga = get(cur, "goal_alignment", "ON_GOAL");
  const scope = managerPyParity ? [] : (cur.scope_checks || [])
    .map((x, i) => ({ ...classifyScopeItem(x.line), index: i + 1, ...x }))
    .filter(x => x.breached);
  const cond = scope.filter(x => x.kind === "CONDITIONAL");
  const sure = scope.filter(x => x.kind !== "CONDITIONAL" && x.verified);
  const unsure = scope.filter(x => x.kind !== "CONDITIONAL" && !x.verified);
  const more = n => (n > 1 ? ` (+${n - 1} more)` : "");
  if (sure.length) {
    add("C6", "Goal alignment", "FAIL",
      `Breaches out-of-scope item "${clip(sure[0].line, 120)}": "${clip(sure[0].evidence, 160)}"${more(sure.length)}`, "OUT_OF_SCOPE");
    out.at(-1).reason = sure[0].reason || "";
  } else if (cond.length) {
    const c = cond[0];
    add("C6", "Goal alignment", "WARN",
      `Touches out-of-scope item ${c.index} ("${clip(c.line, 120)}"), which bars this only "${c.condition}". ` +
      `That condition can't be judged automatically: nothing here was checked for whether the round met it.${more(cond.length + unsure.length)}`,
      "OUT_OF_SCOPE_CONDITIONAL");
    out.at(-1).reason = c.reason || "";
  } else if (unsure.length) {
    const scope = unsure;
    add("C6", "Goal alignment", "WARN",
      `Possible breach of out-of-scope item "${clip(scope[0].line, 120)}" (the model's quote wasn't found in the response)${more(scope.length)}`, "OUT_OF_SCOPE");
    out.at(-1).reason = scope[0].reason || "";
  } else if (ga === "OFF_GOAL") {
    add("C6", "Goal alignment", "FAIL", get(cur, "goal_alignment_reason", ""));
  } else if (ga === "TANGENTIAL") {
    add("C6", "Goal alignment", "WARN", get(cur, "goal_alignment_reason", ""));
  } else if (!managerPyParity && (cur.scope_checks || []).some(x => x.error)) {
    // An out-of-scope item whose check failed is unknown, never a pass.
    const failed = (cur.scope_checks || []).map((x, i) => ({ ...x, index: x.index ?? i + 1 })).filter(x => x.error);
    add("C6", "Goal alignment", "UNKNOWN",
      `Out-of-scope item ${failed[0].index} ("${clip(failed[0].line, 120)}") couldn't be checked: the check failed (${clip(failed[0].error, 80)}). ` +
      `C6 can't say this round is in scope.${more(failed.length)}`, "SCOPE_CHECK_FAILED");
  } else {
    add("C6", "Goal alignment", "PASS", get(cur, "goal_alignment_reason", ""));
  }

  // C7 ASKS PILING UP (extension only): counts only, never WARN or FAIL.
  if (!managerPyParity) {
    const asOf = asOfRound(cur);
    const open = (cur._open_commitments || []).filter(c => !isConfirmation(c.text) && !isScheduled(c, asOf));
    const firm = open.filter(c => !isWaitingOn(c));
    const n = a => firm.filter(c => actorOfCommitment(c) === a).length;
    const m = k => open.filter(c => c.modality === k).length;
    add("C7", "Asks piling up", "INFO",
      `Open steps for you: ${n("user")} · unclear who acts: ${n("unclear")} · the assistant's: ${n("assistant")} · waits: ${n("none")} · ` +
      `offered, not yet accepted: ${m("offered")} · contingent: ${m("contingent")}. Counted, not scored, until refitted.`, "COUNTS_ONLY");
  }

  // Subjects (extension only): the commitments each check was about, by id,
  // so later events can be tied to a verdict without reading its evidence.
  // Statuses and evidence are unchanged.
  if (!managerPyParity) {
    const prevOpen = rounds.length > 1 ? rounds[rounds.length - 2]._open_commitments || [] : [];
    const jc = get(cur, "judged_commitment", "");
    const judged = jc ? [...(cur._open_commitments || []), ...prevOpen].find(c => c.text === jc) : null;
    const asOf = asOfRound(cur);
    const subjects = {
      C2: judged ? [judged.id] : [],
      C3: openC.map(c => c.id),
      C7: (cur._open_commitments || []).filter(c => actorOfCommitment(c) === "user" && !isWaitingOn(c) && !isConfirmation(c.text) && !isScheduled(c, asOf)).map(c => c.id),
    };
    for (const c of out) c.subjects = subjects[c.id] || [];
    // A check whose judgements are not validated reports and is scored, but
    // does not drive the verdict: C2 (actor and modality not yet validated)
    // and C6 (its scope and goal judgements not yet validated).
    for (const c of out) if (ADVISORY_CHECKS.includes(c.id)) c.advisory = true;
  }

  return out;
}

// C3 and C5 are CUMULATIVE: they describe project history, not this round.
// They are context only and can never drive a verdict on their own -
// otherwise the manager can never recognise recovery once history is bad.
// Verdict is driven by what happened THIS round.
// A check whose inputs are not validated reports but does not judge: outside
// parity mode C2 and C6 (ADVISORY_CHECKS) are left out here, so DEVIATION
// only arises in parity mode.
export const ADVISORY_CHECKS = Object.freeze(["C2", "C6"]);   // outside parity mode
// The checks that drive the verdict outside parity mode. Only these reach a
// handoff: it is pasted to an assistant that can't tell an advisory line
// from a judgement, so anything else in it would steer as if it judged.
export const VERDICT_CHECKS = Object.freeze(["C1", "C4"]);
export function verdict(checks, curRound) {
  const by = Object.fromEntries(checks.filter(c => managerPyParity || !ADVISORY_CHECKS.includes(c.id)).map(c => [c.id, c.status]));
  const ROUND_CHECKS = managerPyParity ? ["C1", "C2", "C4", "C6", "C7"] : VERDICT_CHECKS;
  const fails = checks.filter(c => c.status === "FAIL" && ROUND_CHECKS.includes(c.id));
  const warns = checks.filter(c => c.status === "WARN" && ROUND_CHECKS.includes(c.id));

  // Shipping something is progress, unless the goal itself has drifted.
  const shipped = get(curRound, "artefacts_produced", 0) > 0;
  if (by.C6 === "FAIL") return "DEVIATION";
  if (shipped && by.C2 !== "FAIL") return "PROGRESS";
  if (shipped && by.C2 === "FAIL" && !managerPyParity) {
    // Artefacts were produced this round. A C2 failure on a commitment raised
    // before them (i.e. in an earlier round) can't make this round a loop.
    const target = (curRound._open_commitments || []).find(c => c.text === curRound.judged_commitment);
    if (!target || target.round < curRound.round) return "PROGRESS";
  }
  if (by.C2 === "FAIL") return "LOOP";
  if (fails.length >= 2) return "LOOP";
  if (fails.length === 1 || warns.length >= 3) return "AT_RISK";
  return "PROGRESS";
}

// ------------------------------------------------------------- handoff prompt

// The handoff's goal (extension): the composed goal's "Explicitly out of
// scope" section, verbatim and in full, and the rest as goal prose. Only the
// prose is cut, and the cut is a drop. (manager.py cut the whole composed
// goal at 600 characters, which for most real projects removed every rule.)
export const HANDOFF_GOAL_CHARS = 600;
const OOS_HEADING = /^#+\s*Explicitly out of scope\s*$/im;
export function handoffGoal(goalText) {
  const t = String(goalText || "");
  const m = t.match(OOS_HEADING);
  let oos = "", rest = t;
  if (m) {
    const after = t.slice(m.index + m[0].length);
    const next = after.search(/^#/m);
    oos = (next >= 0 ? after.slice(0, next) : after).trim();
    rest = t.slice(0, m.index) + (next >= 0 ? after.slice(next) : "");
  }
  const prose = rest.replace(/^\s*#\s*PROJECT GOAL\s*\n/i, "").trim();
  const drops = [];
  const kept = clipNoting(prose, HANDOFF_GOAL_CHARS, drops, "handoff: goal text (the out-of-scope rules are sent in full)");
  return { oos, prose: kept, drops };
}

// openList: the open commitments to show (report() passes the actionable
// ones; defaults to manager.py's full snapshot).
export function handoff(v, checks, rounds, goalText, openList) {
  if (v === "PROGRESS") return null;
  const cur = rounds[rounds.length - 1];
  // manager.py: the open commitments, the oldest named in the instruction.
  // Extension: no commitments at all. Which ones to list rests on the same
  // unvalidated actor and modality labels, and "open N rounds" under a
  // heading saying the project is circling invites executing them.
  const openc = managerPyParity ? (openList ?? cur._open_commitments) : [];
  // Extension: the instruction names no commitment until actor and modality
  // are validated - the same labels that made C2 advisory (round 43 named an
  // offer nobody had accepted). The open commitments are still listed.
  const oldest = managerPyParity && openc.length ? openc[0] : null;
  const ev = checks.filter(c => (c.status === "FAIL" || c.status === "WARN") && (managerPyParity || VERDICT_CHECKS.includes(c.id)))
    .map(c => `- ${c.id} ${c.name}: ${pstr(c.evidence)}`);

  let head, instr;
  if (v === "DEVIATION") {
    head = "This work has drifted from the project goal.";
    instr = "Do not continue the current direction. State in one paragraph how the " +
            "current work serves the stated goal. If it does not, say so plainly and " +
            "stop. Reply with only that paragraph.";
  } else {
    head = "This project is circling rather than progressing.";
    if (oldest) {
      instr = `Do not propose a new candidate, option or direction. ` +
              `Either execute the open commitment "${clip(oldest.text, 160)}" ` +
              `(from round ${oldest.round}), or close it with a written reason ` +
              `stating why it is no longer worth doing. Reply with only that.`;
    } else {
      instr = "Do not propose a new candidate, option or direction. State in one " +
              "paragraph what has actually been produced so far and what single " +
              "action would produce the next artefact. Reply with only that.";
    }
  }

  const openLines = openc.slice(0, 6)
    .map(c => `- [round ${c.round}, open ${c.age_rounds} rounds] ${clip(c.text, 140)}`)
    .join("\n") || "- none";

  const openBlock = managerPyParity ? `OPEN COMMITMENTS (${openc.length}):\n${openLines}\n\n` : "";
  const g = managerPyParity ? null : handoffGoal(goalText);
  const goalBlock = managerPyParity ? `PROJECT GOAL:\n${clip(goalText.trim(), 600)}`
    : `${g.oos ? `OUT OF SCOPE (the owner has decided not to do these):\n${g.oos}\n\n` : ""}PROJECT GOAL:\n${g.prose}`;
  return `--- PASTE THIS TO YOUR AI ASSISTANT ---

${head}

${goalBlock}

EVIDENCE:
${ev.join("\n")}

${openBlock}INSTRUCTION:
${instr}

--- END ---`;
}

// ------------------------------------------------------------------- ledger

export function emptyLedger() {
  return { rounds: [], commitments: [], seen: {} };
}

// True when two commitment texts are substantially the same.
export function sameCommitment(a, b) {
  const norm = t => psplit(t.toLowerCase()).join(" ");
  return sequenceRatio(norm(a), norm(b)) >= 0.85;
}

// The model's stated commitments as a clean list of
// {text, due, kind, parent_id}, all of them: no cap (a silent cap would be a
// false claim of completeness). Accepts the list (objects or bare strings), a
// bare stated_commitment string from older responses (with its top-level due
// date and relation), or a list wrongly put in stated_commitment. Anything
// that isn't a non-blank string is skipped, never stored as text.
function statedCommitments(data, drops) {
  const rel = data.commitment_relation && typeof data.commitment_relation === "object" ? data.commitment_relation : {};
  const fromList = Array.isArray(data.stated_commitments) || Array.isArray(data.stated_commitment);
  const raw = Array.isArray(data.stated_commitments) ? data.stated_commitments
    : Array.isArray(data.stated_commitment) ? data.stated_commitment
    : [{ text: data.stated_commitment, due: data.stated_commitment_due, kind: rel.kind, parent_id: rel.parent_id }];
  const out = [];
  const notText = [], merged = [];
  for (const it of raw) {
    const o = typeof it === "string" ? { text: it } : it && typeof it === "object" && !Array.isArray(it) ? it : null;
    const text = typeof o?.text === "string" ? o.text.trim() : "";
    if (!text) {
      // A blank string means "none"; anything else that isn't text is dropped.
      if (fromList && typeof o?.text !== "string") notText.push(JSON.stringify(it)?.slice(0, 80) ?? String(it));
      continue;
    }
    if (out.some(x => sameStated(x.text, text))) { merged.push(text); continue; }
    out.push({ text, due: normalizeDue(o.due), kind: String(o.kind || "").toUpperCase(), parent_id: String(o.parent_id || "").trim(),
      actor: typeof o.actor === "string" ? o.actor.trim().toLowerCase() : "", source_sentence: typeof o.source_sentence === "string" ? o.source_sentence.trim() : "",
      modality: typeof o.modality === "string" ? o.modality.trim().toLowerCase() : "", condition: typeof o.condition === "string" ? o.condition.trim() : "" });
  }
  if (drops && notText.length) drops.push(dropEntry("stated commitments: not text", "skipped", notText.length, "items", notText.join("; ")));
  if (drops && merged.length) drops.push(dropEntry("stated commitments: same action listed twice", "merged", merged.length, "items", merged.join("; ")));
  return out;
}

// A procedure is one commitment (item 25). Steps the reply lists one after
// another for the user to do, all at once, are one piece of work, not seven.
// Keyed on the reply's structure, never on what the steps mean. A step is a
// firm, new, undated action for the user whose source sentence is on a line of
// the reply. A run of steps continues to the next if no more than one line of
// other text lies between them; anything else ends it.
// Both numbers are fitted to three stored rounds and not validated (README):
//   one line between: round 58's list, "That is it...", then two more steps,
//     and round 60's numbered steps, with the message to send between the last two;
//   at least three steps: another project's round 25's two separate tasks, in
//     adjacent paragraphs, are not a procedure.
const PROCEDURE_MIN_STEPS = 3, PROCEDURE_MAX_LINES_BETWEEN = 1;
function sourceLine(lines, source) {
  const want = norm(source);
  if (!want) return -1;
  // A source quoted across lines starts with its first line.
  return lines.findIndex(l => { const n = norm(l); return n && (n.includes(want) || (n.length >= 10 && want.startsWith(n))); });
}
// isOpenAlready: a step restating an open commitment stays itself, so it still
// counts as a restatement. Returns the items, each run as one item with .steps.
export function collapseProcedures(items, replyText, isOpenAlready = () => false, drops = null) {
  const lines = String(replyText || "").split("\n");
  const lineOf = it => (it.actor === "user" && it.modality === "committed" && (it.kind === "NEW" || !it.kind) && !it.due &&
    !isConfirmation(it.text) && !isOpenAlready(it)) ? sourceLine(lines, it.source_sentence) : -1;
  const out = [];
  let run = [], last = -1;
  const flush = () => {
    if (run.length >= PROCEDURE_MIN_STEPS) {
      out.push({ ...run[0], text: run.map(x => x.text.replace(/[.;:\s]+$/u, "")).join("; "),
        steps: run.map(x => ({ text: x.text, source_sentence: x.source_sentence })) });
      drops?.push(dropEntry("stated commitments: steps of one procedure", "merged", run.length - 1, "items", run.map(x => x.text).join("; ")));
    } else out.push(...run);
    run = []; last = -1;
  };
  for (const it of items) {
    const at = lineOf(it);
    if (at < 0) { flush(); out.push(it); continue; }
    const between = run.length ? lines.slice(last + 1, at).filter(l => norm(l)).length : 0;
    if (run.length && (at < last || between > PROCEDURE_MAX_LINES_BETWEEN)) flush();
    run.push(it); last = at;
  }
  flush();
  return out;
}

// A restatement may give a due date where there was none, never move one.
// Any change is recorded with the old value (and becomes a due_changed event).
function setDueFromRestatement(c, due, rn) {
  if (!due || c.due_date) return;
  (c.due_changes ??= []).push({ from: null, to: due, round: rn, by: "restatement" });
  c.due_date = due;
}

// Who must act on a commitment, as the extraction judged it: "assistant",
// "user", "none" (a wait or scheduled event) or "unclear" (the default).
// The judgement stands only if its source sentence is really in the reply
// (the same existence check C6 and done-from-content use); otherwise it is
// "unclear". Stored once, never re-inferred from the text later.
export const ACTORS = Object.freeze(["assistant", "user", "none", "unclear"]);
// Modality, judged the same way: "committed" (a firm next action), "offered"
// (waiting on the user's yes: "I can..., say the word"), "contingent"
// (waiting on an event: "if X happens, we do Y") or "unclear" (the default).
// An offer or a contingency needs its condition quoted verbatim from the
// reply (often the sentence after the source); unverified, it is "unclear".
export const MODALITIES = Object.freeze(["committed", "offered", "contingent", "unclear"]);
// Which definition of actor a label was judged under, stored with it, since
// labels are never re-judged. 1 (v0.21.0, no field stored): who performs it.
// 2 (v0.29.0): whose responsibility it is, so an instruction the reader will
// hand to another tool is still the user's.
export const ACTOR_DEF = 2;
// Hedges the text rule says must be kept ("never drop would, should or I
// think"): the ones in the source sentence that its text lacks. The same kind
// of containment test as wordsOutsideSource, in the other direction. Reports
// on the panel; judges nothing.
export const HEDGES = Object.freeze(["would", "should", "I think"]);
export function hedgesDropped(text, source) {
  const has = (t, h) => ` ${norm(t)} `.includes(` ${norm(h)} `);
  return HEDGES.filter(h => has(source, h) && !has(text, h));
}
// The words of a commitment's text that its source sentence does not contain:
// the same mechanical containment test as the source-against-reply check,
// one level down. It reports (on the panel); it judges nothing. Run on the
// whole source sentence, before it is cut for storage.
export function wordsOutsideSource(text, source) {
  const have = new Set(norm(source).split(" "));
  return [...new Set(norm(text).split(" ").filter(w => w && !have.has(w)))];
}
function actorOf(it, replyText, drops, id) {
  const source = String(it.source_sentence || "").trim();
  const verified = Boolean(source) && quoteInText(source, replyText || "");
  const actor = verified && ACTORS.includes(it.actor) ? it.actor : "unclear";
  let modality = verified && MODALITIES.includes(it.modality) ? it.modality : "unclear";
  const condition = String(it.condition || "").trim();
  const conditionVerified = Boolean(condition) && quoteInText(condition, replyText || "");
  if ((modality === "offered" || modality === "contingent") && !conditionVerified) modality = "unclear";
  return { actor, actor_def: ACTOR_DEF, modality, source_sentence: clipNoting(source, 300, drops, `source sentence of ${id}`), source_verified: verified,
    // A procedure's text is its steps' texts together: each is held to its own source.
    ...(it.steps ? { steps: it.steps.map(x => ({ text: x.text, source_sentence: clipNoting(x.source_sentence, 300, drops, `source sentence of a step of ${id}`), source_verified: quoteInText(x.source_sentence, replyText || "") })),
                     text_outside_source: [...new Set(it.steps.flatMap(x => wordsOutsideSource(x.text, x.source_sentence)))],
                     hedges_dropped: [...new Set(it.steps.flatMap(x => hedgesDropped(x.text, x.source_sentence)))] }
      : source ? { text_outside_source: wordsOutsideSource(it.text, source), hedges_dropped: hedgesDropped(it.text, source) } : {}),
    ...(condition ? { condition: clipNoting(condition, 300, drops, `condition of ${id}`), condition_verified: conditionVerified } : {}) };
}

// Acceptance of an offer is the user's decision, quoted from the user's
// message (never the reply). A quote too short for the usual check counts
// only when it is the user's whole message ("yes", "do it").
function userAccepts(quote, userText) {
  const q = norm(quote), u = norm(userText);
  if (!q || !u) return false;
  return q.length >= 12 ? quoteInText(quote, userText) : q === u;
}

// Two items in one reply that say the same thing: near-identical text, or
// every content word of the shorter one appears in the longer ("Save the
// amendment to the repository" / "Ensure the amendment is saved in the
// repository with its date"). Deliberately narrow: "deploy to staging" and
// "deploy to production" stay two.
function sameStated(a, b) {
  if (sameCommitment(a, b)) return true;
  // Fold inflections locally ("saved"/"save", "dates"/"date"); the shared
  // stemmer also drives the handoff filter, so it isn't changed here.
  const words = t => new Set(contentWords(t).map(w => w.replace(/(?:ing|ed|es|e|s)$/, "")));
  const A = words(a), B = words(b);
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  return small.size >= 2 && [...small].every(w => big.has(w));
}

// Commitments still open as of a given round.
export function rebuildOpen(led, uptoRound) {
  const out = [];
  for (const c of led.commitments) {
    if (c.round > uptoRound) continue;
    // deep copy: the snapshot must not track later restated_rounds pushes
    if (c.status === "OPEN") out.push({ ...structuredClone(c), age_rounds: uptoRound - (c.accepted?.round ?? c.round) });
  }
  return out.sort((x, y) => x.round - y.round);
}

// Judge against the most recent OPEN commitment in the ledger - the same one
// the closing logic in applyExtraction acts on - not just the previous round's.
// Scheduled commitments (due later than asOf) aren't judged yet.
// Newest round first; within that round, the lowest rank (the one the model
// listed first). Commitments without a rank keep plain newest-first.
function latestOpen(led, asOf = today()) {
  let best = null;
  for (let i = led.commitments.length - 1; i >= 0; i--) {
    const c = led.commitments[i];
    if (best && c.round !== best.round) break;
    if (!(c.status === "OPEN" && !isScheduled(c, asOf) && !(managerPyParity ? false : isConfirmation(c.text)))) continue;
    // C2 v2: only the assistant's own commitments, never a fallback to the
    // user's steps (or to commitments from before actors were recorded).
    if (!managerPyParity && (c.actor !== "assistant" || c.modality !== "committed")) continue;
    if (!best || (c.rank ?? Infinity) < (best.rank ?? Infinity)) best = c;
  }
  return best;
}

// Extension-only additions to manager.py's prompt (parity mode sends
// manager.py's prompt unchanged):
//  - stated_commitments: every distinct commitment, each with its
//    due date and relation to open commitments, instead of manager.py's single
//    stated_commitment (a reply often commits to more than one thing);
//  - completed_commitments: which of ALL the project's open commitments this
//    document shows were done, with a verbatim evidence quote. Work happens
//    in terminals and other chats, so any later response may report it.
// Note: the template uses str.format escaping, so literal braces are {{ }}.
function withExtensionFields(template, asOf) {
  return template
    .replace("PREVIOUS ROUND (for context; may be empty):\n{prev}\n",
      "PREVIOUS ROUND (for context; may be empty):\n{prev}\n\n" +
      "OPEN COMMITMENTS FOR THIS PROJECT (id: text; may be empty):\n{open_list}\n\n" +
      "USER MESSAGE SENT BEFORE THIS DOCUMENT (often pasted terminal output; may be empty):\n{user_msg}\n")
    .replace(/^ {2}"stated_commitment": .*,$/m,
      `  "stated_commitments": [{{"text": "the next action as source_sentence states it, shortened, never reworded", ` +
      `"due": "YYYY-MM-DD if the document states an explicit date or month for it, else empty string", ` +
      `"kind": "NEW|SUBSTEP|SAME|CONFIRMATION|ABOUT", "parent_id": "id of the related open commitment for SUBSTEP, SAME or ABOUT, else empty string", ` +
      `"actor": "assistant|user|none|unclear", "modality": "committed|offered|contingent|unclear", ` +
      `"source_sentence": "the sentence in the DOCUMENT that states it, copied verbatim", ` +
      `"condition": "for offered or contingent: the sentence in the DOCUMENT stating the condition, copied verbatim; else empty string"}}],` +
      `\n  "accepted_offers": [{{"id": "C-001", "evidence": "the user's words from the USER MESSAGE accepting it, copied verbatim"}}],` +
      `\n  "completed_commitments": [{{"id": "C-001", "evidence": "the sentence from the document showing it was done, copied verbatim"}}],` +
      `\n  "dropped_commitments": [{{"id": "C-001", "evidence": "the sentence from the USER MESSAGE deciding against it, copied verbatim"}}],`)
    .replace("- stated_commitment must be a specific action someone could later mark done\n  or not done, with a verb and a concrete object. Return an empty string for\n",
      "- each stated_commitments text must be a specific action someone could later mark done\n  or not done, with a verb and a concrete object. Leave out\n")
    // manager.py's two Good examples are bare imperatives with no one acting,
    // which teaches dropping the subject; these say who acts and where. None
    // comes from a real ledger (v0.29.0): an example taken from a round makes
    // re-extracting that round no test of anything.
    .replace('  Good: "Run the 4-hour IvyForms technical check"\n  Good: "Begin Atlassian Marketplace partner registration"\n',
      '  Good: {{"text": "Run the migration dry-run on staging and paste the output", "actor": "user", "modality": "committed",\n' +
      '         "source_sentence": "Run the migration dry-run on staging and paste the output here."}}\n' +
      '  Good: {{"text": "Add a retry to the upload step and rerun the upload tests", "actor": "user", "modality": "committed",\n' +
      '         "source_sentence": "Paste this into your coding agent: add a retry to the upload step and rerun the upload tests."}}\n' +
      '  Good: {{"text": "Write up the survey results", "actor": "assistant", "modality": "committed",\n' +
      '         "source_sentence": "I\'ll write up the survey results next."}}\n' +
      '  Good: {{"text": "Wait for the vendor\'s quote on Thursday", "actor": "none", "modality": "committed",\n' +
      '         "source_sentence": "We wait for the vendor\'s quote on Thursday before changing anything."}}\n' +
      '  Good: {{"text": "Draft the onboarding email", "actor": "assistant", "modality": "offered",\n' +
      '         "source_sentence": "I can also draft the onboarding email for the new hires.",\n' +
      '         "condition": "Just say yes and I will send it over today."}}\n' +
      '  Good: {{"text": "Switch the job to the backup bucket", "actor": "user", "modality": "contingent",\n' +
      '         "source_sentence": "If the export still fails tomorrow morning, switch the job to the backup bucket.",\n' +
      '         "condition": "If the export still fails tomorrow morning"}}\n')
    .replace(/\nDOCUMENT:\n\{doc\}/,
      `\n- stated_commitments lists EVERY distinct next action this document commits to, most\n` +
      `  important first. A reply often commits to more than one thing: list each\n` +
      `  (e.g. "Ensure that amendment is saved in the project repository" and "Accepted Core\n` +
      `  market dates reach 40 by 2026-10-28" are two). A target the document commits to\n` +
      `  reaching by a date counts. Never list the same action twice in different words.\n` +
      `  Return [] if there are none.\n` +
      `- text is taken from source_sentence: shorten it, or replace a pronoun with what it refers\n` +
      `  to in the DOCUMENT, and nothing else. Never add a verb the sentence does not use, and never\n` +
      `  drop "would", "should" or "I think": they are part of what was said. If the sentence\n` +
      `  names no action, leave the item out.\n` +
      `  Bad: {{"text": "Wait for the next firmware release",\n` +
      `        "source_sentence": "The next firmware release is expected after the holiday freeze."}}\n` +
      `       (a statement of when something happens, not an action: leave it out)\n` +
      `  Bad: {{"text": "Rename the column before the import",\n` +
      `        "source_sentence": "I would rename the column before the import."}}\n` +
      `       (drops "would"; the text is "I would rename the column before the import")\n` +
      `- actor says whose responsibility the item is, as the DOCUMENT states, not whose hands\n` +
      `  will perform it: "assistant" when the assistant takes it on itself ("I'll draft...",\n` +
      `  "Next I will compare..."); "user" when the document asks or instructs the reader to do\n` +
      `  it ("Run X in your terminal", "Tell me what appears"), including an instruction the\n` +
      `  reader will hand to another tool or agent ("Paste this into your coding agent: ..."):\n` +
      `  it is on the reader's plate either way; "none" when no one has to act (a wait, a\n` +
      `  scheduled event); "unclear" when the document doesn't say. Judge from the source\n` +
      `  sentence, not from the shortened text: "Run X" and "I'll run X" shorten to the same\n` +
      `  text but are the responsibility of different people.\n` +
      `- modality says whether it is promised: "committed" for a firm next action ("I'll write up\n` +
      `  the results next", "Run X in your terminal"); "offered" when it waits on the user's yes\n` +
      `  ("I can also draft the email... Just say yes", "Want me to...?"); "contingent" when it\n` +
      `  waits on an event outside the steps themselves ("If the export still fails tomorrow,\n` +
      `  switch..."); plain ordering of steps ("then", "after that") is not a condition.\n` +
      `  "unclear" when the document doesn't say. For offered and contingent, condition is the\n` +
      `  sentence or clause stating the condition, copied verbatim; it may be part of\n` +
      `  source_sentence ("If the export still fails tomorrow morning") or the sentence after it\n` +
      `  ("Just say yes and I will send it over today").\n` +
      `- accepted_offers lists offers from OPEN COMMITMENTS (marked "offered") that the USER MESSAGE\n` +
      `  accepts ("Yes, schedule it", "do it"). evidence is the user's words copied verbatim from the\n` +
      `  USER MESSAGE. Never use the document. [] when none.\n` +
      `- source_sentence is the sentence in the DOCUMENT that states the commitment, copied\n` +
      `  verbatim, never shortened or reworded (text may be shortened; source_sentence may not).\n` +
      `- due is only for an explicit date or month the document gives for that commitment\n` +
      `  ("before March 2027" -> "2027-03-01"; "by 15 June 2027" -> "2027-06-15").\n` +
      `  If only a month and year are given, use the first day of that month. Never infer a date\n` +
      `  from vague timing ("soon", "next phase"). Today is ${asOf}.\n` +
      `- completed_commitments lists commitments from OPEN COMMITMENTS that this document OR\n` +
      `  the USER MESSAGE clearly shows were DONE: stated as completed, concrete, past tense\n` +
      `  (e.g. "I ran the count: 12,401 users"), or pasted output of a command that ran\n` +
      `  successfully (e.g. "Deployed version 2.1.0 to development"). Pasted errors are not done.\n` +
      `  evidence is that sentence or output line copied verbatim from where you found it.\n` +
      `  Leave a commitment out if it is only planned, in progress, partly done, or if you are\n` +
      `  unsure. Use only ids from OPEN COMMITMENTS. Return [] when none.\n` +
      `- dropped_commitments lists commitments from OPEN COMMITMENTS that the USER MESSAGE\n` +
      `  decides against: the user states a decision that contradicts the commitment, so it is\n` +
      `  no longer the plan (e.g. commitment "Run it for a week first, then decide", user: "I\n` +
      `  think we have enough info to start and improve it"). evidence is the user's sentence\n` +
      `  copied verbatim from the USER MESSAGE. Never use the document: the assistant proposing\n` +
      `  to drop something is a suggestion, not a decision. Leave it out when the user only\n` +
      `  acknowledges or defers ("ok", "sure", "later"), or simply moves on to other work\n` +
      `  without deciding against it. [] when none.\n` +
      `- kind and parent_id say how each stated commitment relates to OPEN COMMITMENTS:\n` +
      `  SUBSTEP = a step toward an existing open commitment, not a separate task. Examples:\n` +
      `    "run forge login", "run npm install", "run npx forge lint --fix" are sub-steps of\n` +
      `    "register and deploy the Forge app"; retrying a failed command is a sub-step too.\n` +
      `  SAME = the same task as an existing open commitment, even if worded differently.\n` +
      `    Examples: "run forge lint --fix" vs "run forge lint --verbose";\n` +
      `    "wait and collect data" vs "keep collecting until 15 Oct".\n` +
      `  CONFIRMATION = the stated next action is only answering an interactive prompt\n` +
      `    ("Confirm you want to install the development app.", "Press y to continue",\n` +
      `    "Type the label to confirm"). That is not a task.\n` +
      `  ABOUT = an instruction or decision about an existing open commitment (close it, drop it,\n` +
      `    change its date, mark it done), e.g. "Close C-042 with reason: never agreed". That is\n` +
      `    not the commitment again and not a new task. parent_id is that commitment's id.\n` +
      `  NEW = a genuinely separate task.\n` +
      `  parent_id is the related commitment's id for SUBSTEP, SAME or ABOUT, else "".\n\nDOCUMENT:\n{doc}`);
}

// Every OPEN commitment, for the completed_commitments question.
function openListText(led) {
  const open = led.commitments.filter(c => c.status === "OPEN" && !isConfirmation(c.text));
  return open.map(c => `- ${c.id}${c.modality === "offered" ? " (offered, not yet accepted)" : c.modality === "contingent" ? " (contingent)" : ""}: ` +
    `${c.text}${c.due_date ? ` (due ${c.due_date})` : ""}` +
    `${c.substeps?.length ? ` (${c.substeps.length} sub-step${c.substeps.length === 1 ? "" : "s"} logged)` : ""}`).join("\n") || "none";
}

// Does the model's evidence quote really appear in the document? Guards
// against invented evidence: no match, no auto-resolution.
function norm(t) {
  return String(t || "").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function quoteInText(quote, text) {
  const q = norm(quote);
  if (q.length < 12) return false;
  const t = norm(text);
  if (t.includes(q)) return true;
  // tolerate light reformatting: 90% of the quote's words, in order
  const qw = q.split(" "), tw = t.split(" ");
  if (qw.length < 5) return false;
  let j = 0, hit = 0;
  for (const w of qw) {
    const k = tw.indexOf(w, j);
    if (k !== -1) { hit++; j = k + 1; }
  }
  return hit / qw.length >= 0.9;
}

// A commitment is superseded only by the USER's decision, quoted from their
// own message: never by the assistant's words (closure by assertion), and
// never by a bare acknowledgement or deferral, which doesn't contradict it.
const ACK_WORDS = new Set(("ok okay k sure yes yeah yep fine alright right cool great good sounds thanks thank you " +
  "noted got it will do that this maybe later not now let s lets come back to soon sometime another time perhaps").split(" "));
function isAcknowledgement(quote) {
  const w = norm(quote).split(" ").filter(Boolean);
  return !w.length || w.every(x => ACK_WORDS.has(x));
}
export function userDecision(quote, userText) {
  return Boolean(String(userText || "").trim()) && !isAcknowledgement(quote) && quoteInText(quote, userText);
}

// ---------------------------------------------------------- ledger review
// Re-judges every open commitment against the rounds captured AFTER it was
// raised - the catch-up for commitments that predate resolve/drop-from-
// content, or that an extraction missed. Same rules as extraction: only
// clear, quoted evidence changes anything; everything else stays open and ages.

export const REVIEW_VERSION = 1;
export const REVIEW_MARKER = "REVIEW OPEN COMMITMENTS";

// material: [{ round, kind: "response" | "summary", text }]
export function buildReviewPrompt(goalText, commitments, material) {
  const cs = commitments.map(c => `- ${c.id} (raised in round ${c.round}): ${c.text}`).join("\n");
  const ms = material.map(m => `=== ROUND ${m.round} (${m.kind === "response" ? "response text" : "summary only - original text not kept"}) ===\n${m.text}`).join("\n\n");
  return `${REVIEW_MARKER} for a project audit. You extract facts only.

PROJECT GOAL:
${goalText}

OPEN COMMITMENTS:
${cs}

For EACH open commitment, judge it ONLY from rounds captured after it was raised:
- DONE: a later round clearly reports it completed (concrete, past tense), in the
  assistant's response OR in the USER's message - e.g. pasted output of a command
  that ran successfully. Pasted errors are not DONE.
- DROPPED: in a later round, the USER's message states a decision that contradicts
  it, so it is no longer the plan (e.g. "we're not doing X", "we have enough info to
  start"). Only lines after "USER:" count. The assistant proposing or announcing a
  drop is not a decision. Acknowledging or deferring ("ok", "later") or moving on to
  other work is not DROPPED.
- OPEN: later rounds show it is still pending or in progress.
- UNSURE: anything else. When in doubt, UNSURE.
For DONE or DROPPED, give the round number and copy the evidence sentence
verbatim from that round's material below.

Return ONLY valid JSON, no prose, no code fences:
{"results": [{"id": "C-001", "status": "DONE|DROPPED|OPEN|UNSURE", "round": 5, "evidence": "verbatim sentence, or empty"}]}

${ms}
`;
}

// The material a round contributes: its kept response text, else the
// summary fields its extraction stored.
// The catch-up review's material: each round's text clipped, then the most
// recent rounds that fit the budget. Records what it cut and left out.
export const REVIEW_ROUND_CHARS = 2500;
export const REVIEW_TOTAL_CHARS = 40000;
export function reviewMaterial(rounds, from) {
  const drops = [];
  const all = rounds.filter(r => r.round > from).map(r => {
    const m = roundMaterial(r);
    const text = clip(m.text, REVIEW_ROUND_CHARS);
    return { ...m, text, cut: text !== m.text ? nChars(m.text) - nChars(text.replace(/…$/, "")) : 0 };
  });
  let total = 0;
  const kept = all.slice().reverse().filter(m => (total += m.text.length) <= REVIEW_TOTAL_CHARS).reverse();
  const left = all.filter(m => !kept.includes(m)).map(m => m.round);
  // Text cut from rounds that were then left out whole is counted with them, not twice.
  const lost = kept.reduce((n, m) => n + m.cut, 0);
  const cutRounds = kept.filter(m => m.cut).map(m => m.round);
  if (lost) drops.push(dropEntry("review: round text cut to 2,500 characters", "truncated", lost, "characters", `rounds ${cutRounds.join(", ")}`));
  if (left.length) drops.push(dropEntry("review: rounds left out (40,000-character budget)", "capped", left.length, "rounds", `rounds ${left.join(", ")}`));
  return { material: kept.map(({ cut, ...m }) => m), drops };
}

export function roundMaterial(r) {
  if (r.text_excerpt || r.user_excerpt) {
    // The user's message (pasted terminal output) is where "run X" shows as done.
    const parts = [];
    if (r.user_excerpt) parts.push(`USER: ${r.user_excerpt}`);
    if (r.text_excerpt) parts.push(`ASSISTANT: ${r.text_excerpt}`);
    return { round: r.round, kind: "response", text: parts.join("\n"), user: r.user_excerpt || "" };
  }
  const parts = [r.summary, r.failure_reason, r.prev_commitment_evidence, r.goal_alignment_reason,
    r.stated_commitment ? `Next: ${r.stated_commitment}` : ""].filter(Boolean);
  return { round: r.round, kind: "summary", text: parts.join("\n"), user: "" };
}

// Apply verified review results (mutates led). Returns what changed.
// run: { at, round } - when the review ran and the round being captured then
// (for the manual Re-check, the latest round). Stored on each closure beside
// the evidence round, which is usually earlier: the review back-dates.
export function applyReview(led, results, material, run = {}) {
  if (managerPyParity) return [];
  const byRound = new Map(material.map(m => [m.round, m.text]));
  const userByRound = new Map(material.map(m => [m.round, m.user || ""]));
  const last = led.rounds[led.rounds.length - 1];
  const changed = [];
  for (const r of Array.isArray(results) ? results : []) {
    const status = String(r?.status || "").toUpperCase();
    if (status !== "DONE" && status !== "DROPPED") continue;
    const c = led.commitments.find(x => x.id === String(r.id || "").trim() && x.status === "OPEN");
    const round = Number(r.round);
    const quote = String(r.evidence || "").trim();
    if (!c || !Number.isInteger(round) || round <= c.round) continue;   // evidence must come after it was raised
    if (status === "DONE" ? !quoteInText(quote, byRound.get(round))     // unverifiable: leave it open
        : !userDecision(quote, userByRound.get(round))) continue;        // superseded only by the user's own words
    const q = clip(quote, 300);
    // Never closed (v0.34.0): a suggestion, confirmed by one click.
    c.suggested_done = { round, quote: q, from: status === "DROPPED" || quoteInText(quote, userByRound.get(round)) ? "user" : "review", views_recorded: true,
      via: "review", ...(status === "DROPPED" ? { superseded: true } : {}), ...(run.round != null ? { recorded_round: run.round } : {}) };
    changed.push({ id: c.id, status: status === "DONE" ? "EXECUTED" : "SUPERSEDED", proposed: true, round, quote: q });
  }
  return changed;   // proposals only: the review never closes anything
}

// A resolution's id, from its own fields: the same resolution always gets the
// same id, so a reversal (and later events) can name what it reverses.
export function resolutionId(c) {
  return `${c.id}/${c.status}/r${c.resolved_round ?? "?"}/${c.resolved_by || "model"}${c.resolved_at ? `/${c.resolved_at}` : ""}`;
}

// ---------------------------------------------------------- event record
// An append-only record of what happened, for measuring the checks later:
// every verdict rendered, and every later event that bears on one. Events
// only, no judgement: which outcome an event means is decided elsewhere, by
// a versioned mapping, so history can be re-read when the mapping changes.
// Events are derived from the ledger before and after each change, so every
// path that changes a ledger is covered the same way.

// The event types that can bear on a verdict's outcome. Verdicts and newly
// raised commitments are not outcomes.
// Edits to a project's definition (v0.34.0): one project_edited event per
// field that changed, with its old and new value, so the inputs to every
// check can always be traced. Mechanical, no model. before null = created.
// meta: { at, by: "user" | "repair" | ..., via? }.
export const PROJECT_FIELDS = Object.freeze(["name", "goal", "outOfScope", "phase"]);
export function projectEditEvents(before, after, meta = {}) {
  const out = [];
  for (const field of PROJECT_FIELDS) {
    const from = before ? (before[field] ?? null) : null, to = after?.[field] ?? null;
    if (from === to || (before == null && (to == null || to === ""))) continue;
    out.push({ type: "project_edited", project: after?.id ?? before?.id ?? null, at: meta.at ?? null, field, from, to, by: meta.by || "user",
      ...(meta.via ? { via: meta.via } : {}) });
  }
  return out;
}

export const OUTCOME_TYPES = Object.freeze(["resolved", "reopened", "deferred", "still_open", "restated", "accepted", "undone"]);
export const EVENT_CAP_BYTES = 5_000_000;

// meta: { at, project, round?, checks? } - checks (with subjects) for the
// round just captured, which become one verdict event each.
export function ledgerEvents(before, after, meta = {}) {
  const base = { at: meta.at, project: meta.project };
  const out = [];
  for (const c of meta.checks || []) {
    out.push({ ...base, type: "verdict", round: meta.round ?? null, check: c.id, status: c.status, evidence: String(c.evidence ?? ""),
      version: CHECK_VERSIONS[c.id] ?? null, subjects: c.subjects || [], ...(c.state ? { state: c.state } : {}) });
  }
  const old = new Map((before?.commitments || []).map(c => [c.id, c]));
  const lastRound = after?.rounds?.at(-1)?.round ?? null;
  for (const c of after?.commitments || []) {
    const b = old.get(c.id);
    if (!b) out.push({ ...base, type: "raised", commitment: c.id, round: c.round });
    for (const r of (c.reversals || []).slice(b?.reversals?.length || 0)) {
      out.push({ ...base, type: "reopened", commitment: c.id, reverses: r.resolution.id, round: r.reversed_in_round ?? null });
    }
    if (c.status !== "OPEN" && (!b || b.status === "OPEN" || resolutionId(b) !== resolutionId(c))) {
      out.push({ ...base, type: "resolved", commitment: c.id, resolution: resolutionId(c), status: c.status,
        by: c.resolved_by || "model", via: c.resolved_by === "user" ? "click" : c.reviewed ? "review" : "capture",
        round: c.resolved_round ?? null, note: c.resolution_note || "", ...(c.recorded_round != null ? { recorded_round: c.recorded_round } : {}) });
    }
    if (c.deferred_at && c.deferred_at !== b?.deferred_at) out.push({ ...base, type: "deferred", commitment: c.id, due: c.due_date, round: lastRound });
    if (b && b.modality === "offered" && c.modality === "committed" && c.accepted) {
      out.push({ ...base, type: "accepted", commitment: c.id, quote: c.accepted.quote, round: c.accepted.round });
    }
    if (b && (c.due_date || null) !== (b.due_date || null)) out.push({ ...base, type: "due_changed", commitment: c.id, from: b.due_date || null, to: c.due_date || null, round: lastRound });
    if (c.still_open_round && c.still_open_round !== b?.still_open_round) out.push({ ...base, type: "still_open", commitment: c.id, round: lastRound });
    for (const rn of (c.restated_rounds || []).slice(b?.restated_rounds?.length || 0)) out.push({ ...base, type: "restated", commitment: c.id, round: rn });
  }
  return out;
}

// Undo restores an earlier ledger. Nothing in the record is deleted: one
// "undone" event names the rounds removed and the commitments put back.
export function undoEvents(current, restored, meta = {}) {
  const kept = new Set((restored?.rounds || []).map(r => r.round));
  const rounds = (current?.rounds || []).map(r => r.round).filter(n => !kept.has(n));
  const was = new Map((restored?.commitments || []).map(c => [c.id, c]));
  const commitments = (current?.commitments || []).filter(c => {
    const r = was.get(c.id);
    return !r || r.status !== c.status || resolutionId(r) !== resolutionId(c) || (r.reversals?.length || 0) !== (c.reversals?.length || 0);
  }).map(c => c.id);
  return rounds.length || commitments.length ? [{ at: meta.at, project: meta.project, type: "undone", rounds, commitments }] : [];
}

// Append `add` to project `projectId` within `cap` bytes (all projects
// together). Over the cap, the oldest verdict events lose their evidence text
// first (check, status, version and subjects stay); outcome events are never
// touched. If that isn't enough, nothing is appended and `full` is set.
export function fitEvents(stored, add, projectId, cap = EVENT_CAP_BYTES) {
  const by = structuredClone(stored || {});
  by[projectId] = [...(by[projectId] || []), ...add];
  let size = JSON.stringify(by).length;
  let compacted = 0;
  if (size > cap) {
    const verdicts = Object.values(by).flat().filter(e => e.type === "verdict" && !e.compacted && e.evidence)
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const e of verdicts) {
      if (size <= cap) break;
      size -= JSON.stringify(e.evidence).length + 12 - 17;   // "evidence":"…", out; "compacted":true, in
      delete e.evidence;
      e.compacted = true;
      compacted++;
    }
    size = JSON.stringify(by).length;
  }
  if (size > cap) return { byProject: stored || {}, compacted: 0, full: true };
  return { byProject: by, compacted, full: false };
}

// Reopen a resolved commitment (mutates led): it is open again. If resolving
// it had turned a round's C2 into EXECUTED, C2 goes back to what the model
// originally reported. Nothing is lost: before anything changes, the
// resolution being reversed (and the round-level records it had set) is
// appended to c.reversals, marked with when and in which round it was reversed.
export function reopenInLedger(led, c, at) {
  const last = led.rounds[led.rounds.length - 1];
  const resolvedRound = led.rounds.find(r => r.round === c.resolved_round);
  const resolution = { id: resolutionId(c) };
  for (const k of ["status", "resolved_round", "resolution_note", "resolved_by", "resolved_at", "reviewed", "recorded_at", "recorded_round"]) {
    if (c[k] !== undefined) resolution[k] = c[k];
  }
  const urOf = r => (r?.user_resolution?.id === c.id ? structuredClone(r.user_resolution) : undefined);
  (c.reversals ??= []).push({
    resolution, reversed_at: at, reversed_in_round: last?.round ?? null,
    ...(urOf(resolvedRound) || urOf(last) ? { round_user_resolution: urOf(resolvedRound) || urOf(last) } : {}),
    ...(resolvedRound?.judged_commitment === c.text && resolvedRound.auto_overrode ? { auto_overrode: structuredClone(resolvedRound.auto_overrode) } : {}),
  });
  // Only now are the live resolution fields cleared (they are kept above).
  for (const k of ["reviewed", "recorded_at", "recorded_round"]) delete c[k];
  if (resolvedRound) {
    if (resolvedRound.judged_commitment === c.text && resolvedRound.auto_overrode) {
      resolvedRound.prev_commitment_status = resolvedRound.auto_overrode.status;
      resolvedRound.prev_commitment_evidence = resolvedRound.auto_overrode.evidence;
      delete resolvedRound.auto_overrode;
    }
    for (const a of resolvedRound.auto_resolved || []) if (a.id === c.id) a.reopened = true;
    if (resolvedRound.user_resolution?.id === c.id) delete resolvedRound.user_resolution;
  }
  if (last?.user_resolution?.id === c.id) delete last.user_resolution;
  for (const k of ["resolved_round", "resolution_note", "resolved_by", "resolved_at"]) delete c[k];
  c.status = "OPEN";
  c.reopened_at = at;
  if (last && !last._open_commitments.some(o => o.id === c.id)) {
    last._open_commitments.push({ ...structuredClone(c), age_rounds: last.round - c.round });
    last._open_commitments.sort((x, y) => x.round - y.round);
  }
}

// New-project panel: draft a goal and out-of-scope lines from the response
// being captured, so the user edits instead of composing from scratch. The
// result is always shown as a draft for the user to check.
export const DRAFT_MARKER = "DRAFT A PROJECT GOAL";
export function buildDraftPrompt(title, text) {
  return `${DRAFT_MARKER} for someone tracking work they do with an AI assistant.
Draft it from the conversation excerpt below. Extract; do not invent.

- goal: 2 to 4 sentences. What "done" looks like, specific enough that you could
  tell whether a given week moved toward it. Use the conversation's own terms.
  Do not add numbers, deadlines or targets that are not in the text.
- out_of_scope: 0 to 5 short lines, each ONE thing the conversation shows was
  decided against or ruled out, or a boundary it states. Each line is checked on
  its own later, so keep each line to a single item. [] if none are stated.
- is_goal_definition: true only if the excerpt is mainly stating, defining or
  restating the goal and scope itself; false if it is doing, planning or
  reporting work toward a goal.

Return ONLY valid JSON, no prose, no code fences:
{"goal": "...", "out_of_scope": ["...", "..."], "is_goal_definition": true or false}

CONVERSATION TITLE: ${String(title || "").slice(0, 120) || "(none)"}

EXCERPT:
${cut(String(text || ""), 8000)}
`;
}

// C6 scope check, one rule at a time: each out-of-scope line is sent to the
// model on its own (a single holistic goal_alignment judgement kept missing
// explicit exclusions).
export function buildScopePrompt(goalText, rule, docText) {
  return `You are checking ONE rule for a project audit. You extract facts only.

PROJECT GOAL:
${goalText}

OUT-OF-SCOPE RULE (the owner has decided NOT to do this):
${rule}

Question: does the work in the document below do, plan, commit to, or recommend
what this rule excludes? Mentioning the excluded thing only to reject it or rule
it out is NOT a breach.

Return ONLY valid JSON, no prose, no code fences:
{"breached": true or false, "evidence": "the sentence from the document that breaches the rule, copied verbatim; empty string if not breached", "reason": "one line: how that sentence does what the rule excludes; empty string if not breached"}

DOCUMENT:
${cut(docText, 60000)}
`;
}

// Step 1 of a round: the prompt to send to the model.
// userText: the user's message just before this response (where pasted
// terminal output - the evidence that "run X" was done - usually is).
export function buildPrompt(led, goalText, docText, asOf = today(), userText = "") {
  const openC = latestOpen(led, asOf);
  const prev = led.rounds.length ? led.rounds[led.rounds.length - 1].summary : "";
  const prevCommit = openC ? `${openC.text} (from round ${openC.round})`
                           : managerPyParity ? "none - no commitment is currently open" : "none - the assistant has no open commitment";
  const prevBlock = led.rounds.length ? `Summary: ${pstr(prev)}\nOpen commitment: ${prevCommit}` : "";
  const text = cut(docText, 60000);
  const template = managerPyParity ? EXTRACT_PROMPT : withExtensionFields(EXTRACT_PROMPT, asOf);
  return formatPrompt(template, { goal: goalText, prev: prevBlock, doc: text, open_list: openListText(led),
    user_msg: cut(String(userText || ""), 8000) || "(none)" });
}

// Step 2 of a round: fold the model's extraction into the ledger (mutates led).
// meta: { doc, key, read_at, text, userText } - the captured response and the
// user's message before it, used to verify evidence quotes.
export function applyExtraction(led, data, meta) {
  const openC = latestOpen(led, dayOf(meta.read_at) || today());
  // The drop record (extension only): what the capture itself dropped
  // (meta.drops) plus what folding the extraction in drops, below.
  const drops = managerPyParity ? null : [...(meta.drops || [])];
  const modelStatus = data.prev_commitment_status;
  // The commitments this round states: manager.py's single string in parity
  // mode, else the normalised list. data.stated_commitment stays the first
  // (most important) one, so the checks and the handoff read what they did.
  const items = managerPyParity ? [{ text: get(data, "stated_commitment", ""), due: "", kind: "", parent_id: "" }]
    : collapseProcedures(statedCommitments(data, drops), meta.text,
        it => led.commitments.some(c => c.status === "OPEN" && sameCommitment(c.text, it.text)), drops);
  if (!managerPyParity) Object.assign(data, { stated_commitments: items, stated_commitment: items[0]?.text || "" });
  const rnNext = led.rounds.length + 1;

  // Resolve from content: commitments this round clearly reports as done.
  // Nothing closes without a click (v0.34.0). A "done" or a decision against
  // a commitment, from the user's message or the assistant's reply, is a
  // suggestion shown with its quote and confirmed by one click. A model
  // judgment may rank, highlight and propose; it never writes the ledger.
  // (v0.32.0 still closed on the user's own words.) Parity mode is manager.py's.
  const suggested = [];
  const userText = String(meta.userText || "");
  // A suggestion from an earlier round still unconfirmed at this capture is
  // recorded on this round, once (v0.34.0), and stays one click to confirm.
  // A decline means it was on screen (item 18): the panel records when it was
  // opened and when each suggestion was at least half visible.
  //   declined    seen, and not confirmed before this capture
  //   unseen      the panel never opened, or the suggestion never on screen
  //   unrecorded  made before views were recorded: which of the two is unknown
  if (!managerPyParity) {
    for (const c of led.commitments) {
      const sd = c.status === "OPEN" ? c.suggested_done : null;
      if (!sd || sd.declined_round != null || sd.unseen_round != null || (sd.recorded_round ?? sd.round) >= rnNext) continue;
      const what = `${c.id}: “${sd.quote}” (proposed in round ${sd.recorded_round ?? sd.round}${sd.superseded ? ", as superseded" : ""}`;
      if (sd.seen_at) {
        drops.push({ ...dropEntry("suggestion not acted on", "declined", 1, "suggestions", `${what})`), view: "seen" });
        sd.declined_round = rnNext;
      } else if (sd.views_recorded) {
        const opened = Boolean(sd.panel_opened_at);
        drops.push({ ...dropEntry("suggestion not seen", "unseen", 1, "suggestions",
          `${what}; ${opened ? "the panel was opened but the suggestion was never on screen" : "the panel was not opened"})`),
          view: opened ? "panel opened, not on screen" : "panel not opened" });
        sd.unseen_round = rnNext;
      } else {
        drops.push({ ...dropEntry("suggestion not acted on", "unrecorded", 1, "suggestions",
          `${what}; made before views were recorded, so whether it was seen is unknown)`), view: "not recorded" });
        sd.declined_round = rnNext;
      }
    }
  }
  const evidenceText = `${meta.text || ""}\n${meta.userText || ""}`;
  if (!managerPyParity) {
    const claims = Array.isArray(data.completed_commitments) ? data.completed_commitments : [];
    for (const cl of claims) {
      const id = String(cl?.id || "").trim();
      const quote = String(cl?.evidence || "").trim();
      const c = led.commitments.find(x => x.id === id && x.status === "OPEN");
      if (!c || suggested.some(a => a.id === id)) continue;
      if (!quoteInText(quote, evidenceText)) continue;       // no verifiable evidence: stays open
      const entry = { id, text: c.text, quote: clipNoting(quote, 300, drops, `evidence quote for ${id}`) };
      suggested.push(quoteInText(quote, userText) ? { ...entry, from: "user" } : { ...entry, from: "reply", in_reply: true });
    }
    const dropClaims = Array.isArray(data.dropped_commitments) ? data.dropped_commitments : [];
    for (const cl of dropClaims) {
      const id = String(cl?.id || "").trim();
      const quote = String(cl?.evidence || "").trim();
      const c = led.commitments.find(x => x.id === id && x.status === "OPEN");
      if (!c || suggested.some(a => a.id === id)) continue;
      if (!userDecision(quote, meta.userText)) continue;     // only the user's decision is proposed
      suggested.push({ id, text: c.text, quote: clipNoting(quote, 300, drops, `decision quote for ${id}`), from: "user", superseded: true });
    }
  }

  if (!SHAPES.includes(data.output_shape)) {
    drops?.push(dropEntry("output shape", "overwritten", 1, "values", `${data.output_shape === undefined ? "missing" : JSON.stringify(data.output_shape)} replaced by "OTHER"`));
    data.output_shape = "OTHER";
  }

  const rn = led.rounds.length + 1;
  Object.assign(data, { round: rn, doc: meta.doc, read_at: meta.read_at });

  // NO_PREVIOUS is only possible on round 1
  let st = data.prev_commitment_status;
  if (rn === 1) {
    data.prev_commitment_status = st = "NO_PREVIOUS";
  } else if (!openC) {
    data.prev_commitment_status = st = "NO_OPEN_COMMITMENT";
  } else if (st === "NO_PREVIOUS") {
    data.prev_commitment_status = st = "NOT_MENTIONED";
  }
  data.judged_commitment = openC ? openC.text : "";

  const restatedItem = openC ? items.find(it => it.text && it.kind !== "ABOUT" && sameCommitment(openC.text, it.text)) : null;
  const restated = Boolean(restatedItem);

  // C2's judged commitment, called executed or closed by the model: outside
  // parity mode never closed, a suggestion (from the user when its evidence
  // is in the user's message).
  if (openC) {
    if (restated) {
      // same commitment again: it cannot have been executed or replaced,
      // so keep it OPEN with its original round
      (openC.restated_rounds ??= []).push(rn);
      data.prev_commitment_status = "RESTATED";
      setDueFromRestatement(openC, restatedItem.due, rn);
    } else if ((st === "EXECUTED" || st === "CLOSED_WITH_REASON") && !managerPyParity) {
      const quote = clipNoting(get(data, "prev_commitment_evidence", ""), 300, drops, `evidence quote for ${openC.id}`);
      if (!suggested.some(a => a.id === openC.id)) {
        suggested.push({ id: openC.id, text: openC.text, quote,
          ...(quoteInText(quote, userText) ? { from: "user" } : { from: "model", in_reply: quoteInText(quote, meta.text || "") }),
          ...(st === "CLOSED_WITH_REASON" ? { closed: true } : {}) });
      }
    } else if (st === "EXECUTED") {
      // Parity mode only (outside it, EXECUTED is a suggestion, above).
      // executed wins over superseded
      Object.assign(openC, { status: "EXECUTED", resolved_round: rn,
        resolution_note: get(data, "prev_commitment_evidence", "") });
    } else if (data.supersedes_prior_commitment) {
      // manager.py closes it on the document's word. The extension leaves it
      // open: even the user's decision against it is only proposed (v0.34.0); the
      // assistant replacing a plan is a suggestion, and silence is C3's job.
      if (managerPyParity) Object.assign(openC, { status: "SUPERSEDED", resolved_round: rn,
        resolution_note: "Superseded by a later decision" });
      data.prev_commitment_status = "SUPERSEDED";
    } else if (st === "CLOSED_WITH_REASON") {
      // Parity mode only (outside it, a suggestion, above).
      Object.assign(openC, { status: "CLOSED_WITH_REASON", resolved_round: rn,
        resolution_note: get(data, "prev_commitment_evidence", "") });
    }
  }

  for (const a of suggested) {
    const c = led.commitments.find(x => x.id === a.id);
    if (c?.status === "OPEN") c.suggested_done = { round: rn, quote: a.quote, from: a.from, views_recorded: true,
      ...(a.in_reply != null ? { in_reply: a.in_reply } : {}), ...(a.closed ? { closed: true } : {}), ...(a.superseded ? { superseded: true } : {}) };
  }
  if (suggested.length) data.suggested_resolutions = suggested;

  const confirmations = [];
  // Each stated commitment in turn. Sub-steps and semantic duplicates attach
  // to the existing commitment instead of creating a peer (one blocked task
  // must not become seven); confirmations are never commitments.
  for (const it of items) {
    const newText = it.text;
    if (!newText || it === restatedItem) continue;
    const kind = it.kind;
    if (!managerPyParity && (kind === "CONFIRMATION" || isConfirmation(newText))) {
      data.commitment_skipped ??= { reason: "confirmation", text: newText };
      confirmations.push(newText);
      continue;
    }
    // An instruction or decision about an existing commitment ("close C-042",
    // "change its date") is neither a restatement of it nor a new task.
    if (!managerPyParity && kind === "ABOUT") {
      (data.about_commitments ??= []).push({ parent_id: String(it.parent_id || ""), text: newText });
      continue;
    }
    const parent = managerPyParity ? null : led.commitments.find(c => c.id === it.parent_id && c.status === "OPEN");
    if (parent && (kind === "SUBSTEP" || kind === "SAME")) {
      if (kind === "SAME") {
        (parent.restated_rounds ??= []).push(rn);
        if (parent === openC) data.prev_commitment_status = "RESTATED";
        setDueFromRestatement(parent, it.due, rn);
      } else {
        (parent.substeps ??= []).push({ text: newText, round: rn });
        if (parent === openC && !["EXECUTED", "CLOSED_WITH_REASON", "SUPERSEDED", "RESTATED"].includes(data.prev_commitment_status)) {
          data.prev_commitment_status = "IN_PROGRESS";
        }
      }
      // C2 reads the attachment to the commitment it judges, if there is one.
      if (!data.commitment_attached || parent === openC) {
        data.commitment_attached = { kind, parent_id: parent.id, parent_text: parent.text, text: newText };
      }
      continue;
    }
    // Matching a restatement is separate from choosing what C2 judges: an open
    // commitment C2 skips (scheduled, or not the assistant's) is still the
    // same commitment when restated, never a new twin. Same comparison as the
    // judged-commitment path above.
    const same = managerPyParity ? null : led.commitments.find(x => x.status === "OPEN" && x.round < rn && sameCommitment(x.text, newText));
    if (same) {
      (same.restated_rounds ??= []).push(rn);
      setDueFromRestatement(same, it.due, rn);
      continue;
    }
    const c = {
      id: `C-${String(led.commitments.length + 1).padStart(3, "0")}`,
      round: rn, text: newText, status: "OPEN" };
    if (!managerPyParity) c.rank = items.indexOf(it);   // 0 = listed first; C2 judges in this order within a round
    if (!managerPyParity) Object.assign(c, actorOf(it, meta.text, drops, c.id));
    if (it.due) c.due_date = it.due;
    led.commitments.push(c);
  }

  // Offers the user's message accepts become commitments, from this round.
  if (!managerPyParity) {
    for (const a of Array.isArray(data.accepted_offers) ? data.accepted_offers : []) {
      const c = led.commitments.find(x => x.id === String(a?.id || "").trim() && x.status === "OPEN" && x.modality === "offered");
      const quote = String(a?.evidence || "").trim();
      if (!c || !userAccepts(quote, meta.userText)) continue;
      Object.assign(c, { modality: "committed", accepted: { round: rn, quote: clipNoting(quote, 300, drops, `acceptance quote for ${c.id}`) } });
      (data.accepted ??= []).push({ id: c.id, quote: c.accepted.quote });
    }
  }

  if (drops) {
    if (confirmations.length) drops.push(dropEntry("stated commitments: confirmations, not commitments", "skipped", confirmations.length, "items", confirmations.join("; ")));
    if (modelStatus !== undefined && data.prev_commitment_status !== modelStatus) {
      drops.push(dropEntry("previous-commitment status", "overwritten", 1, "values", `${JSON.stringify(modelStatus)} replaced by ${JSON.stringify(data.prev_commitment_status)}`));
    }
    data.drops = drops.map(d => ({ ...d, round: rn }));
  }

  data._open_commitments = rebuildOpen(led, rn);
  led.rounds.push(data);
  led.seen[meta.key] = meta.doc;
  return data;
}

// The report shown in the popup, recomputed from the ledger and current goal.
// Each check's own version: bump only the check whose logic or thresholds
// change, so one check's change never splits another's history. Each round
// records the verdict it was given at capture with these, and is never
// re-judged. (C5 runs in parity mode only, so it has no version here.)
export const CHECK_VERSIONS = Object.freeze({
  C1: 1, C3: 1, C4: 1,
  C2: 5,   // 2: the assistant's commitments only, no fallback (v0.23.0); 3: committed only, not in the verdict (v0.25.0);
           // 4: reads the ledger: never PASS on a commitment still open (v0.33.0);
           // 5: nothing closes without a click, so the user's own words warn too (v0.34.0)
  C6: 3,   // 2: conditional out-of-scope items warn, never fail (v0.17.1); 3: not in the verdict, with the model's reason (v0.26.0)
  C7: 2,   // 2: counts by actor, does not fire until refitted (v0.22.0)
});
// Records stored before v0.18.2 carry one global rule-set number instead:
// what each check's version was under it.
const LEGACY_RULE_SETS = Object.freeze({
  1: { C1: 1, C2: 1, C3: 1, C4: 1, C5: 1, C6: 1, C7: 1 },
  2: { C1: 1, C2: 1, C3: 1, C4: 1, C5: 1, C6: 2, C7: 1 },   // C6 changed
  3: { C1: 1, C2: 1, C3: 1, C4: 1, C6: 2, C7: 1 },          // C5 retired
});
// The version of check `id` a recorded verdict was judged under, or null.
export function checkVersion(record, id) {
  const own = record?.checks?.find(c => c.id === id)?.version;
  if (Number.isInteger(own)) return own;
  return LEGACY_RULE_SETS[record?.rules]?.[id] ?? null;
}
export function verdictRecord(rep) {
  return {
    verdict: rep.verdict,
    checks: rep.checks.map(c => ({ id: c.id, name: c.name, status: c.status, evidence: c.evidence,
      version: CHECK_VERSIONS[c.id] ?? null, ...(c.state ? { state: c.state } : {}), ...(c.advisory ? { advisory: true } : {}),
      ...(c.reason != null ? { reason: c.reason } : {}) })),
  };
}

export function report(led, goalText, opts = {}) {
  if (!led.rounds.length) return null;
  const checks = runChecks(led.rounds, opts);
  const cur = led.rounds[led.rounds.length - 1];
  const v = verdict(checks, cur);
  return {
    verdict: v,
    round: cur,
    checks,
    items: led.rounds.reduce((s, r) => s + get(r, "items_considered", 0), 0),
    artefacts: led.rounds.reduce((s, r) => s + get(r, "artefacts_produced", 0), 0),
    open: actionableOpen(led.rounds, cur),
    scheduled: managerPyParity ? [] : scheduledOpen(cur),
    phase: isWaiting(opts) ? "WAITING" : "ACTIVE",
    // A commitment closed since (e.g. by hand, later) is never named by any
    // handoff, including when viewing an earlier round.
    handoff: handoff(v, checks, led.rounds, goalText, managerPyParity ? actionableOpen(led.rounds, cur)
      : actionableOpen(led.rounds, cur).filter(c => led.commitments.find(x => x.id === c.id)?.status === "OPEN")),
    // What building the handoff cut (extension): recorded with the round at capture.
    handoffDrops: managerPyParity || v === "PROGRESS" ? [] : handoffGoal(goalText).drops,
  };
}
