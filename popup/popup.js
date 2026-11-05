import { CREDENTIAL_KEY } from "../lib/build_flags.js";
import { K, loadProjects, loadLedger, reportOptsFor } from "../lib/store.js";
import { viewModel } from "../lib/report_model.js";
import { renderReport, fmtDate } from "../lib/report_view.js";

const app = document.getElementById("app");
const footer = document.getElementById("footer");
const picker = document.getElementById("project");

// The project being viewed. Starts as the current tab's conversation project
// (or the last one used); the switcher changes it.
let selectedId = null;

// Tiny DOM helper: h("div", {class: "x"}, child, "text", ...)
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


function send(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => ({ ok: false, error: "Extension unavailable." }));
}

function renderPicker(projects) {
  picker.replaceChildren(...projects.map(p => h("option", { value: p.id, selected: p.id === selectedId }, p.name)));
  picker.hidden = !projects.length;
  picker.disabled = projects.length < 2;
}

// Renders can overlap (initial load + storage changes), so each builds into
// its own fragment and only the newest one is put on screen.
let renderGen = 0;
async function render() {
  const gen = ++renderGen;
  const frag = document.createDocumentFragment();
  try {
    await renderInto(frag);
  } catch (e) {
    // Never show a half-built or blank popup: say what went wrong.
    console.error("[PM] popup render failed:", e);
    frag.append(h("div", { class: "error" }, h("strong", {}, "Popup error: "), String(e?.message || e)));
  }
  if (gen !== renderGen) return;
  // Keep what the user expanded or scrolled across re-renders.
  const goalExpanded = app.querySelector(".goal")?.classList.contains("expanded");
  const hoScroll = app.querySelector(".handoff textarea")?.scrollTop;
  app.replaceChildren(frag);
  if (goalExpanded) app.querySelector(".goal-more")?.click();
  const ta = app.querySelector(".handoff textarea");
  if (ta && hoScroll) ta.scrollTop = hoScroll;
  checkGoalRendered();
}

// Self-check: a stored goal must be visible. If it ever isn't, say so with
// details to send, instead of showing an empty box.
function checkGoalRendered() {
  const block = app.querySelector(".goal");
  if (!block || block.dataset.hasGoal !== "true") return;
  const pre = block.querySelector(".goal-text");
  const r = pre?.getBoundingClientRect();
  const text = (pre?.textContent || "").trim();
  if (text && r && r.height > 0 && getComputedStyle(pre).visibility !== "hidden") return;
  const diag = JSON.stringify({ version: chrome.runtime.getManifest().version, textLength: text.length,
    height: r?.height, display: pre && getComputedStyle(pre).display, color: pre && getComputedStyle(pre).color });
  console.error("[PM] goal did not render", diag);
  send({ type: "log", step: "ERROR popup goal did not render", detail: diag });
  block.append(h("div", { class: "error" }, "The goal didn't display. Please send this to the developer: ", h("code", {}, diag)));
}

async function renderInto(app) {
  const { projects, lastProjectId } = await loadProjects();
  if (!projects.some(p => p.id === selectedId)) selectedId = lastProjectId;
  renderPicker(projects);
  const project = projects.find(p => p.id === selectedId);

  const s = await chrome.storage.local.get([CREDENTIAL_KEY, "lastError", project ? K.undo(project.id) : "_"]);
  footer.hidden = true;

  if (s.lastError) {
    app.append(h("div", { class: "error" },
      h("strong", {}, "Last capture failed"),
      s.lastError.projectName ? ` (${s.lastError.projectName})` : "", ": ", s.lastError.message,
      h("span", { class: "muted" }, ` · ${fmtDate(s.lastError.at)}`)));
  }

  if (!s[CREDENTIAL_KEY]) {
    const btn = h("button", { class: "primary" }, "Add access code");
    btn.addEventListener("click", () => send({ type: "openSetup" }));
    app.append(h("p", {}, "Captures need your access code."), btn);
    return;
  }

  if (!project) {
    app.append(h("p", { class: "muted" },
      "Click ", h("strong", {}, "Capture round"), " under a response on chatgpt.com or claude.ai. You'll name the project then."));
    return;
  }

  // Same model + renderer as the on-page report panel.
  const ledger = await loadLedger(project.id);
  app.append(renderReport(viewModel(project, ledger, undefined, await reportOptsFor(project)), {
    onResolve: (commitmentId, action, reason) =>
      send({ type: "resolveCommitment", projectId: project.id, commitmentId, action, reason }),
    onReview: () => send({ type: "reviewCommitments", projectId: project.id }),
    // Item 18: what the popup showed, so a decline means it was seen.
    onSeen: commitmentId => send({ type: "recordView", projectId: project.id, surface: "popup", seen: [commitmentId] }),
  }));
  if (ledger.rounds.length) send({ type: "recordView", projectId: project.id, surface: "popup" });
  if (!ledger.rounds.length) return;

  footer.hidden = false;
  document.getElementById("undo").disabled = !s[K.undo(project.id)];
}

picker.addEventListener("change", async () => {
  selectedId = picker.value;
  send({ type: "setLastProject", projectId: selectedId });   // badge follows the viewed project
  render();
});

document.getElementById("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

document.getElementById("undo").addEventListener("click", async () => {
  const name = picker.selectedOptions[0]?.textContent || "this project";
  if (!confirm(`Undo the most recent change in “${name}” (its last capture or commitment resolution)?`)) return;
  const res = await send({ type: "undo", projectId: selectedId });
  if (!res?.ok) alert(res?.error || "Undo failed.");
});

// Re-render only for data the popup shows. Debug-log writes arrive many times
// a second while debug mode is on; re-rendering on those collapsed the goal
// section and rebuilt the handoff box under the user.
const RELEVANT = /^(project:|ledger:|undo:)|^(projectIds|lastProjectId|lastError|apiKey|accessCode|graceRounds)$/;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && Object.keys(changes).some(k => RELEVANT.test(k))) render();
});

// Is the content script alive on this tab, and what did it find? Lets you
// diagnose a missing Capture button without opening any console.
async function showPageStatus(tab) {
  const box = document.getElementById("pagestatus");
  if (!tab?.id || !/^https:\/\/(chatgpt\.com|claude\.ai)\//.test(tab.url || "")) return;
  box.hidden = false;
  let r = null;
  try { r = await chrome.tabs.sendMessage(tab.id, { type: "ping" }, { frameId: 0 }); } catch {}
  if (r?.ok) {
    box.className = "pagestatus" + (r.found ? "" : " bad");
    box.textContent = r.found
      ? `This page: ${r.found} response${r.found === 1 ? "" : "s"} found (${r.strategy}), ${r.bars} Capture button${r.bars === 1 ? "" : "s"}.`
      : "This page: Project Manager is running but found no assistant responses. Turn on Debug in Options and send the log.";
    return;
  }
  box.className = "pagestatus bad";
  box.textContent = "This page: Project Manager isn't running here (the tab was probably open before the extension was loaded).";
  const fix = h("button", {}, "Load it now");
  fix.addEventListener("click", async () => {
    fix.disabled = true;
    const res = await send({ type: "injectTab", tabId: tab.id });
    box.className = "pagestatus" + (res?.ok ? "" : " bad");
    box.textContent = res?.ok ? `Loaded. ${res.found} response(s) found (${res.strategy}).` : (res?.error || "Couldn't load. Refresh the tab.");
  });
  box.append(fix);
}

async function init() {
  await send({ type: "ready" });   // runs the v0.1 -> v0.2 migration if needed
  // The host permissions show a chat tab's URL. On any other tab it stays empty.
  let url = "";
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tab?.url || "";
  } catch {}
  showPageStatus(tab);
  const ctx = await send({ type: "captureContext", url });
  selectedId = ctx?.ok ? ctx.projectId : null;
  if (selectedId) send({ type: "setLastProject", projectId: selectedId });
  render();
}

init();
