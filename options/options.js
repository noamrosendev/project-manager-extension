import { report, DEFAULT_MODEL, OUTCOME_TYPES, EVENT_CAP_BYTES } from "../lib/core.js";
import { composeGoal, loadProjects, loadLedger, loadReportOpts, definitionWarnings } from "../lib/store.js";
import { SHADOW_KEY, shadowTally, shadowChoice } from "../lib/shadow.js";
import { measure, MAPPING, accuracyRows } from "../lib/accuracy.js";
import { scopeItemsOf, staleBacklog } from "../lib/report_model.js";
import { scopeList } from "../lib/report_view.js";

const $ = id => document.getElementById(id);

const GOAL_HINT = "What does done look like? Be specific enough that you could tell whether a given week moved toward it.";
const OOS_HINT = "Anything you have decided not to do. The manager uses this to flag drift.";

const VERDICT_TEXT = { PROGRESS: "Progress", AT_RISK: "At risk", LOOP: "Loop", DEVIATION: "Deviation" };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function flash(el, text, cls = "") {
  el.textContent = text;
  el.className = `hint ${cls}`.trim();
}

async function send(msg) {
  try {
    return (await chrome.runtime.sendMessage(msg)) || { ok: false, error: "No response." };
  } catch {
    return { ok: false, error: "Extension unavailable." };
  }
}

// ------------------------------------------------------------ settings

async function loadSettings() {
  const s = await chrome.storage.local.get(["apiKey", "model"]);
  $("apiKey").value = s.apiKey || "";
  $("model").value = s.model || DEFAULT_MODEL;
  $("graceRounds").value = (await loadReportOpts()).graceRounds;
  $("askStale").checked = Boolean((await chrome.storage.local.get("askStaleAtCapture")).askStaleAtCapture);
}

$("settings").addEventListener("submit", async e => {
  e.preventDefault();
  await chrome.storage.local.set({
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULT_MODEL,
    graceRounds: Math.min(20, Math.max(1, parseInt($("graceRounds").value, 10) || 3)),
    askStaleAtCapture: $("askStale").checked,
  });
  flash($("settingsStatus"), "Saved.", "ok");
});

$("toggleKey").addEventListener("click", () => {
  const show = $("apiKey").type === "password";
  $("apiKey").type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "Hide" : "Show";
});

$("testKey").addEventListener("click", async () => {
  // Save the key first so the background worker tests what's in the field.
  await chrome.storage.local.set({ apiKey: $("apiKey").value.trim() });
  flash($("keyStatus"), "Testing…");
  const res = await send({ type: "testKey" });
  flash($("keyStatus"), res.ok ? "Key works and the account has credit." : res.error, res.ok ? "ok" : "bad");
});

// ------------------------------------------------------------ projects

// id -> card; storage refreshes never clobber unsaved edits.
const cards = new Map();

let reportOpts = {};
function statsText(ledger, p, conversations) {
  const phase = p.phase === "WAITING" ? " · waiting" : "";
  const n = ledger.rounds.length;
  const convo = `${conversations} conversation${conversations === 1 ? "" : "s"}`;
  if (!n) return `No rounds yet · ${convo}${phase}`;
  const r = report(ledger, composeGoal(p), { ...reportOpts, phase: p.phase });
  return `${n} round${n === 1 ? "" : "s"} · ${r.open.length} open · ${VERDICT_TEXT[r.verdict]} · ${convo}${phase}`;
}

function buildCard(p) {
  const nameIn = h("input", { type: "text", maxlength: "80", id: `name-${p.id}` });
  const goalIn = h("textarea", { rows: "6", spellcheck: "true", id: `goal-${p.id}` });
  const oosIn = h("textarea", { rows: "3", spellcheck: "true", id: `oos-${p.id}` });
  const phaseIn = h("select", { id: `phase-${p.id}` },
    h("option", { value: "ACTIVE" }, "Active - building, changing things"),
    h("option", { value: "WAITING" }, "Waiting - deliberately accumulating data, changing nothing"));
  const status = h("span", { class: "hint", role: "status" });
  const reset = h("button", { type: "button", class: "danger" }, "Reset ledger…");
  const del = h("button", { type: "button", class: "danger" }, "Delete…");
  // The out-of-scope rules exactly as C6 will check them, updated as you type.
  const parsed = h("div", { class: "scope-parsed" });
  const form = h("form", { class: "card-body" },
    h("label", { for: nameIn.id }, "Name"), nameIn,
    h("label", { for: goalIn.id }, "What is the goal?"), goalIn,
    h("p", { class: "hint" }, GOAL_HINT),
    h("label", { for: oosIn.id }, "What is out of scope? ", h("span", { class: "optional" }, "(optional)")), oosIn,
    h("p", { class: "hint" }, OOS_HINT + " Changes apply to future rounds; earlier rounds are not re-judged."),
    parsed,
    h("label", { for: phaseIn.id }, "Phase"), phaseIn,
    h("p", { class: "hint" }, "Waiting: repeated output shapes (C1) aren't penalised. " +
      "Commitments (C2) and goal alignment (C6) are checked as usual. Also switchable from the project picker on the page."),
    h("div", { class: "row actions" }, h("button", { type: "submit", class: "primary" }, "Save"), reset, del, status));
  const el = h("details", { class: "card", "data-id": p.id },
    h("summary", {}, h("span", { class: "pname" }), h("span", { class: "stats" })), form);

  const refreshParsed = () => {
    const def = { goal: goalIn.value, outOfScope: oosIn.value }, warns = definitionWarnings(def);
    parsed.replaceChildren(scopeList(scopeItemsOf(def)) || h("p", { class: "hint" }, "No out-of-scope rules: C6 checks only goal alignment."),
      ...(warns.length ? [h("ul", { class: "scope-warnings hint" }, warns.map(w => h("li", {}, w.text)))] : []));
  };
  for (const i of [goalIn, oosIn]) i.addEventListener("input", refreshParsed);
  const card = { el, dirty: false, nameIn, goalIn, oosIn, phaseIn, refreshParsed };
  const markDirty = () => { card.dirty = true; flash(status, "Unsaved changes"); };
  for (const i of [nameIn, goalIn, oosIn, phaseIn]) i.addEventListener("input", markDirty);

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const res = await send({ type: "updateProject", projectId: p.id,
      name: nameIn.value, goal: goalIn.value, outOfScope: oosIn.value, phase: phaseIn.value });
    if (!res.ok) return flash(status, res.error, "bad");
    card.dirty = false;
    // The panel's severity labels are display, never rule text (v0.34.0).
    const warned = res.warnings?.length ? ` ${res.warnings.length} warning${res.warnings.length === 1 ? "" : "s"} about these rules, listed above: saved as written, and C6 will check them as listed.` : "";
    flash(status, (res.removedLabels ? `Saved. Removed ${res.removedLabels} severity label${res.removedLabels === 1 ? "" : "s"} ` +
      "(HARD / CONDITIONAL is the panel's display, not part of a rule)." : "Saved.") + warned, "ok");
    if (res.removedLabels) oosIn.value = (await loadProjects()).projects.find(x => x.id === p.id)?.outOfScope ?? oosIn.value;
  });
  reset.addEventListener("click", async () => {
    if (!confirm(`Delete every captured round and commitment in “${nameIn.value}”? This cannot be undone. Export first if you want a copy.`)) return;
    const res = await send({ type: "reset", projectId: p.id });
    flash(status, res.ok ? "Ledger reset." : res.error, res.ok ? "ok" : "bad");
  });
  del.addEventListener("click", async () => {
    if (!confirm(`Delete project “${nameIn.value}” and its whole ledger? Its conversations will ask for a project again on next capture. This cannot be undone.`)) return;
    const res = await send({ type: "deleteProject", projectId: p.id });
    if (!res.ok) flash(status, res.error, "bad");
  });
  return card;
}

async function renderProjects() {
  reportOpts = await loadReportOpts();
  const { projects } = await loadProjects();
  const { threadProjects = {} } = await chrome.storage.local.get("threadProjects");
  const list = $("projects");
  $("noProjects").hidden = projects.length > 0;
  const seen = new Set();
  for (const p of projects) {
    seen.add(p.id);
    let card = cards.get(p.id);
    if (!card) {
      card = buildCard(p);
      cards.set(p.id, card);
      if (projects.length === 1) card.el.open = true;
    }
    list.append(card.el);   // keeps display order in sync with projectIds
    const ledger = await loadLedger(p.id);
    const convos = Object.values(threadProjects).filter(v => v === p.id).length;
    card.el.querySelector(".pname").textContent = p.name;
    card.el.querySelector(".stats").textContent = statsText(ledger, p, convos);
    if (!card.dirty) {
      card.nameIn.value = p.name;
      card.goalIn.value = p.goal || "";
      card.oosIn.value = p.outOfScope || "";
      card.phaseIn.value = p.phase === "WAITING" ? "WAITING" : "ACTIVE";
    }
    card.refreshParsed();
    await renderDefinitionHistory(card, p.id);
  }
  for (const [id, card] of cards) {
    if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
  }
}

// Every recorded edit to the project's definition, newest first (v0.34.0).
const FIELD_NAME = { name: "name", goal: "goal", outOfScope: "out of scope", phase: "phase" };
async function renderDefinitionHistory(card, projectId) {
  const key = `events:${projectId}`;
  const edits = ((await chrome.storage.local.get(key))[key] || []).filter(e => e.type === "project_edited").reverse();
  let box = card.el.querySelector(".definition-history");
  if (!box) { box = h("details", { class: "definition-history" }); card.el.querySelector(".card-body").append(box); }
  // In full: a cut-off value cannot show what a rule was changed to.
  const short = v => (v == null ? "(none)" : v === "" ? "(empty)" : String(v));
  box.replaceChildren(h("summary", {}, `Definition history (${edits.length})`),
    edits.length ? h("ul", {}, edits.map(e => h("li", {},
      h("div", { class: "hint" }, `${new Date(e.at).toLocaleString()} · ${FIELD_NAME[e.field] || e.field} · ${e.by}${e.via ? ` (${e.via})` : ""}`),
      h("div", { class: "edit-from" }, `from: ${short(e.from)}`), h("div", { class: "edit-to" }, `to: ${short(e.to)}`))))
      : h("p", { class: "hint" }, "No edits recorded (recorded since v0.34.0)."));
}

// ------------------------------------------------------------ backup

$("export").addEventListener("click", async () => {
  const res = await send({ type: "exportAll" });
  if (!res.ok) return flash($("dataStatus"), res.error, "bad");
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `project-manager-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash($("dataStatus"), `Exported ${res.data.projects.length} project(s).`, "ok");
});

let importMode = "add";
$("importAdd").addEventListener("click", () => { importMode = "add"; $("importFile").click(); });
$("importReplace").addEventListener("click", () => { importMode = "replace"; $("importFile").click(); });
$("importFile").addEventListener("change", async () => {
  const file = $("importFile").files[0];
  $("importFile").value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return flash($("dataStatus"), "That file isn't valid JSON.", "bad");
  }
  if (importMode === "replace" &&
      !confirm("Replace ALL current projects and ledgers with the contents of this file? This cannot be undone.")) return;
  const res = await send({ type: "import", data, mode: importMode });
  flash($("dataStatus"), res.ok ? `Imported ${res.imported} project(s).` : res.error, res.ok ? "ok" : "bad");
});

// ------------------------------------------------------------ debug

async function loadDebug() {
  const { debug, debugLog = [] } = await chrome.storage.local.get(["debug", "debugLog"]);
  $("debug").checked = Boolean(debug);
  $("debugLog").value = debugLog.join("\n") || (debug ? "(no steps logged yet - reproduce the problem now)" : "(debug mode is off)");
  $("debugLog").scrollTop = $("debugLog").scrollHeight;
}

$("debug").addEventListener("change", async () => {
  await chrome.storage.local.set({ debug: $("debug").checked });
  flash($("logStatus"), $("debug").checked
    ? "On. Refresh your chatgpt.com / claude.ai tab, then reproduce the problem." : "Off.", "ok");
});
$("copyLog").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("debugLog").value);
    flash($("logStatus"), "Copied.", "ok");
  } catch {
    $("debugLog").select();
    flash($("logStatus"), "Press ⌘C / Ctrl+C to copy.");
  }
});
$("clearLog").addEventListener("click", async () => {
  await chrome.storage.local.set({ debugLog: [] });
  flash($("logStatus"), "Cleared.", "ok");
});

// ------------------------------------------------------------ stale backlog sweep

// What C3 counts as open 2+ rounds, per project, for one-click closure or
// deferral (v0.34.0). Listing only: each action is the user's click, sent as
// the same resolveCommitment message the panel uses.
const dayStr = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");
const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
async function renderStaleBacklog() {
  const { projects } = await loadProjects();
  const root = $("staleBacklog");
  const blocks = [];
  for (const p of projects) {
    const list = staleBacklog(p, await loadLedger(p.id), reportOpts || {});
    if (!list.length) continue;
    const ul = h("ul", { class: "stale-sweep" });
    for (const c of list) {
      const msg = h("span", { class: "hint", role: "status" });
      const act = async (action, reason) => {
        const res = await send({ type: "resolveCommitment", projectId: p.id, commitmentId: c.id, action, reason });
        if (!res.ok) flash(msg, res.error || "Couldn't save that.", "error");
      };
      const done = h("button", { type: "button", class: "sweep-done" }, "Done");
      done.addEventListener("click", () => act("executed", "Marked executed in the stale-backlog sweep"));
      const week = h("button", { type: "button", class: "sweep-defer-week" }, "Defer 1 week");
      week.addEventListener("click", () => act("defer", inDays(7)));
      const closeIn = h("input", { type: "text", placeholder: "Why it's no longer worth doing", "aria-label": `Reason for closing ${c.id}` });
      const close = h("button", { type: "button", class: "sweep-close" }, "Close");
      close.addEventListener("click", () => closeIn.value.trim() ? act("closed", closeIn.value.trim()) : flash(msg, "Give a reason.", "error"));
      const dateIn = h("input", { type: "date", min: inDays(1), "aria-label": `New due date for ${c.id}` });
      const defer = h("button", { type: "button", class: "sweep-defer" }, "Defer");
      defer.addEventListener("click", () => dateIn.value ? act("defer", dateIn.value) : flash(msg, "Pick a date.", "error"));
      ul.append(h("li", { "data-id": c.id },
        h("div", { class: "sweep-text" }, c.text),
        h("div", { class: "hint" }, `${c.id} · raised in round ${c.round}${c.raised_at ? ` (${dayStr(c.raised_at)})` : ""} · open ${c.age_rounds} rounds` +
          (c.due_date ? ` · was due ${c.due_date}` : "") + (c.suggested_done ? ` · suggested done in round ${c.suggested_done.round}` : "")),
        h("blockquote", { class: "sweep-source" }, c.source_sentence ? `“${c.source_sentence}”` : "no source sentence recorded (from before v0.21)"),
        h("div", { class: "sweep-actions" }, done, week, closeIn, close, dateIn, defer, msg)));
    }
    blocks.push(h("details", { class: "card sweep-project", open: "" },
      h("summary", {}, h("span", { class: "pname" }, p.name), h("span", { class: "stats" }, `${list.length} stale · oldest from round ${list[0].round}`)),
      h("div", { class: "card-body" }, ul)));
  }
  root.replaceChildren(...(blocks.length ? blocks : [h("p", { class: "empty-note" }, "Nothing stale: no commitment has been open for 2 or more rounds.")]));
}

// ------------------------------------------------------------ init

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.debugLog || changes.debug) loadDebug();
  const keys = Object.keys(changes);
  if (keys.some(k => k.startsWith("project:") || k.startsWith("ledger:") ||
                     k === "projectIds" || k === "threadProjects")) { renderProjects(); renderStaleBacklog(); }
  else if (keys.some(k => k.startsWith("events:"))) renderProjects();   // the definition history
});

(async () => {
  await send({ type: "ready" });   // runs the v0.1 -> v0.2 migration if needed
  await loadSettings();
  await loadDebug();
  await renderProjects();
  await renderStaleBacklog();
})();

// ---------------------------------------------------------------- shadow assignment

async function renderShadow() {
  const box = $("shadow");
  if (!box) return;   // the public build has no shadow section
  const records = Object.values((await chrome.storage.local.get(SHADOW_KEY))[SHADOW_KEY] || {})
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const line = basis => {
    const t = shadowTally(records, basis);
    return `Predictions: ${t.predictions} · agreed with you: ${t.agreements} · disagreed: ${t.disagreements} · ` +
      `abstained: ${t.abstentions} (you then chose an existing project ${t.abstainedYouChoseExisting}, a new one ${t.abstainedYouCreatedNew})` +
      (t.failed ? ` · failed calls (not counted): ${t.failed}` : "");
  };
  const refiled = shadowTally(records).refiled;
  const tally = h("div", { class: "shadow-tally" },
    h("p", { class: "shadow-first" }, h("strong", {}, "Against your first choice: "), line("first")),
    h("p", { class: "shadow-latest" }, h("strong", {}, "Against your latest filing: "), line("latest")),
    h("p", { class: "shadow-refiled" }, `Conversations you refiled after the first choice: ${refiled}`));
  const nameOf = (r, id) => r.candidates?.find(c => c.id === id)?.name || "(unknown project)";
  const rows = records.slice(0, 20).map(r => {
    const p = r.prediction;
    const predicted = !p ? `failed: ${r.error || "no answer"}` : p.abstain ? `abstained: ${p.reason}` : nameOf(r, p.projectId);
    const first = shadowChoice(r, "first"), latest = shadowChoice(r, "latest");
    const label = c => c.isNew ? `${c.name} (new)` : c.name;
    const chose = r.refiles?.length ? `${label(first)} → ${label(latest)} (refiled ${String(r.refiles.at(-1).at || "").slice(0, 10)})` : label(first);
    const judge = c => !p ? "" : p.abstain ? "abstain" : (!c.isNew && p.projectId === c.projectId) ? "agree" : "disagree";
    const verdict = r.refiles?.length && judge(first) !== judge(latest) ? `${judge(first)} → ${judge(latest)}` : judge(latest);
    return h("tr", { class: `shadow-${judge(first) || "failed"}${r.refiles?.length ? " shadow-refiled-row" : ""}` },
      h("td", {}, String(r.at || "").slice(0, 10)), h("td", {}, r.title || r.url || ""),
      h("td", {}, predicted, p && p.margin != null ? ` (margin ${p.margin})` : ""), h("td", {}, chose), h("td", {}, verdict),
      h("td", { class: "quote" }, p?.quote ? `“${p.quote}”` : ""));
  });
  box.replaceChildren(tally, records.length
    ? h("table", { class: "shadow-table" },
        h("thead", {}, h("tr", {}, ...["Date", "Conversation", "Predicted", "You chose (first → latest)", "", "Quote"].map(x => h("th", {}, x)))),
        h("tbody", {}, ...rows))
    : h("p", { class: "hint" }, "No new conversations captured since shadow mode was added."));
}
renderShadow();
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && SHADOW_KEY in ch) renderShadow(); });

// ---------------------------------------------------------------- event record

async function renderEventRecord() {
  const all = await chrome.storage.local.get(null);
  const lists = Object.entries(all).filter(([k]) => k.startsWith("events:")).map(([, v]) => v || []);
  const events = lists.flat();
  const outcomes = events.filter(e => OUTCOME_TYPES.includes(e.type)).length;
  const edits = events.filter(e => e.type === "project_edited").length;
  const compacted = events.filter(e => e.compacted).length;
  const kb = Math.round(JSON.stringify(lists).length / 1024);
  $("eventRecord").textContent = `${events.length} events (${events.filter(e => e.type === "verdict").length} verdicts, ${outcomes} outcome events, ${edits} project edits) · ` +
    `${kb} KB of ${Math.round(EVENT_CAP_BYTES / 1024)} KB` + (compacted ? ` · ${compacted} old verdicts compacted` : "") +
    (all.eventsFull ? ` · FULL since ${String(all.eventsFull).slice(0, 10)}: new events are not being recorded` : "");
  $("eventRecord").className = "hint" + (all.eventsFull ? " bad" : "");
}
renderEventRecord();
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && Object.keys(ch).some(k => k.startsWith("events:") || k === "eventsFull")) { renderEventRecord(); renderAccuracy(); }
});

// ---------------------------------------------------------------- check accuracy

async function renderAccuracy() {
  const all = await chrome.storage.local.get(null);
  const events = Object.entries(all).filter(([k]) => k.startsWith("events:")).flatMap(([, v]) => v || []);
  const m = measure(events, MAPPING);
  const a = m.auto;
  const autoLine = `Auto-resolution: ${a.resolutions} resolution${a.resolutions === 1 ? "" : "s"} from content · ` +
    `wrong (reopened) ${a.wrong} · unchallenged ${a.unchallenged} (not counted as right)`;
  const eventsText = r => typeof r.events === "string" ? r.events
    : !r.events.length ? "no scored claims yet"
    : r.events.map(x => `v${x.version}: ${x.claims} claim${x.claims === 1 ? "" : "s"} · right ${x.right} · wrong ${x.wrong} · ` +
      `no outcome ${x.none} (decided ${x.right + x.wrong} of ${x.claims})`).join(" | ");
  const handCell = r => r.hand
    ? h("td", {}, `${r.hand.right} right, ${r.hand.wrong} wrong over ${r.hand.panels} panels, ${r.hand.label}.`,
        h("div", { class: "hint" }, r.hand.known))
    : h("td", {}, "—", r.excludedHand ? h("div", { class: "hint" },
        `The author has a figure (${r.excludedHand.right} right, ${r.excludedHand.wrong} wrong, v${r.excludedHand.version}) but is not counted: ${r.excludedHand.reason}.`) : null);
  const rows = accuracyRows(m);
  $("accuracy").replaceChildren(h("p", { class: "hint" }, `Mapping v${m.mapping}.`), h("p", {}, autoLine),
    h("table", { class: "accuracy" },
      h("thead", {}, h("tr", {}, ...["Check", "State", "By events", "By hand"].map(t => h("th", {}, t)))),
      h("tbody", {}, ...rows.map(r => h("tr", { "data-check": r.id },
        h("td", {}, r.id), h("td", {}, r.state),
        h("td", {}, eventsText(r), r.note ? h("div", { class: "hint" }, r.note) : null),
        handCell(r))))));
}
renderAccuracy();
