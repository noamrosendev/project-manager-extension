// Storage layout (chrome.storage.local), shared by the service worker, popup
// and options page. Only the service worker writes project data; the pages
// read it directly and send messages to change it.
//
//   schemaVersion      3
//   projectIds         [id, ...]                 creation order
//   project:<id>       { id, name, goal, outOfScope, createdAt, lastUsedAt }
//   ledger:<id>        { rounds, commitments, seen }   one ledger per project
//   undo:<id>          ledger snapshot before that project's last round
//   lastProjectId      project last captured into / viewed (drives the badge)
//   threadProjects     { "<thread key>": projectId }   which project a conversation is filed under
//   apiKey, model      global settings
//   lastError          { message, at, projectName }
//
// Projects are created just in time, from the capture panel, the first time
// a conversation is filed. There is no "active" project.

import { emptyLedger, DEFAULT_GRACE_ROUNDS } from "./core.js";

export const SCHEMA_VERSION = 3;

export const K = {
  project: id => `project:${id}`,
  ledger: id => `ledger:${id}`,
  undo: id => `undo:${id}`,
  events: id => `events:${id}`,   // append-only event record (see ledgerEvents in core.js)
};

// Normalise a free-text field: unify line endings, drop trailing spaces, and
// split sentences that were run together with no space or line break
// ("...is workable.Receive an offer..."). That happens when a line break typed
// into the capture panel is swallowed by the chat page's own key handlers.
export function tidyText(t) {
  return String(t || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/([\p{Ll}\p{N})\]"'’”])([.!?])(\p{Lu}\p{Ll})/gu, "$1$2\n$3")
    .trim();
}

// The goal text fed to the extraction prompt and the handoff, shaped like
// manager.py's goal.md: the goal, then out-of-scope under its own heading,
// each separated by a blank line.
//
// Never loses the user's goal to formatting: if tidying fails or leaves
// nothing, the stored text is used as-is.
export function composeGoal(p) {
  const raw = p?.goal == null ? "" : String(p.goal);
  const rawOos = p?.outOfScope == null ? "" : String(p.outOfScope);
  let goal, oos;
  try {
    goal = tidyText(raw);
    oos = tidyText(rawOos);
  } catch {
    goal = raw.trim();
    oos = rawOos.trim();
  }
  if (!goal && raw.trim()) goal = raw.trim();
  if (!oos && rawOos.trim()) oos = rawOos.trim();
  let text = /^#\s/.test(goal) ? goal : `# PROJECT GOAL\n\n${goal}`;
  // The field may already start with the heading (pasted from a goal):
  // keep one, never two.
  if (oos) text += `\n\n## Explicitly out of scope\n${oos.replace(/^#+\s*Explicitly out of scope\s*(?:\n+|$)/i, "")}`;
  return text + "\n";
}

// The project's out-of-scope rules, one per line, for the C6 scope check:
// the out-of-scope field plus any "Explicitly out of scope" section in the
// goal text (goal.md style). Bullets/numbering stripped. No cap: an
// unchecked rule would be silently unenforced (each is one small call).
export function outOfScopeLines(p) {
  const lines = [];
  const take = text => {
    for (const raw of String(text || "").split(/\r?\n/)) {
      const t = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
      if (t && !/^#/.test(t) && !lines.includes(t)) lines.push(t);
    }
  };
  take(p?.outOfScope);
  const m = String(p?.goal || "").match(/^#+\s*Explicitly out of scope\s*$([\s\S]*?)(?=^#|(?![\s\S]))/im);
  if (m) take(m[1]);
  return lines;
}

// Shapes in the out-of-scope rules that have gone wrong on real definitions. It
// reports, and refuses and changes nothing: outOfScopeLines splits as it always
// has (decision of 21 Oct), and this only makes what it did visible. Each shape
// is one seen in stored rounds: a line cut at a comma or wrapped into the next
// (one project's rounds 36-42), several rules on one line (three projects). A rule that is one idea in two sentences is warned
// about too; that one may be fine, and only its author can say.
export function definitionWarnings(p) {
  const out = [];
  const lines = outOfScopeLines(p);
  lines.forEach((l, i) => {
    const line = i + 1;
    if (/,\s*$/.test(l)) out.push({ line, kind: "cut", text: `Rule ${line} ends in a comma, so it may be cut off.` });
    if (i > 0 && /^[a-z]/.test(l) && !/[.!?;:]\s*$/.test(lines[i - 1])) {
      out.push({ line, kind: "wrapped", text: `Rule ${line} starts in lowercase after a rule with no end punctuation, so the two may be one wrapped sentence.` });
    }
    const parts = (l.match(/[.;!?]\s+(?=\S)/g) || []).length + 1;
    if (parts > 1) out.push({ line, kind: "several", text: `Rule ${line} holds ${parts} sentences or clauses, and C6 judges it as one rule.` });
  });
  return out;
}

// Canonical key for a conversation, or null when the URL isn't a conversation
// (e.g. the "new chat" page before the site assigns an id).
export function threadKey(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.hostname === "chatgpt.com") {
    const m = u.pathname.match(/\/c\/([\w-]+)/);
    return m ? `chatgpt.com/c/${m[1]}` : null;
  }
  if (u.hostname === "claude.ai") {
    const m = u.pathname.match(/^\/chat\/([\w-]+)/);
    return m ? `claude.ai/chat/${m[1]}` : null;
  }
  return null;
}

export async function loadProjects() {
  const s = await chrome.storage.local.get(["projectIds", "lastProjectId"]);
  const ids = s.projectIds || [];
  const recs = ids.length ? await chrome.storage.local.get(ids.map(K.project)) : {};
  const projects = ids.map(id => recs[K.project(id)]).filter(Boolean);
  const lastProjectId = projects.some(p => p.id === s.lastProjectId) ? s.lastProjectId : projects[0]?.id ?? null;
  return { projects, lastProjectId };
}

// Most recently used first: the order the capture panel offers them in.
export function byRecency(projects) {
  return [...projects].sort((a, b) =>
    (b.lastUsedAt || b.createdAt || "").localeCompare(a.lastUsedAt || a.createdAt || ""));
}

// Settings > "Rounds before an unconfirmed commitment counts as not done".
export async function loadReportOpts() {
  const { graceRounds } = await chrome.storage.local.get("graceRounds");
  const n = parseInt(graceRounds, 10);
  return { graceRounds: Number.isFinite(n) && n >= 1 ? n : DEFAULT_GRACE_ROUNDS };
}

// Report options for one project: global settings + the project's phase.
export async function reportOptsFor(project) {
  return { ...(await loadReportOpts()), phase: project?.phase === "WAITING" ? "WAITING" : "ACTIVE" };
}

export async function loadLedger(id) {
  const key = K.ledger(id);
  const s = await chrome.storage.local.get(key);
  return s[key] || emptyLedger();
}

// The panel shows each out-of-scope rule followed by its severity label
// (HARD, or CONDITIONAL ("marker")). Pasted back into the field, the label
// would become part of the rule and the panel would show it twice: stripped
// on save, so display text never becomes storage (v0.34.0). Case-sensitive,
// as the panel writes it; a rule that merely contains the word keeps it.
const SEVERITY = String.raw`(?:HARD|CONDITIONAL(?:\s*\(\s*"[^"]*"\s*\))?)`;
const SEVERITY_TAIL = new RegExp(String.raw`\s+${SEVERITY}\s*$`);
const SEVERITY_ONLY = new RegExp(String.raw`^\s*(?:[-*•]\s*)?${SEVERITY}\s*$`);
export function stripSeverityTokens(text) {
  let removed = 0;
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (SEVERITY_ONLY.test(line)) { removed++; continue; }
    out.push(line.replace(SEVERITY_TAIL, () => { removed++; return ""; }));
  }
  return { text: out.join("\n"), removed };
}
