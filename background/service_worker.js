// Background service worker: owns all project data (single writer) and the
// only network call (api.openai.com). The API key is read from
// chrome.storage.local per request and is never logged, echoed in errors,
// exported, or sent anywhere else.

import { applyRepairs } from "../lib/repairs.js";
import { projectEditEvents } from "../lib/core.js";
import { buildPrompt, applyExtraction, emptyLedger, report, DEFAULT_MODEL, normalizeDue, CALL_FAILURES, callFailureMessage, USER_READ_TEXT, USER_READ_UNKNOWN, USER_PARTIAL_TEXT,
         buildScopePrompt, buildDraftPrompt, quoteInText, clip,
         buildReviewPrompt, roundMaterial, applyReview, REVIEW_VERSION, usableUserText, verdictRecord, scopeCheckEntries, reopenInLedger, ledgerEvents, undoEvents, fitEvents, staleQuestions,
         captureTexts, reviewMaterial, dropEntry, clipNoting, EXCERPT_CHARS } from "../lib/core.js";
import { K, SCHEMA_VERSION, stripSeverityTokens, composeGoal, threadKey, loadProjects, loadLedger, byRecency, reportOptsFor,
         outOfScopeLines, definitionWarnings } from "../lib/store.js";
import { setupMatch } from "../lib/setup.js";
import { viewModel } from "../lib/report_model.js";
import { SHADOW_KEY, buildShadowPrompt, shadowDecision } from "../lib/shadow.js";
import { SHADOW_ASSIGN } from "../lib/build_flags.js";

const SETUP = "SETUP";   // ledger.seen marker for a capture recorded as setup

const VERDICT_BADGE = {
  PROGRESS: { text: "OK", color: "#1f8a4c" },
  AT_RISK: { text: "RISK", color: "#c27c0e" },
  LOOP: { text: "LOOP", color: "#c0392b" },
  DEVIATION: { text: "DEV", color: "#7d3c98" },
};

const MENU_ID = "pm-capture-selection";
const TEST_MENU_ID = "pm-test-error";
const CHAT_URLS = ["https://chatgpt.com/*", "https://claude.ai/*"];
const EXPORT_FORMAT = "project-manager";

class UserError extends Error {}

const local = chrome.storage.local;
const now = () => new Date().toISOString();

// ------------------------------------------------------------ debug log
// Debug mode (Options > Debug) logs every step to this service worker's
// console and to a copyable log in Options. Key-shaped strings are masked.

let debugOn = false;
const debugReady = local.get("debug").then(s => { debugOn = Boolean(s.debug); }).catch(() => {});
let logChain = Promise.resolve();

function mask(d) {
  let t;
  try { t = typeof d === "string" ? d : JSON.stringify(d); } catch { t = String(d); }
  return String(t).replace(/sk-[A-Za-z0-9_\-*]{4,}/g, "sk-…").slice(0, 600);
}

function dlog(step, detail) {
  debugReady.then(() => {
    if (!debugOn) return;
    const line = `${now().slice(11, 23)} ${step}${detail === undefined ? "" : " " + mask(detail)}`;
    console.log("[PM]", line);
    logChain = logChain.then(async () => {
      const { debugLog = [] } = await local.get("debugLog");
      debugLog.push(line);
      await local.set({ debugLog: debugLog.slice(-400) });
    }).catch(() => {});
  });
}

self.addEventListener("unhandledrejection", e => {
  console.error("[PM] unhandled rejection:", e.reason?.message || e.reason);
  dlog("ERROR unhandled rejection", String(e.reason?.message || e.reason));
});
self.addEventListener("error", e => {
  console.error("[PM] error:", e.message);
  dlog("ERROR", e.message);
});

// Every write goes through this queue so captures, edits and imports can't
// interleave read-modify-write cycles.
let queue = Promise.resolve();
function serialised(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------ migration

async function migrate() {
  const s = await local.get(["schemaVersion", "projectIds", "ledger", "goal", "ledgerBeforeLast"]);
  if (s.schemaVersion === SCHEMA_VERSION) return;

  // v0.1 stored a single { ledger, goal, ledgerBeforeLast }: fold it into a
  // project so nothing captured so far is lost.
  if (!s.projectIds?.length && (s.ledger?.rounds?.length || s.goal?.trim())) {
    const id = crypto.randomUUID();
    const set = {
      [K.project(id)]: { id, name: "My project", goal: s.goal || "", outOfScope: "", createdAt: now() },
      [K.ledger(id)]: s.ledger || emptyLedger(),
      projectIds: [id],
      threadProjects: {},
    };
    if (s.ledgerBeforeLast) set[K.undo(id)] = s.ledgerBeforeLast;
    await local.set(set);
  }

  // v0.2 created an empty "My project" on fresh install. Projects now start
  // at first capture, so drop that placeholder if it was never used.
  if (s.schemaVersion === 2 && s.projectIds?.length) {
    const recs = await local.get(s.projectIds.flatMap(id => [K.project(id), K.ledger(id)]));
    const unused = s.projectIds.filter(id => {
      const p = recs[K.project(id)];
      return p && p.name === "My project" && !p.goal?.trim() && !recs[K.ledger(id)]?.rounds?.length;
    });
    if (unused.length) {
      await local.remove(unused.flatMap(id => [K.project(id), K.ledger(id), K.undo(id), K.events(id)]));
      await local.set({ projectIds: s.projectIds.filter(id => !unused.includes(id)) });
    }
  }

  await local.remove(["ledger", "goal", "ledgerBeforeLast", "activeProjectId"]);
  await local.set({ schemaVersion: SCHEMA_VERSION });
}

// One-time repairs of stored project definitions (lib/repairs.js): each runs
// once, only on the exact text it was written against, and leaves a record.
async function runRepairs() {
  const s = await local.get(["projectIds", "repairs"]);
  const done = s.repairs || {};
  const ids = s.projectIds || [];
  if (!ids.length) return;
  const recs = await local.get(ids.map(K.project));
  const projects = ids.map(id => recs[K.project(id)]).filter(Boolean);
  const results = applyRepairs(projects, done);
  if (!results.length) return;
  const at = now();
  for (const r of results) {
    done[r.id] = { at, outcome: r.outcome };
    dlog(`repair ${r.id}: ${r.outcome}`, { project: r.project, field: r.field });
    if (r.outcome !== "restored") continue;
    const p = projects.find(x => x.id === r.project);
    await local.set({ [K.project(p.id)]: p });
    // Each repair's own old and new text: several can run on one start.
    await recordEvents(p.id, projectEditEvents({ ...p, [r.field]: r.from }, { ...p, [r.field]: r.to }, { at, by: "repair", via: r.id }).map(e => ({ ...e, repair: r.id })));
  }
  await local.set({ repairs: done });
}

let readyPromise = null;
function ensureReady() {
  return (readyPromise ??= serialised(migrate).then(() => serialised(runRepairs)).catch(e => { readyPromise = null; throw e; }));
}

// ------------------------------------------------------------ helpers

async function getProject(id) {
  const key = K.project(id);
  const s = await local.get(key);
  return s[key] || null;
}

async function requireProject(id) {
  const p = id && await getProject(id);
  if (!p) throw new UserError("That project no longer exists. Pick another one.");
  return p;
}

async function getThreadProjects() {
  return (await local.get("threadProjects")).threadProjects || {};
}

// What the capture UI needs for this URL: the projects (most recent first)
// and which one, if any, the conversation is filed under.
async function captureContext(url) {
  const { projects, lastProjectId } = await loadProjects();
  const key = threadKey(url);
  const mapped = key ? (await getThreadProjects())[key] : null;
  const filed = Boolean(mapped && projects.some(p => p.id === mapped));
  const rounds = {};
  for (const p of projects) rounds[p.id] = (await loadLedger(p.id)).rounds.length;
  return {
    projects: byRecency(projects).map(p => ({ id: p.id, name: p.name, rounds: rounds[p.id], phase: p.phase === "WAITING" ? "WAITING" : "ACTIVE" })),
    projectId: filed ? mapped : null,
    lastProjectId,
    filed,
    isThread: Boolean(key),
    hasApiKey: Boolean(await getApiKey()),
    debug: debugOn,
    // Asking about stale commitments before a capture is opt-in (Options).
    askStale: Boolean((await local.get("askStaleAtCapture")).askStaleAtCapture),
  };
}

// Tell content scripts to refresh their project labels. No "tabs" permission
// needed: we only use tab ids, and tabs without our script just reject.
async function notifyTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: "projectsChanged" }).catch(() => {});
}

async function refreshBadge() {
  const { projects, lastProjectId } = await loadProjects();
  const p = projects.find(x => x.id === lastProjectId);
  if (!p) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Project Manager" });
    return;
  }
  const r = report(await loadLedger(p.id), composeGoal(p), await reportOptsFor(p));
  if (!r) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: `Project Manager - ${p.name}: no rounds yet` });
    return;
  }
  const b = VERDICT_BADGE[r.verdict];
  await chrome.action.setBadgeBackgroundColor({ color: b.color });
  await chrome.action.setBadgeText({ text: b.text });
  await chrome.action.setTitle({ title: `Project Manager - ${p.name}: ${r.verdict}` });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

function normaliseText(text) {
  return (text || "").replace(/\r\n/g, "\n").trim();
}

function cleanName(name) {
  const n = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!n) throw new UserError("Project name can't be empty.");
  return n;
}

function cleanGoal(goal) {
  const g = String(goal || "").trim();
  if (!g) throw new UserError("Describe the goal - what done looks like.");
  return g;
}

// ------------------------------------------------------------ OpenAI

async function getApiKey() {
  return ((await local.get("apiKey")).apiKey || "").trim();
}

// opts.maxTokens caps the answer; opts.timeoutMs aborts a slow call.
async function callLLM(prompt, model, apiKey, opts = {}) {
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        response_format: { type: "json_object" },
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new UserError(CALL_FAILURES.slow);
    throw new UserError(CALL_FAILURES.unreachable);
  }
  if (!res.ok) {
    let error = null;
    try { error = (await res.json()).error; } catch {}
    throw new UserError(callFailureMessage(res.status, error));
  }
  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new UserError("The model did not return valid JSON. Try capturing again.");
  }
}

// Python's sum() would crash on a non-numeric count; coerce instead so a
// sloppy extraction can't turn the C5 totals into string concatenation.
function coerceCounts(data) {
  for (const k of ["items_considered", "artefacts_produced"]) {
    if (k in data && typeof data[k] !== "number") {
      const n = parseInt(data[k], 10);
      data[k] = Number.isFinite(n) ? n : 0;
    }
  }
  if (!Array.isArray(data.completed_commitments)) data.completed_commitments = [];
  if (!Array.isArray(data.dropped_commitments)) data.dropped_commitments = [];
  if (!data.commitment_relation || typeof data.commitment_relation !== "object") data.commitment_relation = { kind: "NEW", parent_id: "" };
  return data;
}

// ------------------------------------------------------------ projects

async function addProject({ name, goal, outOfScope }) {
  const id = crypto.randomUUID();
  const { projectIds = [] } = await local.get("projectIds");
  const p = { id, name: cleanName(name), goal: cleanGoal(goal),
              outOfScope: stripSeverityTokens(String(outOfScope || "").trim()).text.trim(), createdAt: now() };
  await local.set({ [K.project(id)]: p, [K.ledger(id)]: emptyLedger(), projectIds: [...projectIds, id] });
  // The starting definition, so every later edit has something to compare with.
  await recordEvents(id, projectEditEvents(null, { ...p, phase: "ACTIVE" }, { at: p.createdAt, by: "user", via: "created" }));
  return p;
}

// File a conversation under a project. Returns false when the URL has no
// conversation id yet (the content script then keeps the choice for the page).
async function fileThread(url, projectId) {
  const tk = threadKey(url);
  if (!tk) return false;
  const tp = await getThreadProjects();
  if (tp[tk] !== projectId) {
    tp[tk] = projectId;
    await local.set({ threadProjects: tp });
    notifyTabs();
    await noteShadowRefile(tk, projectId);
  }
  return true;
}

// ------------------------------------------------------------ event record
// Append events to a project's record (always called inside the write queue).
// At the cap (all projects together), fitEvents compacts old verdict
// evidence; if that isn't enough nothing is appended and eventsFull is set,
// which Options shows.
async function recordEvents(projectId, events) {
  if (!events.length) return;
  const { projectIds = [] } = await local.get("projectIds");
  const ids = [...new Set([...projectIds, projectId])];
  const got = await local.get([...ids.map(K.events), "eventsFull"]);
  const stored = Object.fromEntries(ids.map(id => [id, got[K.events(id)] || []]));
  const fit = fitEvents(stored, events, projectId);
  if (fit.full) {
    if (!got.eventsFull) await local.set({ eventsFull: now() });
    dlog("events: record full - not recorded", { project: projectId, events: events.length });
    return { full: true, events: events.length };
  }
  const set = {};
  for (const id of ids) if (id === projectId || fit.compacted) set[K.events(id)] = fit.byProject[id] || [];
  await local.set(set);
  if (fit.compacted) dlog("events: compacted old verdict evidence", { count: fit.compacted });
}

// ------------------------------------------------------------ shadow assignment
// Predicts a new conversation's project and records it beside the user's own
// choice, for the tally in Options. It acts on nothing: it reads projects and
// writes only its own records (SHADOW_KEY) - never threadProjects, never a
// ledger. At most one small call per conversation.

const shadowClaimed = new Set();   // claimed in this worker's lifetime, before the record is saved

// The projects before this capture, if it is the conversation's first one.
async function shadowSnapshot(url) {
  const tk = threadKey(url);
  if (!tk || shadowClaimed.has(tk)) return null;
  if (((await local.get(SHADOW_KEY))[SHADOW_KEY] || {})[tk]) return null;
  const filed = (await getThreadProjects())[tk];
  if (filed) {
    const l = await loadLedger(filed);
    if (l.rounds.some(r => threadKey(r.source_url) === tk) || (l.setup || []).some(x => threadKey(x.source_url) === tk)) return null;
  }
  const { projects } = await loadProjects();
  return { tk, candidates: projects.map(p => ({ id: p.id, name: p.name, goal: p.goal || "", outOfScope: p.outOfScope || "" })) };
}

// Refilings made before the prediction is saved (it runs alongside the capture).
const shadowPendingRefiles = new Map();

function saveShadow(tk, rec) {
  return serialised(async () => {
    const all = (await local.get(SHADOW_KEY))[SHADOW_KEY] || {};
    const refiles = [...(all[tk]?.refiles || []), ...(shadowPendingRefiles.get(tk) || [])];
    shadowPendingRefiles.delete(tk);
    all[tk] = refiles.length ? { ...rec, refiles } : rec;
    await local.set({ [SHADOW_KEY]: all });
  });
}

// A conversation moved to another project after the first choice: kept with
// its time, so the tally can also be judged against the latest filing. Called
// from fileThread, which always runs inside the write queue.
async function noteShadowRefile(tk, projectId) {
  const all = (await local.get(SHADOW_KEY))[SHADOW_KEY] || {};
  const p = (await local.get(K.project(projectId)))[K.project(projectId)];
  const move = { projectId, name: p?.name || "", at: now() };
  if (all[tk]) {
    const latest = all[tk].refiles?.at(-1)?.projectId ?? all[tk].chosen?.projectId;
    if (latest === projectId) return;
    all[tk] = { ...all[tk], refiles: [...(all[tk].refiles || []), move] };
    await local.set({ [SHADOW_KEY]: all });
    dlog("shadow: refiled", { conversation: tk, to: move.name });
  } else if (shadowClaimed.has(tk)) {
    shadowPendingRefiles.set(tk, [...(shadowPendingRefiles.get(tk) || []), move]);
  }
}

async function shadowPredict(snap, convo, chosen, apiKey) {
  // Claimed only now, after the first filing, so that filing isn't taken for a refile.
  shadowClaimed.add(snap.tk);
  const rec = { at: now(), url: convo.url || "", title: clip(String(convo.title || ""), 120),
    candidates: snap.candidates.map(c => ({ id: c.id, name: c.name })), chosen };
  try {
    if (snap.candidates.length) {
      const model = (await local.get("model")).model || DEFAULT_MODEL;
      const out = await callLLM(buildShadowPrompt(snap.candidates, convo), model, apiKey, { maxTokens: 300, timeoutMs: 20000 });
      rec.prediction = shadowDecision(out, snap.candidates, convo);
    } else {
      rec.prediction = shadowDecision({}, [], convo);   // nothing to choose from: abstain, no call
    }
  } catch (e) {
    rec.error = String(e?.message || e);
  }
  dlog("shadow: prediction", { conversation: snap.tk, chosen: chosen.name, prediction: rec.prediction || rec.error });
  await saveShadow(snap.tk, rec);
}

// ------------------------------------------------------------ ledger review

// Old rounds never kept their response text. Responses already captured in
// this conversation are still on the page: match them to their rounds by
// hash and keep an excerpt, so the review can quote the original.
// history: [{ text, user }] (or plain strings from older content scripts).
// drops: the drop record of the round this runs in.
const BACKFILL_REPLIES = 40;
async function backfillExcerpts(ledger, history, drops) {
  let n = 0;
  const all = Array.isArray(history) ? history : [];
  if (all.length > BACKFILL_REPLIES) {
    drops?.push(dropEntry("captured replies on the page, not read to recover stored text (last 40 only)", "capped", all.length - BACKFILL_REPLIES, "replies"));
  }
  for (const h of all.slice(-BACKFILL_REPLIES)) {
    const text = normaliseText(typeof h === "string" ? h : h?.text);
    const user = typeof h === "string" ? "" : normaliseText(h?.user);
    if (!text) continue;
    const doc = ledger.seen[await sha256(text)];
    if (!doc || doc === SETUP) continue;
    const r = ledger.rounds.find(x => x.doc === doc);
    if (!r) continue;
    if (!r.text_excerpt) { r.text_excerpt = clipNoting(text, EXCERPT_CHARS, drops, `stored text of round ${r.round} (recovered from the page)`); n++; }
    if (usableUserText(user) && !usableUserText(r.user_excerpt)) {
      r.user_excerpt = clipNoting(user, EXCERPT_CHARS, drops, `your message in round ${r.round} (recovered from the page)`); n++;
    }
  }
  if (n) dlog("review: original text recovered for old rounds", n);
  return n;
}

// One call judging every open commitment against the rounds after it was
// raised. Returns the verified changes (already applied to ledger).
// run: { round } - the round being captured, or the latest for a manual Re-check.
async function runReview(project, ledger, apiKey, model, run, drops) {
  const latest = ledger.rounds[ledger.rounds.length - 1]?.round ?? 0;
  const open = ledger.commitments.filter(c => c.status === "OPEN" && c.round < latest);
  if (!open.length) return [];
  const from = Math.min(...open.map(c => c.round));
  // Keep the prompt bounded: most recent rounds first if it's long. What
  // that cuts or leaves out goes in the drop record.
  const { material, drops: cut } = reviewMaterial(ledger.rounds, from);
  drops?.push(...cut);
  dlog("review: judging open commitments", { project: project.name, open: open.map(c => c.id), rounds: material.length,
    withText: material.filter(m => m.kind === "response").length });
  const data = await callLLM(buildReviewPrompt(composeGoal(project), open, material), model, apiKey, { maxTokens: 1200, timeoutMs: 30000 });
  const changed = applyReview(ledger, data.results, material, { at: now(), round: run.round });
  dlog("review: applied", changed);
  return changed;
}

// "Re-check against past responses" (popup / panel).
async function reviewCommitments({ projectId, history }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new UserError(CALL_FAILURES.noKey);
  const p = await requireProject(projectId);
  const ledger = await loadLedger(p.id);
  const before = JSON.parse(JSON.stringify(ledger));
  const drops = [];
  await backfillExcerpts(ledger, history, drops);
  const model = (await local.get("model")).model || DEFAULT_MODEL;
  const changed = await runReview(p, ledger, apiKey, model, { round: ledger.rounds.at(-1)?.round ?? 0 }, drops);
  ledger.review_version = REVIEW_VERSION;
  // A Re-check runs after the latest round: what it drops is recorded there.
  const last = ledger.rounds.at(-1);
  if (last && drops.length) (last.drops ??= []).push(...drops.map(d => ({ ...d, round: last.round, during: "Re-check" })));
  await local.set({ [K.ledger(p.id)]: ledger, ...(changed.length ? { [K.undo(p.id)]: before } : {}) });
  await recordEvents(p.id, ledgerEvents(before, ledger, { at: now(), project: p.id }));
  await refreshBadge();
  const stillOpen = ledger.commitments.filter(c => c.status === "OPEN").length;
  return { changed, stillOpen };
}

// ------------------------------------------------------------ capture

// msg: { text, site, url, title } plus either
//   projectId                         - an existing project (filed or just chosen), or
//   newProject: {name, goal, outOfScope} - create it just in time, then capture.
// Item 23: the page's shape at capture, whatever then happens to the capture
// (a duplicate, setup, no key, a failed call). Its own key, not the debug log:
// page scans fill that log's 400 lines within the hour, and on 4 Nov it held no
// capture at all. Holds lengths and shapes, no text (see probeUserRows).
const USER_PROBES_KEPT = 30, USER_PROBE_BYTES = 20000;
// The same identity as the page script's messageId.
async function messageId(t) {
  const x = String(t || "").replace(/\s+/g, "").slice(0, 200);
  return x ? (await sha256(x)).slice(0, 12) : "";
}
// Each reply on the page that is already a round: did that round store the
// message that is actually before it? Reaches back to rounds captured before
// this probe existed, as long as they are on the page.
async function storedMessageChecks(pairs, projectId) {
  if (!pairs?.length || !projectId) return [];
  const led = await loadLedger(projectId);
  const byReply = new Map();
  for (const r of led.rounds) if (r.text_excerpt) byReply.set(await messageId(r.text_excerpt), r);
  const out = [];
  for (const p of pairs) {
    const r = byReply.get(p.reply);
    if (!r) continue;
    const stored = await messageId(r.user_excerpt);
    out.push({ round: r.round, stored, rowId: p.rowId ?? null, readerId: p.readerId ?? null,
      verdict: p.noDirectMessage ? (stored ? "DIFFERENT" : "nothing stored") : p.rowMissing ? "row not on page" : !stored ? "nothing stored"
        : stored === p.readerId || stored === p.rowId ? "same" : "DIFFERENT" });
  }
  return out;
}
async function recordUserProbe(msg) {
  if (!msg.userProbe) return;
  const { pairs, ...rest } = msg.userProbe;
  let probe = { ...rest, roundChecks: await storedMessageChecks(pairs, msg.projectId) };
  if (JSON.stringify(probe).length > USER_PROBE_BYTES) {
    // Too big: keep the rows that matter, without their detail if need be.
    probe = { ...probe, rows: (probe.rows || []).filter(r => r.odd || r.target).slice(-12), trimmed: true };
    if (JSON.stringify(probe).length > USER_PROBE_BYTES) probe = { ...probe, rows: probe.rows.map(({ skeleton, ...r }) => r) };
  }
  const { userProbes = [] } = await local.get("userProbes");
  userProbes.push({ at: now(), site: msg.site || "", ...probe });
  await local.set({ userProbes: userProbes.slice(-USER_PROBES_KEPT) });
}

async function capture(msg) {
  dlog("capture: start", { url: msg.url, chars: msg.text?.length, userChars: msg.userText?.length, projectId: msg.projectId, newProject: msg.newProject?.name });
  await recordUserProbe(msg).catch(e => dlog("capture: probe not recorded", String(e?.message || e)));
  const text = normaliseText(msg.text);
  // The user's message before this response: pasted terminal output is the
  // evidence that "run X in your terminal" was done.
  // Anything that isn't plausibly typed text is a failed capture: treat it as
  // no message, and flag the round below.
  // What is sent to the model and kept is cut to size; each cut is recorded.
  const texts = captureTexts(text, normaliseText(msg.userText));
  const rawUser = texts.user;
  const userText = usableUserText(rawUser) ? rawUser : "";
  // An unusable message (only icon glyphs) is not used at all, so its cuts aren't drops.
  const capDrops = texts.drops.filter(d => userText || !d.where.startsWith("your message"));
  // What could not be read, and why, as the page script found it.
  const readWhy = USER_READ_TEXT[msg.userRead?.reason] ? msg.userRead.reason : null;
  const partial = Boolean(userText && readWhy && USER_PARTIAL_TEXT[readWhy]);
  if (readWhy && !userText) capDrops.push(dropEntry(readWhy === "row-missing" ? "your message: not on the page" : `your message: ${readWhy === "pasted" ? "a pasted attachment" : "an attachment"}, not readable`, "skipped", 1, "messages"));
  if (partial) capDrops.push(dropEntry(`your message: ${readWhy === "pasted" ? "a pasted attachment" : "an attachment"} beside the typed text, not readable`, "skipped", 1, "messages"));
  if (rawUser && !userText) dlog("capture: user message unusable", { chars: rawUser.length, codes: Array.from(rawUser).slice(0, 4).map(c => c.codePointAt(0).toString(16)) });
  if (!text) throw new UserError("Nothing to capture - the response is empty.");
  const apiKey = await getApiKey();
  if (!apiKey) throw new UserError(CALL_FAILURES.noKey);

  // Shadow assignment: if this is the conversation's first capture, note the
  // projects as they stand before it (see shadowPredict).
  const shadow = SHADOW_ASSIGN ? await shadowSnapshot(msg.url) : null;

  let project, created = false;
  if (msg.newProject) {
    project = await addProject(msg.newProject);
    created = true;
  } else {
    project = await requireProject(msg.projectId);
  }
  if (!project.goal?.trim()) throw new UserError(`Project "${project.name}" has no goal. Set it in Options.`);

  // File the conversation before the model call, so a failed extraction
  // doesn't make the user answer "which project?" again on retry.
  const remembered = await fileThread(msg.url, project.id);
  if (created) notifyTabs();
  dlog("capture: project", { name: project.name, created, remembered });
  // Not awaited: it runs after this capture and can't delay or change it.
  if (shadow) shadowPredict(shadow, { url: msg.url, title: msg.title, user: userText, reply: text },
    { projectId: project.id, name: project.name, isNew: created }, apiKey);

  // Each project has its own ledger: rounds are never compared across projects.
  const goalText = composeGoal(project);
  const ledger = await loadLedger(project.id);
  const atStart = JSON.parse(JSON.stringify(ledger));   // for the event record (the review may close things first)
  const key = await sha256(text);
  const base = { projectId: project.id, projectName: project.name, remembered, created };

  // Setup is not work. A response that is substantially the goal the user just
  // entered (the assistant restating it) is recorded as SETUP: no extraction,
  // no round, no checks. msg.force ("Count it as a round") overrides this.
  if (ledger.seen[key] === SETUP && !msg.force) {
    return { ...base, status: "setup", duplicate: true };
  }
  if (ledger.seen[key] === SETUP && msg.force) {
    delete ledger.seen[key];
    ledger.setup = (ledger.setup || []).filter(x => x.key !== key);
    dlog("capture: setup overridden - counting as a round");
  } else if (!msg.force && !ledger.seen[key]) {
    // If the new project's goal was drafted from this very response, word
    // overlap is guaranteed and means nothing; the draft call's own judgement
    // ("is this response a goal definition?") decides instead.
    const d = msg.newProject?.draft;
    const m = d?.fromResponse
      ? { isSetup: d.isGoalDefinition === true, source: "draft" }
      : setupMatch(text, project);
    dlog("capture: setup check", m);
    if (m.isSetup) {
      const before = JSON.parse(JSON.stringify(ledger));
      ledger.setup = [...(ledger.setup || []), { key, at: now(), chars: text.length, source_url: msg.url || "", match: m }];
      ledger.seen[key] = SETUP;
      await local.set({
        [K.ledger(project.id)]: ledger,
        [K.undo(project.id)]: before,
        [K.project(project.id)]: { ...project, lastUsedAt: now() },
        lastProjectId: project.id,
        lastError: null,
      });
      dlog("capture: recorded as setup", { project: project.name });
      return { ...base, status: "setup", match: m };
    }
  }

  if (ledger.seen[key]) {
    const r = report(ledger, goalText, await reportOptsFor(project));
    const round = ledger.rounds.find(x => x.doc === ledger.seen[key]);
    return { ...base, status: "duplicate", round: round?.round, verdict: r?.verdict };
  }

  const model = (await local.get("model")).model || DEFAULT_MODEL;
  // Catch-up review, once per project: judge every open commitment against
  // the rounds since it was raised, before this capture's extraction (so the
  // extraction sees an up-to-date list). A failed review never blocks.
  await backfillExcerpts(ledger, msg.history, capDrops);
  let reviewed = [];
  if ((ledger.review_version ?? 0) < REVIEW_VERSION) {
    try {
      reviewed = await runReview(project, ledger, apiKey, model, { round: (ledger.rounds.at(-1)?.round ?? 0) + 1 }, capDrops);
      ledger.review_version = REVIEW_VERSION;
    } catch (e) {
      capDrops.push(dropEntry("catch-up review (will retry next capture)", "not run", 1, "reviews", e.message));
      dlog("review: failed, will retry next capture", e.message);
    }
  }

  // Main extraction, plus one scope call per out-of-scope rule, in parallel.
  const scopeLines = outOfScopeLines(project);
  dlog("capture: calling OpenAI", { model, round: ledger.rounds.length + 1, scopeRules: scopeLines.length });
  const [main, ...scope] = await Promise.all([
    callLLM(buildPrompt(ledger, goalText, text, undefined, userText), model, apiKey),
    ...scopeLines.map(line => callLLM(buildScopePrompt(goalText, line, text), model, apiKey)
      .catch(e => ({ error: String(e?.message || e) }))),   // a failed rule check never blocks the capture
  ]);
  const data = coerceCounts(main);
  // Each item's HARD/CONDITIONAL classification is stored with it, so the
  // round shows which C6 branch ran.
  data.scope_checks = scopeCheckEntries(scopeLines, scope, text, capDrops);
  dlog("capture: OpenAI ok", { shape: data.output_shape, relation: data.commitment_relation,
    scopeBreaches: data.scope_checks.filter(x => x.breached).map(x => x.line) });

  // The project may have been deleted while the model was thinking.
  const fresh = await getProject(project.id);
  if (!fresh) throw new UserError(`Project "${project.name}" was deleted during capture.`);

  // Snapshot for one-level undo, taken only once the model call succeeded.
  const before = JSON.parse(JSON.stringify(ledger));
  const n = ledger.rounds.length + 1;
  const doc = `${msg.site || "page"} #${n}${msg.title ? ` - ${msg.title}` : ""}`.slice(0, 140);
  const round = applyExtraction(ledger, data, { doc, key, read_at: now(), text, userText, drops: capDrops });
  round.text_excerpt = texts.excerpt;   // kept so later reviews can quote it
  if (userText) round.user_excerpt = texts.userExcerpt;
  // Every response follows a message from the user, so not reading one means
  // pasted terminal output isn't seen. Flag it, with why when known.
  if (!userText) {
    round.user_messages_missing = true;
    if (readWhy) round.user_message_reason = readWhy;
    if (["paste", "typed", "unknown"].includes(msg.userRead?.looked)) round.user_message_looked = msg.userRead.looked;
  }
  if (partial) round.user_message_partial = readWhy;
  if (round.suggested_resolutions?.length) dlog("capture: proposed from content", round.suggested_resolutions.map(a => a.id));
  round.source_url = msg.url || "";
  // What this round was judged at capture, kept as it was: later edits and
  // newer rules never re-judge it.
  const r = report(ledger, goalText, await reportOptsFor(project));
  round.verdict_record = verdictRecord(r);
  // The handoff this round produced cut its goal prose: a drop of this round.
  if (r.handoffDrops?.length) (round.drops ??= []).push(...r.handoffDrops.map(d => ({ ...d, round: round.round })));

  await local.set({
    [K.ledger(project.id)]: ledger,
    [K.undo(project.id)]: before,
    [K.project(project.id)]: { ...fresh, lastUsedAt: now() },
    lastProjectId: project.id,
    lastError: null,
  });
  const evRes = await recordEvents(project.id, ledgerEvents(atStart, ledger, { at: now(), project: project.id, round: round.round, checks: r.checks }));
  if (evRes?.full) {
    // The event record is full: this round's events were not kept.
    (round.drops ??= []).push({ ...dropEntry("event record (full)", "skipped", evRes.events, "events"), round: round.round });
    await local.set({ [K.ledger(project.id)]: ledger });
  }
  await refreshBadge();
  dlog("capture: saved", { round: round.round, verdict: r.verdict });
  return { ...base, status: "captured", round: round.round, verdict: r.verdict,
           definitionWarnings: created ? definitionWarnings(project).length : 0,
           // Proposed, never applied (v0.34.0): a click confirms each on the panel.
           suggested: (round.suggested_resolutions || []).map(a => ({ id: a.id, superseded: Boolean(a.superseded) })),
           reviewed: reviewed.map(c => ({ id: c.id, status: c.status, proposed: Boolean(c.proposed) })),
           skipped: round.commitment_skipped ? round.commitment_skipped.reason : null,
           userMissing: Boolean(round.user_messages_missing),
           userPartial: Boolean(round.user_message_partial),
           userNote: round.user_message_partial ? USER_PARTIAL_TEXT[round.user_message_partial] : (USER_READ_TEXT[round.user_message_reason] || USER_READ_UNKNOWN),
           attached: round.commitment_attached ? { kind: round.commitment_attached.kind, parentId: round.commitment_attached.parent_id } : null };
}

async function isCaptured(text) {
  const key = await sha256(normaliseText(text));
  const { projects } = await loadProjects();
  for (const p of projects) {
    const ledger = await loadLedger(p.id);
    const doc = ledger.seen[key];
    if (doc === SETUP) return { captured: true, setup: true, projectId: p.id, projectName: p.name };
    if (doc) {
      const round = ledger.rounds.find(r => r.doc === doc);
      const verdict = round ? viewModel(p, ledger, round.round, await reportOptsFor(p)).verdict : null;
      return { captured: true, projectId: p.id, projectName: p.name, round: round?.round, verdict };
    }
  }
  return { captured: false };
}

// From the picker: clear this conversation's project so the next capture asks.
async function unfileThread({ url }) {
  const tk = threadKey(url);
  if (!tk) return { unfiled: false };
  const tp = await getThreadProjects();
  delete tp[tk];
  await local.set({ threadProjects: tp });
  notifyTabs();
  dlog("conversation unfiled", tk);
  return { unfiled: true };
}

async function setThreadProject({ url, projectId }) {
  await requireProject(projectId);
  return { remembered: await fileThread(url, projectId) };
}

// The verdict report for the on-page panel: same model the popup renders.
async function reportView({ projectId, round }) {
  const p = await requireProject(projectId);
  const vm = viewModel(p, await loadLedger(p.id), round ?? undefined, await reportOptsFor(p));
  dlog("reportView", { project: p.name, round, verdict: vm.verdict, missing: vm.missingRound });
  return { vm };
}

// What the panel showed (item 18), so a decline means something. surface:
// "page" (the on-page panel) or "popup". Opening the panel stamps the latest
// round and every open suggestion with the first time it was opened; seen
// lists the suggestions whose block was at least half on screen, each
// stamped the first time. Nothing else changes, and nothing is written when
// every stamp is already there.
async function recordView({ projectId, surface, seen = [] }) {
  const p = await requireProject(projectId);
  const ledger = await loadLedger(p.id);
  const last = ledger.rounds[ledger.rounds.length - 1];
  if (!last) return { changed: false };
  const at = now(), where = surface === "popup" ? "popup" : "page";
  let changed = false;
  if (!last.panel_opened_at) { last.panel_opened_at = at; changed = true; }
  if (!(last.panel_surfaces ??= []).includes(where)) { last.panel_surfaces.push(where); changed = true; }
  for (const c of ledger.commitments) {
    const sd = c.status === "OPEN" ? c.suggested_done : null;
    if (!sd) continue;
    if (!sd.panel_opened_at) { sd.panel_opened_at = at; changed = true; }
    if (seen.includes(c.id) && !sd.seen_at) { Object.assign(sd, { seen_at: at, seen_surface: where }); changed = true; }
  }
  if (changed) await local.set({ [K.ledger(p.id)]: ledger });
  dlog("panel view recorded", { project: p.name, surface: where, seen, changed });
  return { changed };
}

// One-click resolution of an open commitment from the popup or the on-page
// panel: the user did it ("executed"), or decided not to ("closed" + reason).
// The extension only sees assistant output, so this is how work done by the
// human gets into the ledger.
async function resolveCommitment({ projectId, commitmentId, action, reason }) {
  const p = await requireProject(projectId);
  const ledger = await loadLedger(p.id);
  const c = ledger.commitments.find(x => x.id === commitmentId);
  if (!c) throw new UserError("That commitment no longer exists.");
  if (action === "reopen") return reopenCommitment(p, ledger, c);
  if (c.status !== "OPEN") throw new UserError("That commitment is already resolved.");
  if (action === "still_open") {
    // Answered "still open" at capture time: don't ask again for a couple of rounds.
    const was = JSON.parse(JSON.stringify(ledger));
    c.still_open_round = (ledger.rounds[ledger.rounds.length - 1]?.round ?? 0) + 1;
    await local.set({ [K.ledger(p.id)]: ledger });
    await recordEvents(p.id, ledgerEvents(was, ledger, { at: now(), project: p.id }));
    dlog("commitment confirmed still open", { project: p.name, id: c.id });
    return { status: "OPEN" };
  }
  if (action === "defer") {
    const due = normalizeDue(reason);
    if (!due) throw new UserError("Pick a date to defer it to.");
    if (due <= now().slice(0, 10)) throw new UserError("Pick a date in the future.");
    return deferCommitment(p, ledger, c, due);
  }
  if (action === "closed" && !String(reason || "").trim()) throw new UserError("Give a reason for closing it.");
  if (!["executed", "closed", "superseded"].includes(action)) throw new UserError("Unknown action.");
  const before = JSON.parse(JSON.stringify(ledger));
  const at = now();
  const last = ledger.rounds[ledger.rounds.length - 1];
  Object.assign(c, {
    // "superseded": the user confirmed a proposed decision against it (v0.34.0).
    status: action === "executed" ? "EXECUTED" : action === "superseded" ? "SUPERSEDED" : "CLOSED_WITH_REASON",
    resolved_round: last?.round ?? c.round,
    resolution_note: action === "executed" ? (String(reason || "").trim() || "Marked executed by the user")
      : String(reason || "").trim() || "Superseded by your decision",
    resolved_by: "user",
    resolved_at: at,
  });
  // The latest round's view: drop it from the open list, and if it was the
  // commitment C2 judged, record the resolution so C2 passes.
  if (last) {
    if (last._open_commitments.some(o => o.id === c.id)) {
      // The round's open list as captured is changed, not marked: record it.
      (last.drops ??= []).push({ ...dropEntry("this round's open list", "overwritten", 1, "items", `${c.id} removed (resolved by you after capture)`), round: last.round });
    }
    last._open_commitments = last._open_commitments.filter(o => o.id !== c.id);
    if (last.judged_commitment === c.text) {
      last.user_resolution = { id: c.id, status: c.status, note: c.resolution_note, at };
    }
  }
  await local.set({ [K.ledger(p.id)]: ledger, [K.undo(p.id)]: before });
  await recordEvents(p.id, ledgerEvents(before, ledger, { at: now(), project: p.id }));
  await refreshBadge();
  dlog("commitment resolved by user", { project: p.name, id: c.id, status: c.status });
  return { status: c.status };
}

// Undo an automatic (or one-click) resolution: the commitment is open again.
// If resolving it had turned that round's C2 into EXECUTED, C2 goes back to
// what the model originally reported.
async function reopenCommitment(p, ledger, c) {
  if (c.status === "OPEN") throw new UserError("That commitment is already open.");
  if (!["EXECUTED", "CLOSED_WITH_REASON", "SUPERSEDED"].includes(c.status)) throw new UserError("Only resolved commitments can be reopened.");
  const before = JSON.parse(JSON.stringify(ledger));
  reopenInLedger(ledger, c, now());
  await local.set({ [K.ledger(p.id)]: ledger, [K.undo(p.id)]: before });
  await recordEvents(p.id, ledgerEvents(before, ledger, { at: now(), project: p.id }));
  await refreshBadge();
  dlog("commitment reopened", { project: p.name, id: c.id });
  return { status: "OPEN" };
}

// Asked at capture time: commitments that would have been open for more than
// two rounds at this capture (and weren't confirmed "still open" recently).
async function staleCommitments({ projectId }) {
  const p = await requireProject(projectId);
  const ledger = await loadLedger(p.id);
  const { list, total } = staleQuestions(ledger, now().slice(0, 10));
  dlog("stale commitments", { project: p.name, ids: list.map(x => x.id) });
  return { list, total };
}


// "Defer with date": the commitment stays open but is SCHEDULED until `due` -
// not judged by C2/C3 until then, listed under Scheduled.
async function deferCommitment(p, ledger, c, due) {
  const before = JSON.parse(JSON.stringify(ledger));
  const at = now();
  (c.due_changes ??= []).push({ from: c.due_date || null, to: due, at, by: "user" });   // the old date is kept
  Object.assign(c, { due_date: due, deferred_by: "user", deferred_at: at });
  const last = ledger.rounds[ledger.rounds.length - 1];
  if (last) {
    const snap = last._open_commitments.find(o => o.id === c.id);
    if (snap) snap.due_date = due;
    if (last.judged_commitment === c.text) {
      last.user_resolution = { id: c.id, status: "DEFERRED", note: due, at };
    }
  }
  await local.set({ [K.ledger(p.id)]: ledger, [K.undo(p.id)]: before });
  await recordEvents(p.id, ledgerEvents(before, ledger, { at: now(), project: p.id }));
  await refreshBadge();
  dlog("commitment deferred by user", { project: p.name, id: c.id, due });
  return { status: "DEFERRED", due };
}

// ACTIVE or WAITING (deliberately accumulating data): see core.js.
async function setPhase({ projectId, phase }) {
  const p = await requireProject(projectId);
  const next = phase === "WAITING" ? "WAITING" : "ACTIVE";
  await local.set({ [K.project(p.id)]: { ...p, phase: next } });
  await recordEvents(p.id, projectEditEvents({ ...p, phase: p.phase || "ACTIVE" }, { ...p, phase: next }, { at: now(), by: "user" }));
  await refreshBadge();
  notifyTabs();
  dlog("phase changed", { project: p.name, phase: next });
  return { phase: next };
}

// Draft for the new-project panel. Fast or not at all: short excerpt, capped
// answer, 8 s timeout. Any failure just means "no draft" in the panel.
async function draftProject({ text, title }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new UserError(CALL_FAILURES.noKey);
  if (!String(text || "").trim()) throw new UserError("Nothing to draft from.");
  const model = (await local.get("model")).model || DEFAULT_MODEL;
  const t0 = Date.now();
  const data = await callLLM(buildDraftPrompt(title, text), model, apiKey, { maxTokens: 400, timeoutMs: 8000 });
  const goal = clip(String(data.goal || "").replace(/\s+\n/g, "\n").trim(), 800);
  const outOfScope = (Array.isArray(data.out_of_scope) ? data.out_of_scope : [])
    .map(x => clip(String(x || "").replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim(), 120))
    .filter(Boolean).slice(0, 5);
  dlog("draft ready", { ms: Date.now() - t0, goalChars: goal.length, scopeLines: outOfScope.length });
  if (!goal) throw new UserError("Empty draft.");
  return { goal, outOfScope, isGoalDefinition: data.is_goal_definition === true };
}

// From the picker's "New project…": create and file the conversation, no capture.
async function createProject({ url, name, goal, outOfScope }) {
  const p = await addProject({ name, goal, outOfScope });
  const remembered = await fileThread(url, p.id);
  notifyTabs();
  return { projectId: p.id, projectName: p.name, remembered };
}

// ------------------------------------------------------------ project management (Options)

async function updateProject({ projectId, name, goal, outOfScope, phase }) {
  const p = await requireProject(projectId);
  const oos = stripSeverityTokens(String(outOfScope ?? "").trim());
  const next = { ...p, name: cleanName(name), goal: cleanGoal(goal), outOfScope: oos.text.trim(),
    phase: phase === undefined ? (p.phase || "ACTIVE") : (phase === "WAITING" ? "WAITING" : "ACTIVE") };
  await local.set({ [K.project(p.id)]: next });
  // The audit trail: what changed, from what, to what, and when (v0.34.0).
  await recordEvents(p.id, projectEditEvents({ ...p, phase: p.phase || "ACTIVE" }, next, { at: now(), by: "user" }));
  await refreshBadge();
  notifyTabs();
  return { removedLabels: oos.removed, warnings: definitionWarnings(next) };
}

async function deleteProject({ projectId }) {
  await requireProject(projectId);
  const s = await local.get(["projectIds", "lastProjectId", "threadProjects"]);
  const ids = (s.projectIds || []).filter(id => id !== projectId);
  // Its conversations become unfiled: the next capture there asks again.
  const tp = Object.fromEntries(Object.entries(s.threadProjects || {}).filter(([, v]) => v !== projectId));
  await local.remove([K.project(projectId), K.ledger(projectId), K.undo(projectId), K.events(projectId)]);
  await local.set({
    projectIds: ids,
    threadProjects: tp,
    lastProjectId: s.lastProjectId === projectId ? null : s.lastProjectId,
  });
  await refreshBadge();
  notifyTabs();
  return {};
}

async function setLastProject({ projectId }) {
  await requireProject(projectId);
  await local.set({ lastProjectId: projectId });
  await refreshBadge();
  return {};
}

async function undoLast({ projectId }) {
  const p = await requireProject(projectId);
  const key = K.undo(p.id);
  const snap = (await local.get(key))[key];
  if (!snap) throw new UserError("Nothing to undo.");
  const current = await loadLedger(p.id);
  await local.set({ [K.ledger(p.id)]: snap });
  await recordEvents(p.id, undoEvents(current, snap, { at: now(), project: p.id }));
  await local.remove(key);
  await refreshBadge();
  return { status: "undone" };
}

async function resetLedger({ projectId }) {
  const p = await requireProject(projectId);
  const current = await loadLedger(p.id);
  await local.set({ [K.ledger(p.id)]: emptyLedger(), lastError: null });
  // The record is kept; a reset event says which rounds the ledger dropped.
  await recordEvents(p.id, current.rounds.length ? [{ at: now(), project: p.id, type: "reset", rounds: current.rounds.map(r => r.round) }] : []);
  await local.remove(K.undo(p.id));
  await refreshBadge();
  return { status: "reset" };
}

// ------------------------------------------------------------ export / import

async function exportAll() {
  const { projects } = await loadProjects();
  const out = [];
  for (const p of projects) {
    const events = (await local.get(K.events(p.id)))[K.events(p.id)] || [];
    out.push({ ...p, ledger: await loadLedger(p.id), events });
  }
  return {
    data: {
      format: EXPORT_FORMAT,
      version: SCHEMA_VERSION,
      exportedAt: now(),
      threadProjects: await getThreadProjects(),
      projects: out,
    },
  };
}

function validLedger(l) {
  return l && Array.isArray(l.rounds) && Array.isArray(l.commitments) &&
    l.rounds.every(r => r && typeof r === "object" && Array.isArray(r._open_commitments)) &&
    l.commitments.every(c => c && typeof c.text === "string" && typeof c.round === "number");
}

// Accepts: this extension's export (v2 or v3); a v0.1 single-ledger export
// ({ goal, rounds, commitments, seen }); or manager.py's ledger.json.
function parseImport(data) {
  if (!data || typeof data !== "object") throw new UserError("Not a JSON object.");
  let incoming;
  if (data.format === EXPORT_FORMAT) {
    if (!Array.isArray(data.projects)) throw new UserError("Export has no projects list.");
    incoming = data.projects;
  } else if (Array.isArray(data.rounds)) {
    incoming = [{ name: data.name || "Imported project", goal: data.goal || "",
                  ledger: { rounds: data.rounds, commitments: data.commitments, seen: data.seen } }];
  } else {
    throw new UserError("Unrecognised file. Expected a Project Manager export or a manager.py ledger.json.");
  }
  return incoming.map((p, i) => {
    const ledger = { rounds: p.ledger?.rounds, commitments: p.ledger?.commitments,
                     seen: p.ledger?.seen && typeof p.ledger.seen === "object" ? p.ledger.seen : {} };
    if (Array.isArray(p.ledger?.setup)) ledger.setup = p.ledger.setup;
    if (!validLedger(ledger)) throw new UserError(`Project ${i + 1} has a malformed ledger.`);
    const str = v => (typeof v === "string" ? v : "");
    return {
      id: str(p.id) || crypto.randomUUID(),
      name: cleanName(p.name || `Imported project ${i + 1}`),
      goal: str(p.goal),
      outOfScope: str(p.outOfScope),
      createdAt: str(p.createdAt) || now(),
      lastUsedAt: str(p.lastUsedAt) || undefined,
      ledger,
      events: Array.isArray(p.events) ? p.events.filter(e => e && typeof e === "object" && typeof e.type === "string") : [],
    };
  });
}

async function importAll({ data, mode }) {
  const incoming = parseImport(data);
  if (!incoming.length) throw new UserError("The file contains no projects.");
  const s = await local.get(["projectIds", "threadProjects"]);
  const existing = s.projectIds || [];
  const set = {};
  const remap = {};
  let ids, tp;

  if (mode === "replace") {
    await local.remove(existing.flatMap(id => [K.project(id), K.ledger(id), K.undo(id), K.events(id)]));
    ids = [];
    tp = {};
  } else {
    ids = [...existing];
    tp = { ...(s.threadProjects || {}) };
  }

  const { projects: current } = mode === "replace" ? { projects: [] } : await loadProjects();
  const names = new Set(current.map(p => p.name));
  for (const { ledger, events, ...p } of incoming) {
    const id = ids.includes(p.id) ? crypto.randomUUID() : p.id;   // never overwrite in "add" mode
    remap[p.id] = id;
    let name = p.name;
    while (names.has(name)) name = `${name} (imported)`;
    names.add(name);
    ids.push(id);
    set[K.project(id)] = { ...p, id, name };
    set[K.ledger(id)] = ledger;
    // The event record travels with its project, under the project's new id.
    if (events.length) set[K.events(id)] = events.map(e => ({ ...e, project: id }));
  }

  // Conversation filings travel with the projects they point to.
  for (const [k, v] of Object.entries(data.threadProjects || {})) {
    if (typeof k === "string" && remap[v] && !(k in tp)) tp[k] = remap[v];
  }

  await local.set({ ...set, projectIds: ids, threadProjects: tp,
                    lastProjectId: remap[incoming[0].id], schemaVersion: SCHEMA_VERSION });
  await refreshBadge();
  notifyTabs();
  return { imported: incoming.length };
}

// ------------------------------------------------------------ misc

async function testKey() {
  const apiKey = await getApiKey();
  if (!apiKey) throw new UserError(CALL_FAILURES.noKey);
  let res;
  try {
    // One token, on the configured model: listing models succeeds with no
    // credit, so it cannot tell a working key from an unfunded one.
    const model = (await local.get("model")).model || DEFAULT_MODEL;
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new UserError(e?.name === "TimeoutError" || e?.name === "AbortError" ? CALL_FAILURES.slow : CALL_FAILURES.unreachable);
  }
  if (!res.ok) {
    let error = null;
    try { error = (await res.json()).error; } catch {}
    // What was pressed here is Test key, not Capture.
    throw new UserError(callFailureMessage(res.status, error).replace("then capture again.", "then test again."));
  }
  return { status: "ok" };
}

async function recordError(err, msg) {
  const message = err instanceof UserError ? err.message : "Unexpected error - see the service worker console.";
  if (!(err instanceof UserError)) console.error("Project Manager:", err?.name, err?.message);
  const p = msg?.projectId ? await getProject(msg.projectId) : null;
  const projectName = p?.name || msg?.newProject?.name || "";
  await local.set({ lastError: { message, at: now(), projectName } });
  dlog("ERROR capture", message);
  return message;
}

// ------------------------------------------------------------ wiring

const HANDLERS = {
  ready: async () => ({}),
  captureContext: msg => captureContext(msg.url),
  setThreadProject: msg => serialised(() => setThreadProject(msg)),
  unfileThread: msg => serialised(() => unfileThread(msg)),
  capture: msg => serialised(() => capture(msg)),
  isCaptured: msg => isCaptured(msg.text),
  reportView: msg => reportView(msg),
  resolveCommitment: msg => serialised(() => resolveCommitment(msg)),
  recordView: msg => serialised(() => recordView(msg)),
  setPhase: msg => serialised(() => setPhase(msg)),
  staleCommitments: msg => staleCommitments(msg),
  draftProject: msg => draftProject(msg),
  reviewCommitments: msg => serialised(() => reviewCommitments(msg)),
  undo: msg => serialised(() => undoLast(msg)),
  reset: msg => serialised(() => resetLedger(msg)),
  createProject: msg => serialised(() => createProject(msg)),
  updateProject: msg => serialised(() => updateProject(msg)),
  deleteProject: msg => serialised(() => deleteProject(msg)),
  setLastProject: msg => serialised(() => setLastProject(msg)),
  exportAll: () => exportAll(),
  import: msg => serialised(() => importAll(msg)),
  testKey: () => testKey(),
  openOptions: async () => { await chrome.runtime.openOptionsPage(); return {}; },
  // Steps reported by content scripts; only kept when debug mode is on.
  log: async msg => { dlog(`page: ${msg.step}`, msg.detail); return {}; },
  injectTab: msg => ensureContentScript(msg.tabId),
};

// Only capture failures are worth a persistent "last capture failed" banner.
const RECORDED = new Set(["capture"]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = HANDLERS[msg?.type];
  if (!h) return false;
  if (msg.type !== "log") dlog(`message: ${msg.type}`);
  ensureReady().then(() => h(msg)).then(
    result => sendResponse({ ok: true, ...result }),
    async err => {
      let message;
      if (RECORDED.has(msg.type)) {
        message = await recordError(err, msg);
      } else if (err instanceof UserError) {
        message = err.message;
      } else {
        console.error("Project Manager:", err?.name, err?.message);
        message = "Unexpected error.";
      }
      sendResponse({ ok: false, error: message });
    });
  return true; // async response
});

// ------------------------------------------------------------ page script health

async function ping(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 });
    return r?.ok ? r : null;
  } catch (e) {
    dlog("ping: no page script", e.message);
    return null;
  }
}

// Make sure the content script is alive in this tab. Chrome only injects
// content scripts on page load, so a tab opened before the extension was
// installed, reloaded or updated has none until it is refreshed.
async function ensureContentScript(tabId) {
  let p = await ping(tabId);
  if (p) {
    dlog("page script present", { strategy: p.strategy, found: p.found, bars: p.bars, version: p.version });
    return p;
  }
  dlog("page script missing - injecting", { tabId });
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content/content.js"] });
  } catch (e) {
    throw new UserError(`Couldn't load into this page (${e.message}). Refresh the tab and try again.`);
  }
  p = await ping(tabId);
  if (!p) throw new UserError("The page script didn't start. Refresh the tab and try again.");
  dlog("page script injected", { strategy: p.strategy, found: p.found });
  return p;
}

async function injectIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: CHAT_URLS }); } catch (e) { dlog("inject: query failed", e.message); }
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id, frameIds: [0] }, files: ["content/content.js"] });
      dlog("inject: ok", { tabId: t.id });
    } catch (e) {
      dlog("inject: failed", { tabId: t.id, error: e.message });
    }
  }
}

// ------------------------------------------------------------ visible errors

// Show an error on the page itself, without relying on the content script.
async function pageToast(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      args: [message],
      func: msg => {
        const id = "pm-error-toast";
        document.getElementById(id)?.remove();
        const d = document.createElement("div");
        d.id = id;
        d.setAttribute("role", "alert");
        d.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;max-width:420px;padding:12px 36px 12px 14px;" +
          "background:#fbe7e5;color:#8a1c12;border:1px solid #e3a59d;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);" +
          "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;";
        d.textContent = "Project Manager: " + msg;
        const x = document.createElement("button");
        x.textContent = "×";
        x.setAttribute("aria-label", "Close");
        x.style.cssText = "position:absolute;top:6px;right:8px;border:0;background:none;font-size:18px;cursor:pointer;color:inherit;";
        x.onclick = () => d.remove();
        d.append(x);
        document.documentElement.append(d);
        setTimeout(() => d.remove(), 15000);
      },
    });
    return true;
  } catch (e) {
    dlog("pageToast failed", e.message);
    return false;
  }
}

// Never fail silently: page toast, else a desktop notification; always the
// badge and the popup's "last error" banner.
async function surfaceError(tabId, message, alreadyShown = false) {
  message = mask(message);
  console.error("[PM]", message);
  dlog("ERROR shown to user", message);
  await local.set({ lastError: { message, at: now(), projectName: "" } });
  await chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  await chrome.action.setBadgeText({ text: "ERR" });
  if (alreadyShown) return;
  const shown = tabId >= 0 && await pageToast(tabId, message);
  if (!shown) {
    chrome.notifications.create({
      type: "basic", iconUrl: "icons/icon128.png", title: "Project Manager", message,
    }, () => { if (chrome.runtime.lastError) dlog("notification failed", chrome.runtime.lastError.message); });
  }
}

// ------------------------------------------------------------ context menu

async function createMenus() {
  await new Promise(r => chrome.contextMenus.removeAll(() => { void chrome.runtime.lastError; r(); }));
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Capture selection as a Project Manager round",
    contexts: ["selection"],
    documentUrlPatterns: CHAT_URLS,
  });
  chrome.contextMenus.create({
    id: TEST_MENU_ID,
    title: "Project Manager: show a test error",
    contexts: ["page", "selection"],
    documentUrlPatterns: CHAT_URLS,
    visible: debugOn,
  });
}

async function handleMenu(info, tab) {
  dlog("menu: clicked", { item: info.menuItemId, tabId: tab?.id, frameId: info.frameId, url: info.pageUrl, selected: info.selectionText?.length });
  if (info.menuItemId !== MENU_ID && info.menuItemId !== TEST_MENU_ID) return;
  if (!tab?.id || tab.id < 0) throw new Error("Chrome didn't say which tab was clicked. Try again from the page itself.");
  await ensureContentScript(tab.id);

  if (info.menuItemId === TEST_MENU_ID) {
    dlog("menu: asking page to show a test error");
    const res = await chrome.tabs.sendMessage(tab.id, { type: "testError" }, { frameId: 0 });
    dlog("menu: page replied", res);
    if (!res?.shown) await surfaceError(tab.id, "Test error (shown by the service worker because the page didn't show it).");
    return;
  }

  if (!info.selectionText?.trim()) throw new UserError("No text was selected.");
  dlog("menu: sending selection to page");
  const res = await chrome.tabs.sendMessage(tab.id, { type: "captureSelection", text: info.selectionText }, { frameId: 0 });
  dlog("menu: page replied", res);
  if (!res?.ok) {
    const err = new Error(res?.error || "The page didn't respond.");
    err.shown = Boolean(res?.shown);
    throw err;
  }
}

function onMenuClick(info, tab) {
  return handleMenu(info, tab).catch(e =>
    surfaceError(tab?.id ?? -1, `Right-click capture failed: ${e.message}`, Boolean(e.shown)));
}
chrome.contextMenus.onClicked.addListener(onMenuClick);

// Test hook (used by test/e2e.mjs; harmless in normal use).
globalThis.__pmMenuClick = onMenuClick;

chrome.runtime.onInstalled.addListener(async details => {
  await debugReady;
  await createMenus();
  await ensureReady();
  dlog("installed", { reason: details.reason, version: chrome.runtime.getManifest().version });
  // Tabs opened before this install/update have no content script yet.
  await injectIntoOpenTabs();
  // Only the API key needs setting up front; projects start at first capture.
  // Once only: a browser can report "install" again for an unpacked extension.
  if (details.reason === "install") {
    const { apiKey, firstRunShown } = await local.get(["apiKey", "firstRunShown"]);
    if (!apiKey && !firstRunShown) {
      await local.set({ firstRunShown: true });
      chrome.tabs.create({ url: chrome.runtime.getURL("options/welcome.html") });
    }
  }
  refreshBadge();
});

chrome.runtime.onStartup.addListener(() => ensureReady().then(refreshBadge));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.debug) {
    debugOn = Boolean(changes.debug.newValue);
    chrome.contextMenus.update(TEST_MENU_ID, { visible: debugOn }, () => void chrome.runtime.lastError);
    if (debugOn) dlog("debug mode on", { version: chrome.runtime.getManifest().version });
  }
});
