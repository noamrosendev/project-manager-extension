// Content script for chatgpt.com and claude.ai.
// Injects a capture bar under each finished assistant response. Nothing is
// captured automatically: one click = one round.
//
// Projects are created just in time. Capturing in a conversation that isn't
// filed yet opens an inline "Which project is this?" panel (existing projects,
// or a new one with name / goal / out-of-scope) before extraction runs. Once
// filed, the bar reads "Capture round → <project> ▾" and the name opens a
// picker to refile the conversation.
(() => {
  "use strict";

  // One instance per page, even if the service worker injects us again
  // (it does after an install/update, and when a right-click finds no script).
  if (globalThis.__pmContentLoaded) return;
  globalThis.__pmContentLoaded = true;

  const HOST = location.hostname;
  if (HOST !== "chatgpt.com" && HOST !== "claude.ai") return;
  const VERSION = chrome.runtime.getManifest().version;
  // Marks our UI so an orphaned copy of this script (left behind when the
  // extension is reloaded) never acts on the new copy's elements.
  const INSTANCE = Math.random().toString(36).slice(2, 10);
  // Loaded after the page (into an already-open tab) rather than at page
  // start: the page's key handlers then run before ours and can intercept
  // typing in our panel. Refreshing the tab fixes it.
  const LATE = document.readyState !== "loading";

  // ---------------------------------------------------------------- finding responses
  // Class names on these sites change constantly, so detection is layered:
  // known attributes first, then conversation-turn structure, then a generic
  // fallback that finds blocks of formatted prose anywhere on the page that
  // aren't the composer, navigation, or a user message.

  const q = sel => Array.from(document.querySelectorAll(sel));
  const ASSISTANT_CONTENT = '.markdown, .prose, [class*="markdown"], .font-claude-response, .font-claude-message';

  function isAssistantTurn(t) {
    if (t.querySelector('[data-message-author-role="user"]')) return false;
    if (t.querySelector('[data-message-author-role="assistant"]')) return true;
    const label = t.querySelector(".sr-only, h5, h6")?.textContent || "";
    if (/you said/i.test(label)) return false;
    return Boolean(t.querySelector("p, pre, ol, ul"));
  }

  const STRATEGIES = {
    "chatgpt.com": [
      { name: "role-attribute", find: () => q('[data-message-author-role="assistant"]') },
      { name: "conversation-turn", find: () => q('[data-testid^="conversation-turn"]').filter(isAssistantTurn) },
      // Current markup (Oct 2026) has neither of the above: each reply is a
      // search unit keyed "...:assistant". No length threshold, so short
      // replies are found. It is the same element the prose fallback used to
      // pick (via its "ChatGPT said:" heading), so captured text, and the
      // hashes that recognise earlier captures, are unchanged.
      { name: "search-unit", find: () => q('[data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]') },
    ],
    "claude.ai": [
      { name: "streaming-attribute", find: () => q("[data-is-streaming]") },
      { name: "response-class", find: () => q(".font-claude-response, .font-claude-message") },
    ],
  };

  const PROSE = "p, ul, ol, pre, h1, h2, h3, h4, table, blockquote";
  const EXCLUDE = '[data-pm], nav, aside, header, footer, form, textarea, [contenteditable="true"], [role="dialog"], ' +
    '[role="navigation"], [data-message-author-role="user"], [data-testid*="user-message"], [data-testid*="user_message"]';

  // The message composer sits below the conversation, so prefer the last match.
  function findComposer() {
    return document.querySelector("#prompt-textarea") ||
      q('[contenteditable="true"]').at(-1) || q("textarea").at(-1) || null;
  }

  function outermost(els) {
    return els.filter(e => !els.some(o => o !== e && o.contains(e)));
  }

  function proseBlocks() {
    const root = document.querySelector("main") || document.body;
    if (!root) return [];
    const composer = findComposer();
    const parents = new Set();
    for (const n of root.querySelectorAll(PROSE)) if (n.parentElement) parents.add(n.parentElement);
    const blocks = [...parents].filter(c => {
      if (c.closest(EXCLUDE)) return false;
      if (composer) {
        if (c.contains(composer) || composer.contains(c)) return false;
        // Disclaimers etc. sit below the composer; responses sit above it.
        if (composer.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
      }
      return (c.textContent || "").trim().length >= 40;
    });
    return outermost(blocks);
  }

  const PROSE_STRATEGY = { name: "prose-structure", find: proseBlocks };

  function findMessages() {
    for (const s of [...(STRATEGIES[HOST] || []), PROSE_STRATEGY]) {
      let found = [];
      try { found = s.find(); } catch (e) { reportError(`finding responses (${s.name})`, e, false); }
      found = outermost(found.filter(e => !e.closest("[data-pm]")));
      if (found.length) return { strategy: s.name, found };
    }
    return { strategy: "none", found: [] };
  }

  function contentOf(m) {
    if (m.matches(ASSISTANT_CONTENT)) return m;
    return m.querySelector(ASSISTANT_CONTENT) || m;
  }

  function stopButtonVisible() {
    const b = document.querySelector('[data-testid="stop-button"], button[aria-label*="stop" i], button[data-testid*="stop" i]');
    return Boolean(b && b.offsetParent !== null);
  }

  // Generating? Claude marks it on the message; ChatGPT marks the turn
  // "complete" when done (current markup) or shows a stop button.
  function isStreaming(m, isLast) {
    const flag = m.closest("[data-is-streaming]") || m.querySelector("[data-is-streaming]");
    if (flag) return flag.getAttribute("data-is-streaming") !== "false";
    const turn = m.closest("[data-talvt-turn-state]");
    if (turn) return turn.getAttribute("data-talvt-turn-state") !== "complete";
    return isLast && stopButtonVisible();
  }

  // ---------------------------------------------------------------- logging & visible errors

  let debugOn = false;
  let ctxLoaded = false;
  const earlyLogs = [];

  // Steps go to the service worker console (and Options > Debug) when debug
  // mode is on. Before we know, they're buffered.
  function log(step, detail) {
    if (!ctxLoaded) { earlyLogs.push([step, detail]); return; }
    if (!debugOn) return;
    console.debug("[PM]", step, detail ?? "");
    send({ type: "log", step, detail });
  }

  let lastToast = { text: "", at: 0 };
  function showToast(message) {
    if (message === lastToast.text && Date.now() - lastToast.at < 30000) return;
    lastToast = { text: message, at: Date.now() };
    const { host, ui } = shell();
    const close = el("button", { type: "button", class: "x", "aria-label": "Close", text: "×" });
    ui.append(el("div", { class: "toast", role: "alert" }, el("div", { text: `Project Manager: ${message}` }), close));
    close.addEventListener("click", e => { e.stopPropagation(); host.remove(); });
    (document.body || document.documentElement).append(host);
    setTimeout(() => host.remove(), 15000);
  }

  // Never fail silently: log it, and (unless it's routine) show it on the page.
  function reportError(where, e, toast = true) {
    const message = `${where}: ${e?.message || e}`;
    console.warn("[PM]", message);
    log("ERROR", message);
    if (toast) showToast(message);
  }

  function alive() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  // ---------------------------------------------------------------- keyboard guard
  // Chat sites listen for keys page-wide (e.g. "start typing to focus the
  // composer"). Inside our shadow DOM the event target looks like a plain div,
  // so those handlers would steal keystrokes from the panel's text fields.
  // This runs at document_start, so our capture-phase listener is registered
  // before the site's: keys aimed at our UI are routed to our handler and go
  // no further. Default actions (typing, Tab, Enter-to-submit) still happen.
  const keyHandlers = new WeakMap();   // host element -> (KeyboardEvent) => void
  function ourHost(e) {
    for (const n of e.composedPath()) {
      if (n.nodeType === 1 && n.getAttribute("data-pm") === INSTANCE) return n;
    }
    return null;
  }
  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(type, e => {
      if (!alive()) return;
      const host = ourHost(e);
      if (!host) return;
      if (type === "keydown" && e.key === "Tab") lastTabAt = Date.now();
      if (type === "keydown") {
        // If we were loaded after the page (see LATE), its handlers ran first
        // and may have swallowed Enter: type the line break ourselves.
        const t = e.composedPath()[0];
        if (e.defaultPrevented && e.key === "Enter" && !e.metaKey && !e.ctrlKey && t?.tagName === "TEXTAREA") {
          t.setRangeText("\n", t.selectionStart, t.selectionEnd, "end");
          t.dispatchEvent(new Event("input", { bubbles: true }));
          log("rescued a swallowed Enter in the panel");
        }
        keyHandlers.get(host)?.(e);
      }
      e.stopImmediatePropagation();
    }, true);
  }

  // ---------------------------------------------------------------- focus guard
  // claude.ai keeps its composer focused: page-wide pointer/focus handlers see
  // our shadow-DOM fields as a plain, non-editable div and call
  // composer.focus(), so typing lands in the chat box even though no key event
  // is ever aimed at the page. Two layers:
  //   1. our UI's pointer/focus events are stopped at window capture, before
  //      any page handler sees them (below), and input events from bubbling
  //      (shell());
  //   2. if a panel field loses focus without the user clicking elsewhere,
  //      tabbing away or leaving the window, focus is put straight back.
  let focusOwner = null;          // the panel text field the user is typing in
  let lastOutsidePointer = 0;
  let lastTabAt = 0;
  let restores = [];

  window.addEventListener("pointerdown", e => {
    if (!alive() || ourHost(e)) return;
    lastOutsidePointer = Date.now();
    focusOwner = null;            // the user chose to click elsewhere
  }, true);

  // Bubble-phase stopping alone (shell()) is too late for a page's
  // capture-phase handlers: claude.ai's took focus on every click and on every
  // restore, so the field never kept focus and mouse selection, Cmd+A and
  // Cmd+C didn't work. Window capture runs first. stopPropagation (not
  // Immediate) so our window listeners, e.g. the picker's outside-click, still run.
  for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "focusin", "focusout"]) {
    window.addEventListener(t, e => { if (alive() && ourHost(e)) e.stopPropagation(); }, true);
  }

  function isOurFocus() {
    const a = document.activeElement;
    return a?.nodeType === 1 && a.getAttribute("data-pm") === INSTANCE;
  }

  function guardField(f) {
    f.addEventListener("focus", () => { focusOwner = f; });
    f.addEventListener("blur", () => {
      setTimeout(() => {
        if (focusOwner !== f || !f.isConnected || isOurFocus()) return;
        const now = Date.now();
        if (now - lastOutsidePointer < 800 || now - lastTabAt < 800 || !document.hasFocus()) {
          focusOwner = null;      // the user moved on
          return;
        }
        restores = restores.filter(t => now - t < 1000);
        if (restores.length >= 5) return;   // page keeps grabbing it: stop fighting
        restores.push(now);
        log("page took focus from the panel - restoring");
        f.focus({ preventScroll: true });
      }, 0);
    });
  }

  // ---------------------------------------------------------------- state

  const STABLE_MS = 1200;           // text must stop changing this long before we call it finished
  const state = new WeakMap();      // message element -> { text, since, bar }
  const bars = new Set();           // live bar controllers

  // Project context for this page, from the service worker.
  let ctx = { projects: [], projectId: null, filed: false, isThread: false, hasApiKey: true };
  // Project chosen on a page with no conversation id yet (a brand-new chat).
  // Carried over to the conversation once the site assigns its URL.
  let pageOverride = null;
  let lastUrl = location.href;

  // The extension updated or reloaded under this tab leaves this script
  // orphaned. That is the expected lifecycle, not a failure: no console
  // warning (Chrome counts one as an error on the extensions page); the bars
  // say to reload the page instead. A reload closes an open message channel
  // while this context still looks alive, and invalidates it a moment later,
  // so a failed message is judged after ORPHAN_SETTLE_MS. Still alive then
  // (the worker died with the extension installed): a genuine failure, warned.
  const ORPHAN_SETTLE_MS = 1000;
  function send(msg) {
    return new Promise(resolve => {
      const failed = message => setTimeout(() => {
        if (!alive()) {
          orphan();
          return resolve({ ok: false, orphaned: true, error: ORPHAN_TEXT });
        }
        if (msg.type !== "log") console.warn("[PM] message failed:", msg.type, message);
        resolve({ ok: false, error: "Extension unavailable - reload this tab." });
      }, alive() ? ORPHAN_SETTLE_MS : 0);
      try {
        chrome.runtime.sendMessage(msg, res => {
          const err = chrome.runtime.lastError;
          if (err) failed(err.message);
          else resolve(res || { ok: false, error: "No response from extension." });
        });
      } catch (e) {
        failed(e?.message || String(e));
      }
    });
  }

  // The project this conversation is filed under, or null if it isn't yet.
  function currentProjectId() {
    if (pageOverride && ctx.projects.some(p => p.id === pageOverride)) return pageOverride;
    return ctx.projectId;
  }

  function projectName(id) {
    return ctx.projects.find(p => p.id === id)?.name ?? "";
  }

  async function refreshCtx() {
    const res = await send({ type: "captureContext", url: location.href });
    if (!res.ok) { log("captureContext failed", res.error); return; }
    ctx = res;
    debugOn = Boolean(res.debug);
    if (!ctxLoaded) {
      ctxLoaded = true;
      for (const [st, d] of earlyLogs.splice(0)) log(st, d);
    }
    updatePill();
    if (pageOverride && !ctx.projects.some(p => p.id === pageOverride)) pageOverride = null;
    bars.forEach(b => b.update());
  }

  // Remember the outcome of filing: the service worker keys it by conversation
  // id; on a page without one we hold it here until the URL appears.
  function noteFiling(res) {
    if (res.ok && res.projectId) pageOverride = res.remembered ? null : res.projectId;
  }

  async function fileUnder(id) {
    const res = await send({ type: "setThreadProject", url: location.href, projectId: id });
    noteFiling({ ...res, projectId: id });
    await refreshCtx();
  }

  async function onUrlChange() {
    const carry = pageOverride;
    pageOverride = null;
    await refreshCtx();
    // New chat just got its conversation id: keep the project the user chose,
    // unless this conversation is already filed.
    if (carry && !ctx.filed) await fileUnder(carry);
  }

  // ---------------------------------------------------------------- styles

  const CSS = `
    :host { display: block; margin: 6px 0 2px; }
    * { box-sizing: border-box; }
    .ui { font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: inherit; }
    button { all: unset; box-sizing: border-box; cursor: pointer; font: inherit; color: inherit; }
    button:focus-visible { outline: 2px solid #4a7dff; outline-offset: 2px; }
    button:disabled { cursor: default; opacity: .6; }
    .bar { display: flex; align-items: center; flex-wrap: wrap; row-gap: 4px; }
    .cap, .proj { padding: 3px 10px; border: 1px solid rgba(127,127,127,.45); opacity: .85; }
    .cap { border-radius: 999px 0 0 999px; font-weight: 500; }
    .cap.solo { border-radius: 999px; }
    .proj { border-radius: 0 999px 999px 0; border-left: 0; font-weight: 600;
      max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cap:hover:not(:disabled), .proj:hover:not(:disabled) { opacity: 1; border-color: rgba(127,127,127,.8); }
    .proj:hover:not(:disabled) { border-left: 0; }
    [hidden] { display: none !important; }
    .status { margin-left: 8px; opacity: .85; }
    .status.error { color: #d93025; opacity: 1; }
    .status.v-progress { color: #1f8a4c; font-weight: 600; }
    .status.v-at_risk { color: #c27c0e; font-weight: 600; }
    .status.v-loop { color: #d93025; font-weight: 600; }
    .status.v-deviation { color: #9b59b6; font-weight: 600; }
    .link { text-decoration: underline; margin-left: 6px; }
    .chip { color: inherit; font-weight: inherit; text-decoration: underline dotted; text-underline-offset: 3px; }
    .chip:hover { text-decoration-style: solid; }

    .menu, .panel, .float { background: Canvas; color: CanvasText; border: 1px solid rgba(127,127,127,.5);
      border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.16);
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .menu { position: fixed; z-index: 2147483647; min-width: 200px; max-width: 320px; max-height: 300px;
      overflow: auto; padding: 4px; border-radius: 8px; }
    .menu .head { padding: 4px 10px 6px; font-size: 11px; opacity: .65; }
    .opt { display: flex; gap: 8px; width: 100%; padding: 6px 10px; border-radius: 5px; }
    .opt:hover, .opt:focus-visible { background: rgba(127,127,127,.16); outline: none; }
    .opt .tick { width: 1em; flex: none; }
    .sep { border-top: 1px solid rgba(127,127,127,.3); margin: 4px 0; }
    .opt.danger { color: #d93025; }
    .menu .head.confirm { font-size: 12px; opacity: .9; max-width: 300px; white-space: normal; }

    .panel { margin-top: 8px; padding: 14px; max-width: 520px; }
    .q { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
    .sub { opacity: .7; margin-bottom: 10px; font-size: 12px; }
    .picks { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
    .pick { display: block; padding: 7px 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); }
    .pick:hover, .pick:focus-visible { background: rgba(127,127,127,.12); outline: none; border-color: rgba(127,127,127,.7); }
    .pick.new { font-weight: 600; }
    form label { display: block; font-weight: 600; margin: 10px 0 4px; }
    form label .optional { font-weight: 400; opacity: .6; }
    input, textarea { width: 100%; font: inherit; color: inherit; background: transparent;
      border: 1px solid rgba(127,127,127,.5); border-radius: 6px; padding: 6px 8px; margin: 0; }
    input:focus, textarea:focus { outline: 2px solid #4a7dff; outline-offset: -1px; border-color: transparent; }
    textarea { resize: vertical; min-height: 56px; }
    .hint { font-size: 12px; opacity: .65; margin-top: 4px; }
    .hint.warn { opacity: .85; color: #b26d00; margin: 0 0 4px; }
    .name-note { font-size: 11px; opacity: .6; margin-top: 3px; }
    .draft-note { margin: 10px 0 0; padding: 6px 9px; border-radius: 6px; font-size: 12px; font-weight: 600;
      background: rgba(74,125,255,.12); color: inherit; border-left: 3px solid #4a7dff; }
    .draft-note.loading { font-weight: 400; opacity: .75; }
    textarea.drafted { border-color: #4a7dff; background: rgba(74,125,255,.06); }
    .err { color: #d93025; font-size: 12px; margin-top: 8px; min-height: 0; }
    .actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
    .primary { background: #2f5bd3; color: #fff; padding: 6px 12px; border-radius: 6px; font-weight: 600; }
    .secondary { padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(127,127,127,.45); }
    .kbd { font-size: 11px; opacity: .55; }
    .stale-row { padding: 8px 0; border-top: 1px solid rgba(127,127,127,.25); }
    .stale-row:first-of-type { border-top: 0; }
    .stale-meta { font-size: 11px; opacity: .6; margin: 2px 0 6px; }
    .stale-btns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .secondary.small { padding: 3px 9px; font-size: 12px; }
    .draft-ask { margin-top: 8px; }
    .stale-answer { font-weight: 600; color: #1f8a4c; }
    .stale-answer.err { color: #d93025; font-weight: 400; }

    .float { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(420px, calc(100vw - 32px));
      padding: 12px 14px; max-height: calc(100vh - 32px); overflow: auto; }
    .float .fhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .float .status { margin-left: 0; display: block; }
    .float .panel { box-shadow: none; border: 0; padding: 4px 0 0; margin: 0; }
    .x { font-size: 18px; line-height: 1; padding: 0 4px; opacity: .6; }
    .toast { position: fixed; top: 16px; right: 16px; z-index: 2147483647; max-width: 420px; display: flex; gap: 10px;
      align-items: flex-start; padding: 12px 12px 12px 14px; border-radius: 10px; background: #fbe7e5; color: #8a1c12;
      border: 1px solid #e3a59d; box-shadow: 0 6px 24px rgba(0,0,0,.18); white-space: pre-wrap;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .pill { position: fixed; left: 12px; bottom: 12px; z-index: 2147483646; padding: 4px 10px; border-radius: 999px;
      background: #202430; color: #fff; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .85;
      pointer-events: none; }
  `;

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v === true ? "" : v);
    }
    n.append(...kids.filter(k => k != null));
    return n;
  }

  function shell() {
    const host = el("div", { "data-pm": INSTANCE });
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    const ui = el("div", { class: "ui" });
    root.append(style, ui);
    // Keep our UI's pointer, focus and input events away from the page's
    // handlers (layer 1 of the focus guard).
    for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick",
                     "focusin", "focusout", "input", "beforeinput", "paste", "cut", "copy"]) {
      ui.addEventListener(t, e => e.stopPropagation());
    }
    return { host, root, ui };
  }

  // ---------------------------------------------------------------- the panel

  const GOAL_HINT = "What does done look like? Be specific enough that you could tell whether a given week moved toward it.";
  const OOS_HINT = "Anything you have decided not to do. The manager uses this to flag drift.";

  // "Which project is this?" panel.
  //   mode "capture": pick existing -> onPick(id); new -> onCreate(fields)
  //   mode "file":    straight to the new-project form (from the picker)
  // Returns { node, keydown(e), focus() }.
  // The conversation's title, for pre-filling the project name. Both sites put
  // it in document.title ("Title - Claude"); the active sidebar item is the
  // fallback. Generic titles ("ChatGPT", "New chat") give nothing.
  function conversationTitle() {
    const generic = /^(chatgpt|claude|new chat|new conversation|untitled)$/i;
    let t = (document.title || "").replace(/\s*[-|–—]\s*(Claude|ChatGPT)\s*$/i, "").trim();
    if (!t || generic.test(t)) {
      const a = document.querySelector('nav a[aria-current="page"], [data-testid^="history-item"][aria-current="page"], nav a[data-active="true"]');
      t = (a?.textContent || "").trim();
    }
    return generic.test(t) ? "" : t.replace(/\s+/g, " ").slice(0, 80);
  }

  // mode "capture" | "file"; prefillName: conversation title; draftFrom: the
  // response text the goal/out-of-scope draft is made from (optional).
  function buildPanel({ mode, projects, onPick, onCreate, onCancel, prefillName = "", draftFrom = "" }) {
    const node = el("div", { class: "panel", role: "group", "aria-label": "File this conversation" });
    const uid = Math.random().toString(36).slice(2, 8);

    const nameIn = el("input", { type: "text", id: `pm-n-${uid}`, maxlength: "80", autocomplete: "off" });
    const goalIn = el("textarea", { id: `pm-g-${uid}`, rows: "3" });
    const oosIn = el("textarea", { id: `pm-o-${uid}`, rows: "2" });
    const err = el("div", { class: "err", role: "alert" });
    const submit = el("button", { type: "submit", class: "primary",
      text: mode === "file" ? "Create project" : "Create project and capture" });
    const back = el("button", { type: "button", class: "secondary", text: projects.length && mode === "capture" ? "Back" : "Cancel" });
    const nameNote = el("div", { class: "name-note", hidden: true, text: "From the conversation title." });
    const draftNote = el("div", { class: "draft-note", role: "status", hidden: true });
    const draftBtn = el("button", { type: "button", class: "secondary small draft-btn", text: "Draft goal from this reply" });
    const draftWhy = el("div", { class: "hint draft-why", text: "Optional. Sends this reply and the conversation's title to OpenAI, with your key." });
    const form = el("form", { class: "np", novalidate: true },
      el("label", { for: nameIn.id, text: "Project name" }), nameIn, nameNote,
      draftNote,
      ...(draftFrom ? [el("div", { class: "draft-ask" }, draftBtn, draftWhy)] : []),
      el("label", { for: goalIn.id, text: "What is the goal?" }), goalIn,
      el("div", { class: "hint", text: GOAL_HINT }),
      el("label", { for: oosIn.id }, "What is out of scope? ", el("span", { class: "optional", text: "(optional)" })), oosIn,
      el("div", { class: "hint", text: OOS_HINT }),
      err,
      el("div", { class: "actions" }, submit, back, el("span", { class: "kbd", text: "⌘/Ctrl + Enter" })));

    const picks = el("div", { class: "picks" });
    for (const p of projects) {
      const b = el("button", { type: "button", class: "pick", text: p.name });
      b.addEventListener("click", e => { e.stopPropagation(); onPick(p.id); });
      picks.append(b);
    }
    const newBtn = el("button", { type: "button", class: "pick new", text: "+ New project" });
    picks.append(newBtn);
    const cancel = el("div", { class: "actions" },
      el("button", { type: "button", class: "secondary", text: "Cancel" }));
    cancel.firstChild.addEventListener("click", e => { e.stopPropagation(); onCancel(); });

    // ---- pre-fill: name from the title now, which sends nothing. The goal and
    // out-of-scope draft only when asked for: opening this form makes no call.
    // Never blocks; only fills fields the user hasn't typed in.
    let drafted = { goal: null, oos: null, isGoalDefinition: false };
    let draftConfirmed = false;
    const markEdited = f => { f.classList.remove("drafted"); if (!form.querySelector(".drafted")) draftNote.hidden = true; };
    goalIn.addEventListener("input", () => markEdited(goalIn));
    oosIn.addEventListener("input", () => markEdited(oosIn));
    nameIn.addEventListener("input", () => { nameNote.hidden = true; });
    function startDraft() {
      draftBtn.disabled = true;
      draftNote.className = "draft-note loading";
      draftNote.textContent = "Drafting a goal from this response…";
      draftNote.hidden = false;
      log("draft requested");
      send({ type: "draftProject", text: draftFrom, title: prefillName }).then(res => {
        if (!node.isConnected) return;
        draftBtn.disabled = false;
        let filled = false;
        if (res.ok && res.goal && !goalIn.value.trim()) {
          goalIn.value = res.goal; goalIn.classList.add("drafted"); drafted.goal = res.goal; filled = true;
        }
        if (res.ok) drafted.isGoalDefinition = res.isGoalDefinition === true;
        if (res.ok && res.outOfScope?.length && !oosIn.value.trim()) {
          oosIn.value = res.outOfScope.join("\n"); oosIn.classList.add("drafted"); drafted.oos = oosIn.value; filled = true;
        }
        log("draft " + (res.ok ? (filled ? "filled" : "arrived after the user typed") : "failed"), res.ok ? undefined : res.error);
        if (filled) {
          draftNote.className = "draft-note";
          draftNote.textContent = "Drafted from this conversation - edit before continuing.";
          draftBtn.parentElement.hidden = true;
        } else if (!res.ok || !res.goal) {
          draftNote.className = "draft-note";
          draftNote.textContent = "Couldn't draft a goal from this reply. Try again, or write it yourself.";
        } else {
          draftNote.hidden = true;     // arrived after the user typed: nothing to fill
        }
      });
    }

    const showForm = () => {
      picks.hidden = true;
      cancel.hidden = true;
      form.hidden = false;
      sub.textContent = mode === "file" ? "It will be filed under the new project."
        : projects.length ? "New project" : "You don't have any projects yet. Name this one and say what it's for.";
      if (!nameIn.value && prefillName) { nameIn.value = prefillName; nameNote.hidden = false; }
      nameIn.focus();
      if (nameNote.hidden === false && nameIn.value === prefillName) nameIn.select();   // typing replaces it
    };
    const showPicks = () => {
      picks.hidden = false;
      cancel.hidden = false;
      form.hidden = true;
      sub.textContent = "Its rounds will be judged against that project's goal.";
      picks.querySelector(".pick")?.focus();
    };

    const sub = el("div", { class: "sub" });
    node.append(el("div", { class: "q", text: mode === "file" ? "New project" : "New conversation. Which project is this?" }),
      sub, picks, cancel, form);

    newBtn.addEventListener("click", e => { e.stopPropagation(); showForm(); });
    draftBtn.addEventListener("click", e => { e.stopPropagation(); startDraft(); });
    back.addEventListener("click", e => {
      e.stopPropagation();
      if (projects.length && mode === "capture") showPicks(); else onCancel();
    });
    form.addEventListener("submit", e => {
      e.preventDefault();
      e.stopPropagation();
      const name = nameIn.value.trim();
      const goal = goalIn.value.trim();
      if (!name) { err.textContent = "Give the project a name."; return nameIn.focus(); }
      if (!goal) { err.textContent = "Describe the goal - what done looks like."; return goalIn.focus(); }
      if (projects.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        err.textContent = "A project with that name already exists - pick it from the list instead.";
        return nameIn.focus();
      }
      // A drafted goal nobody read is worse than a vague one: make sure it was seen.
      if (drafted.goal && goal === drafted.goal.trim() && !draftConfirmed) {
        draftConfirmed = true;
        err.textContent = "This goal was drafted for you and hasn't been edited. Check it, then press again to use it as is.";
        return goalIn.focus();
      }
      err.textContent = "";
      // Tell the capture the fields came from this response (see setup check).
      const draft = drafted.goal || drafted.oos ? { fromResponse: true, isGoalDefinition: drafted.isGoalDefinition } : undefined;
      onCreate({ name, goal, outOfScope: oosIn.value.trim(), ...(draft ? { draft } : {}) });
    });
    form.addEventListener("input", () => { err.textContent = ""; draftConfirmed = false; });
    node.addEventListener("click", e => e.stopPropagation());

    const keydown = e => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !form.hidden) { e.preventDefault(); form.requestSubmit(); }
    };

    if (LATE) {
      form.prepend(el("div", { class: "hint warn",
        text: "Tip: if typing here jumps to the chat box, refresh this tab once - the page loaded before Project Manager." }));
    }

    for (const f of [nameIn, goalIn, oosIn]) guardField(f);

    const startOnForm = mode === "file" || !projects.length;
    return { node, keydown, focus: () => (startOnForm ? showForm() : showPicks()) };
  }

  // ---------------------------------------------------------------- capture flow

  const LABEL = { PROGRESS: "Progress", AT_RISK: "At risk", LOOP: "Loop", DEVIATION: "Deviation" };

  // ui: { setBusy(bool, label), setStatus(kind, text, withOptionsLink?), showPanel(panel), hidePanel(), done(res) }
  async function runCapture(ui, text) {
    if (!text) return ui.setStatus("error", "Response is empty.");
    await refreshCtx();
    if (!ctx.hasApiKey) return ui.setStatus("error", "Add your OpenAI API key first.", true);
    const pid = currentProjectId();
    if (pid) return doCapture(ui, text, { projectId: pid });
    ui.setStatus("", "");
    ui.showPanel(buildPanel({
      mode: "capture",
      projects: ctx.projects,
      prefillName: conversationTitle(),
      draftFrom: text,
      onPick: id => doCapture(ui, text, { projectId: id }),
      onCreate: fields => doCapture(ui, text, { newProject: fields }),
      onCancel: () => ui.hidePanel(),
    }));
  }

  // "Still open?" - asked before extraction about commitments that have been
  // open for more than two rounds. One click each; capture proceeds once all
  // are answered. Skip captures straight away; Escape cancels the capture.
  const STALE_ACTIONS = [
    ["Done", "executed", "Confirmed done at capture time"],
    ["Still open", "still_open", ""],
    ["No longer relevant", "closed", "No longer relevant (answered at capture time)"],
  ];
  function buildStalePanel(list, total, projectId, onProceed, onCancel) {
    const node = el("div", { class: "panel stale", role: "group", "aria-label": "Open commitments" });
    const skip = el("button", { type: "button", class: "secondary", text: "Skip and capture" });
    const rows = list.map(c => {
      const answer = el("span", { class: "stale-answer" });
      const btns = STALE_ACTIONS.map(([label]) => el("button", { type: "button", class: "secondary small", text: label }));
      const row = el("div", { class: "stale-row" },
        el("div", { class: "stale-text" }, el("strong", { text: c.id }), ` “${c.text}”`),
        el("div", { class: "stale-meta", text: `open ${c.rounds} rounds${c.substeps ? ` · ${c.substeps} sub-step${c.substeps === 1 ? "" : "s"} logged` : ""}` }),
        el("div", { class: "stale-btns" }, ...btns, answer));
      row.done = false;
      btns.forEach((b, i) => b.addEventListener("click", async e => {
        e.stopPropagation();
        const [label, action, reason] = STALE_ACTIONS[i];
        btns.forEach(x => { x.disabled = true; });
        const res = await send({ type: "resolveCommitment", projectId, commitmentId: c.id, action, reason });
        log("stale commitment answered", { id: c.id, action, ok: res.ok });
        if (!res.ok) {
          btns.forEach(x => { x.disabled = false; });
          answer.className = "stale-answer err";
          answer.textContent = res.error;
          return;
        }
        btns.forEach(x => x.remove());
        answer.className = "stale-answer";
        answer.textContent = `✓ ${label}`;
        row.done = true;
        if (rows.every(r => r.done)) onProceed();
        else rows.find(r => !r.done)?.querySelector("button")?.focus();
      }));
      return row;
    });
    skip.addEventListener("click", e => { e.stopPropagation(); log("stale question skipped"); onProceed(); });
    rows.forEach((r, i) => { r.dataset.id = list[i].id; });
    const more = total > list.length ? `Showing the oldest ${list.length} of ${total}. ` : "";
    node.append(
      el("div", { class: "q", text: "Before capturing: are these still open?" }),
      el("div", { class: "sub", text: `${more}They've been open a while. Answer to keep the ledger current, or skip.` }),
      ...rows,
      el("div", { class: "actions" }, skip, el("span", { class: "kbd", text: "Esc cancels" })));
    node.addEventListener("click", e => e.stopPropagation());
    return {
      node,
      keydown: e => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } },
      focus: () => rows[0]?.querySelector("button")?.focus(),
    };
  }

  // Text of responses in this conversation that were already captured: the
  // service worker matches them to their rounds so reviews can quote them.
  function capturedHistory() {
    return [...bars].filter(b => b.captured && !b.captured.setup && b.host.isConnected && b.msgEl)
      .map(b => ({ text: readText(b.msgEl), user: userTextBefore(b.msgEl) }))
      .filter(h => h.text);   // all of them: the service worker caps and records what it leaves out
  }

  // The user's message just before an assistant response. Execution evidence
  // for "run X in your terminal" is the output the user pastes back.
  // Exact matches only: on claude.ai, [data-testid*="user-message"] also
  // matches the Retry/Edit buttons (user-message-edit, an icon-font glyph),
  // which come after the message and won. ChatGPT's current markup has no
  // author-role attribute; the message is in the user-message bubble.
  const USER_SEL = '[data-message-author-role="user"], [data-testid="user-message"], [data-user-message-bubble="true"]';
  // claude.ai (data-perf-row): only the row directly before the reply counts. A
  // pasted message has no message element, and only a few rows are on the page at
  // once, so "the nearest element above" silently took an earlier message (item 23,
  // the probe's readings of 4 Nov). reason: why nothing or only part was read.
  // ChatGPT keeps the nearest-element rule until a probe reading says otherwise.
  function readUserMessage(msgEl) {
    const own = msgEl.closest("[data-perf-row]");
    if (!own) {
      let found = null;
      for (const u of document.querySelectorAll(USER_SEL)) {
        if (u.contains(msgEl) || msgEl.contains(u)) continue;
        if (u.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) found = u;   // u comes before msgEl
      }
      // Another reply in between means that message answered that reply, not this
      // one. Built only from the reply finder. Nothing here says why the message is
      // missing: the pasted wording waits for a probe reading from this site. A reply
      // the finder splits into several parts would be flagged too: unread, not wrong.
      if (found && findMessages().found.some(r => r !== msgEl && !r.contains(msgEl) && !msgEl.contains(r) &&
        (found.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) && (r.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING))) {
        return { el: null, text: "", reason: null, notAdjacent: true };
      }
      // Whole: the service worker cuts it to size and records the cut.
      return { el: found, text: found ? (found.innerText || found.textContent || "").trim() : "", reason: null };
    }
    const all = [...document.querySelectorAll("[data-perf-row]")];
    const row = all[all.indexOf(own) - 1];
    const at = el => Number(el?.querySelector("[aria-posinset]")?.getAttribute("aria-posinset")) || 0;
    if (!row || !row.matches(HUMAN_ROW_SEL) || (at(row) && at(own) && at(row) !== at(own) - 1)) return { el: null, text: "", reason: "row-missing" };
    const el = row.querySelector('[data-testid="user-message"]');
    const text = el ? (el.innerText || el.textContent || "").trim() : "";
    const card = row.querySelector('[data-testid="file-thumbnail"]');
    const cardKind = card ? (/^\s*pasted/i.test(card.innerText || card.textContent || "") ? "pasted" : "attachment") : null;
    return { el, text, reason: cardKind, partial: Boolean(text && cardKind) };
  }
  function userTextBefore(msgEl) { return readUserMessage(msgEl).text; }
  // What the place of an unread message looked like, by shape; no words are kept.
  // paste: a card. typed: words the reader missed. unknown: neither, or nowhere to look.
  // ChatGPT: no real paste has been read, so a card marked some other way counts as
  // typed: a false alarm, not silence, until a probe reading says otherwise.
  const LOOK_CARD = /(^|[^a-z])(pasted?|attach\w*|file|thumbnail|document)([^a-z]|$)/i;
  function unreadLook(msgEl) {
    const read = readUserMessage(msgEl);
    if (/[^\p{Co}\s]/u.test(read.text)) return null;
    if (read.reason === "pasted" || read.reason === "attachment") return "paste";
    if (read.reason === "row-missing") return "unknown";
    let top;
    const own = msgEl.closest("[data-perf-row]");
    if (own) {
      const all = [...document.querySelectorAll("[data-perf-row]")];
      top = [all[all.indexOf(own) - 1]].filter(Boolean);
    } else {
      const prev = findMessages().found.filter(r => r !== msgEl && !r.contains(msgEl) && !msgEl.contains(r) && (r.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
      if (!prev) return "unknown";   // above the first reply is the whole page, sidebar included
      const inRange = [...document.body.querySelectorAll("*")].filter(el => !el.contains(msgEl) && !msgEl.contains(el) && (el.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        !prev.contains(el) && !el.contains(prev) && (prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.closest("[data-pm]"));
      top = inRange.filter(el => !inRange.includes(el.parentElement));
    }
    let words = false;
    for (const el of top) {
      const c = el.cloneNode(true);
      c.querySelectorAll(".sr-only, button, time, script, style, noscript, template, [data-pm]").forEach(x => x.remove());
      if ([c, ...c.querySelectorAll("*")].some(x => LOOK_CARD.test(x.getAttribute("data-testid") || "") || LOOK_CARD.test(x.getAttribute("aria-label") || "") || LOOK_CARD.test(x.getAttribute("title") || ""))) return "paste";
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "BUTTON", "TIME"].includes(c.tagName) || c.matches(".sr-only")) continue;
      if (/[^\p{Co}\s]/u.test(c.textContent || "")) words = true;
    }
    return words ? "typed" : "unknown";
  }

  // Item 23: what the page exposes about the user's messages, measured at each
  // capture, every message row on the page rather than only the last. Shapes and
  // lengths only, never the words: no text, no aria-label or title values, no
  // attribute values except a data-testid that looks like an identifier. It
  // changes nothing the reader does. test/probe_report.mjs prints what it found.
  //   human-row is the row claude.ai marks data-perf-row="human" (saved real
  //   page, 16 Oct); elsewhere each message element is its own row.
  const HUMAN_ROW_SEL = '[data-perf-row="human"]';
  const CARD_WORD = /paste|attach|file|thumbnail|document/i;
  const safeId = v => (/^[\w-]{1,40}$/.test(v || "") ? v : v ? "(other)" : undefined);
  const chars = el => (el?.innerText || "").trim().length;
  function probeRow(row, detailed) {
    const readers = row.matches(USER_SEL) ? [row] : [...row.querySelectorAll(USER_SEL)];
    const heading = row.querySelector("h1, h2, h3, .sr-only");
    const cards = [], longAttrs = [], skeleton = [];
    for (const el of row.querySelectorAll("*")) {
      const testid = el.getAttribute("data-testid"), label = el.getAttribute("aria-label"), title = el.getAttribute("title");
      const hit = [testid, label, title, typeof el.className === "string" ? el.className : ""].map(v => CARD_WORD.exec(v || "")?.[0]?.toLowerCase()).find(Boolean);
      if (hit && cards.length < 12) cards.push({ tag: el.tagName.toLowerCase(), testid: safeId(testid), role: el.getAttribute("role") || undefined, hit,
        textChars: chars(el), hiddenChars: (el.textContent || "").trim().length, labelChars: label?.length, titleChars: title?.length,
        saysPasted: /^\s*pasted/i.test(`${el.innerText || ""}|${label || ""}|${title || ""}`) });
      for (const a of el.attributes) {
        if (a.value.length > 200 && !["class", "style", "d"].includes(a.name) && longAttrs.length < 10) longAttrs.push({ tag: el.tagName.toLowerCase(), attr: a.name, chars: a.value.length });
      }
      if (detailed && skeleton.length < 40 && (testid || el.getAttribute("role") || ["BUTTON", "IMG", "A", "PRE", "TEXTAREA", "IFRAME"].includes(el.tagName))) {
        skeleton.push(`${el.tagName.toLowerCase()}${testid ? `[${safeId(testid)}]` : ""}${el.getAttribute("role") ? `(${el.getAttribute("role")})` : ""}:${chars(el)}`);
      }
    }
    return {
      posinset: Number(row.querySelector("[aria-posinset]")?.getAttribute("aria-posinset")) || undefined,
      rowChars: chars(row), rowHiddenChars: (row.textContent || "").trim().length,
      readers: readers.length, readerChars: readers.reduce((n, r) => n + chars(r), 0),
      headingChars: heading ? (heading.textContent || "").trim().length : undefined,
      cards, longAttrs,
      ...(detailed ? { skeleton } : {}),
    };
  }
  // Sites without message rows: what lies between the previous reply and this one,
  // by shape. A message with no message element is invisible to the rest of the
  // probe, and this is where a reading of a ChatGPT paste will come from.
  function probeBetweenReplies(msgEl) {
    if (msgEl.closest("[data-perf-row]")) return undefined;
    const prev = findMessages().found.filter(r => r !== msgEl && !r.contains(msgEl) && !msgEl.contains(r) && (r.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
    const inRange = [...document.body.querySelectorAll("*")].filter(el => !el.contains(msgEl) && !msgEl.contains(el) && (el.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING) &&
      (!prev || (!prev.contains(el) && !el.contains(prev) && (prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))) && !el.closest("[data-pm]"));
    const top = inRange.filter(el => !inRange.includes(el.parentElement));
    const cards = [], skeleton = [];
    for (const el of inRange) {
      const testid = el.getAttribute("data-testid"), label = el.getAttribute("aria-label"), title = el.getAttribute("title");
      const hit = [testid, label, title, typeof el.className === "string" ? el.className : ""].map(v => CARD_WORD.exec(v || "")?.[0]?.toLowerCase()).find(Boolean);
      if (hit && cards.length < 12) cards.push({ tag: el.tagName.toLowerCase(), testid: safeId(testid), role: el.getAttribute("role") || undefined, hit, textChars: chars(el),
        hiddenChars: (el.textContent || "").trim().length, saysPasted: /^\s*pasted/i.test(`${el.innerText || ""}|${label || ""}|${title || ""}`) });
      if (skeleton.length < 40 && (testid || el.getAttribute("role") || ["BUTTON", "IMG", "A", "PRE", "TEXTAREA", "IFRAME"].includes(el.tagName))) {
        skeleton.push(`${el.tagName.toLowerCase()}${testid ? `[${safeId(testid)}]` : ""}${el.getAttribute("role") ? `(${el.getAttribute("role")})` : ""}:${chars(el)}`);
      }
    }
    return { readers: inRange.filter(el => el.matches(USER_SEL)).length, textChars: top.reduce((n, el) => n + chars(el), 0), hiddenChars: top.reduce((n, el) => n + (el.textContent || "").trim().length, 0), cards, skeleton };
  }

  // Item 23, identity: a short hash of a message's first 200 non-space
  // characters, so "the same message?" can be asked without storing words.
  // Whitespace is left out because the page's text and the stored text space
  // differently. The service worker hashes stored text the same way.
  async function messageId(t) {
    const s = String(t || "").replace(/\s+/g, "").slice(0, 200);
    if (!s) return "";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf).slice(0, 6), b => b.toString(16).padStart(2, "0")).join("");
  }
  // A row's own words, without the accessible heading, the buttons and the time.
  function rowWords(row) {
    const c = row.cloneNode(true);
    c.querySelectorAll(".sr-only, button, time, [data-pm]").forEach(x => x.remove());   // <time>: "2 minutes ago" changes
    return c.textContent || "";
  }
  async function rowIds(row) {
    const readers = row.matches(USER_SEL) ? [row] : [...row.querySelectorAll(USER_SEL)];
    const heading = row.querySelector("h1, h2, h3, .sr-only");
    return {
      readerId: await messageId(readers.map(r => r.innerText || r.textContent || "").join("")),
      rowId: await messageId(rowWords(row)),
      headingId: await messageId((heading?.textContent || "").replace(/^\s*you said:\s*/i, "")),
    };
  }
  async function probeUserRows(msgEl) {
    try {
      const humanRows = [...document.querySelectorAll(HUMAN_ROW_SEL)];
      const rows = humanRows.length ? humanRows : [...document.querySelectorAll(USER_SEL)];
      const precedes = el => !el.contains(msgEl) && !msgEl.contains(el) && Boolean(el.compareDocumentPosition(msgEl) & Node.DOCUMENT_POSITION_FOLLOWING);
      const target = rows.filter(precedes).at(-1) || null;
      // The element the reader takes its text from, found the way it finds it.
      const readEl = readUserMessage(msgEl).el;
      const readRow = readEl ? (readEl.closest(HUMAN_ROW_SEL) || readEl) : null;
      const shown = rows.slice(-40);
      const described = await Promise.all(shown.map(async row => {
        const quick = probeRow(row, false);
        const odd = !quick.readers || !quick.readerChars || quick.cards.length > 0;
        return { ...(odd || row === target ? probeRow(row, true) : quick), ...(await rowIds(row)), odd, target: row === target };
      }));
      const targetIds = target ? await rowIds(target) : null;
      const readId = await messageId(readEl ? (readEl.innerText || readEl.textContent || "") : "");
      // Each reply on the page with the row just before it: the service worker
      // holds these against what the rounds stored, which reaches older rounds.
      const pairs = await Promise.all([...bars].filter(b => b.host.isConnected && b.msgEl).slice(-40).map(async b => {
        const before = rows.filter(r => !r.contains(b.msgEl) && !b.msgEl.contains(r) && (r.compareDocumentPosition(b.msgEl) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
        const reply = await messageId(readText(b.msgEl));
        // No message directly before this reply: the nearest one above is another's.
        if (readUserMessage(b.msgEl).notAdjacent) return { reply, noDirectMessage: true };
        return { reply, ...(before ? await rowIds(before) : { rowMissing: true }) };
      }));
      return {
        rowSource: humanRows.length ? "human-row" : "reader",
        rowsOnPage: rows.length, rowsLeftOut: rows.length - shown.length,
        // aria-setsize against rows present says whether older rows are unmounted.
        setsize: Number(document.querySelector("[aria-setsize]")?.getAttribute("aria-setsize")) || undefined,
        replyPosinset: Number(msgEl.closest("[data-perf-row]")?.querySelector("[aria-posinset]")?.getAttribute("aria-posinset")) || undefined,
        targetFound: Boolean(target),
        // The reader would read a different, earlier message than the one just before this reply.
        staleRead: Boolean(target && readRow && readRow !== target),
        readerChars: chars(readEl),
        // What the reader takes, against the message actually before this reply.
        readId, targetIds,
        readIsTarget: Boolean(targetIds && readId && (readId === targetIds.readerId || readId === targetIds.rowId)),
        rows: described,
        betweenReplies: probeBetweenReplies(msgEl),
        pairs,
      };
    } catch (e) {
      return { error: String(e?.message || e).slice(0, 200) };
    }
  }

  async function doCapture(ui, text, choice) {
    // Asking before a capture is opt-in (Options > Checks); by default stale
    // commitments just age and are listed in the popup and panel.
    if (ctx.askStale && choice.projectId && !choice.force && !choice.staleAsked) {
      const st = await send({ type: "staleCommitments", projectId: choice.projectId });
      if (st.ok && st.list?.length) {
        log("asking about stale commitments", st.list.map(c => c.id));
        ui.setStatus("", "");
        ui.showPanel(buildStalePanel(st.list, st.total ?? st.list.length, choice.projectId,
          () => doCapture(ui, text, { ...choice, staleAsked: true }),
          () => ui.hidePanel()));
        return;
      }
    }
    ui.setBusy(true, choice.newProject ? `Creating “${choice.newProject.name}” and capturing…` : "");
    ui.hidePanel();
    const res = await send({
      type: "capture", text, site: location.hostname, url: location.href, title: document.title,
      userText: ui.userText ?? "", userCount: document.querySelectorAll(USER_SEL).length,
      userProbe: await ui.userProbe,
      userRead: ui.userRead,
      history: capturedHistory(), ...choice,
    });
    noteFiling(res);
    await refreshCtx();     // labels everywhere pick up the (new) filing
    ui.setBusy(false);
    ui.done(res);
  }

  function statusFor(res) {
    const head = res.status === "duplicate"
      ? `Already captured${res.round ? ` as round ${res.round}` : ""}`
      : (res.round ? `Round ${res.round}` : "Captured");
    // Proposals only (v0.34.0): nothing is resolved until a click confirms it.
    const done = (res.suggested || []).filter(x => !x.superseded).map(x => x.id), dropped = (res.suggested || []).filter(x => x.superseded).map(x => x.id);
    const resolved = (done.length ? ` · done? ${done.join(", ")}` : "") + (dropped.length ? ` · superseded? ${dropped.join(", ")}` : "") +
      (res.attached ? ` · ${res.attached.kind === "SAME" ? "same as" : "sub-step of"} ${res.attached.parentId}` : "") +
      (res.reviewed?.length ? ` · re-checked: ${res.reviewed.map(r => `${r.id} ${r.status === "SUPERSEDED" ? "superseded" : "done"}${r.proposed ? "?" : ""}`).join(", ")}` : "") +
      (res.skipped === "confirmation" ? " · waiting on your input, not a commitment" : "") +
      (res.userMissing ? ` · ${res.userNote} - terminal steps won't resolve` : "") +
      (res.userPartial ? ` · ${res.userNote}` : "") +
      (res.definitionWarnings ? ` · ${res.definitionWarnings} out-of-scope rule warning${res.definitionWarnings === 1 ? "" : "s"}, see Options` : "");
    return {
      kind: res.verdict ? `v-${res.verdict.toLowerCase()}` : "",
      text: head + (res.verdict ? ` · ${LABEL[res.verdict] || res.verdict}` : "") + resolved,
    };
  }

  // ---------------------------------------------------------------- report panel
  // The verdict detail behind a capture chip. Same data model as the popup
  // (lib/report_model.js, built by the service worker) and the same renderer
  // and styles (lib/report_view.js, lib/ui.css, lib/report.css), so the two
  // stay in sync.

  let viewModule = null;
  function loadView() {
    return (viewModule ??= import(chrome.runtime.getURL("lib/report_view.js"))
      .catch(e => { viewModule = null; throw e; }));
  }
  let cssText = null;
  function loadCss() {
    return (cssText ??= Promise.all(["lib/ui.css", "lib/report.css"].map(f =>
      fetch(chrome.runtime.getURL(f)).then(r => r.text()))).then(parts => parts.join("\n"))
      .catch(e => { cssText = null; throw e; }));
  }

  const PANEL_CSS = `
    :host { display: block; margin-top: 8px; background: transparent; }
    .rp { max-width: 560px; max-height: 70vh; overflow: auto; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.16);
      padding: 0 14px 14px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: left; }
    .rp-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between;
      gap: 8px; padding: 10px 0 6px; background: var(--bg); }
    .rp-head strong { font-size: 13px; }
    .rp-x { border: 0; background: none; padding: 0 4px; font-size: 18px; line-height: 1; color: var(--muted); cursor: pointer; }
    .rp .error { margin-top: 4px; }
  `;

  // Returns { host, show(projectId, round?) }. round omitted = latest.
  function makeReportPanel(onClose) {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    const title = el("strong", { text: "Project Manager" });
    const close = el("button", { type: "button", class: "rp-x", "aria-label": "Close verdict", text: "×" });
    const body = el("div");
    const box = el("div", { class: "rp", role: "region", "aria-label": "Project Manager verdict" },
      el("div", { class: "rp-head" }, title, close), body);
    root.append(style, box);
    close.addEventListener("click", e => { e.stopPropagation(); onClose(); });
    box.addEventListener("click", e => e.stopPropagation());

    async function show(projectId, round) {
      body.replaceChildren(el("p", { class: "muted", text: "Loading…" }));
      log("report panel: open", { projectId, round });
      try {
        const [css, view, res] = await Promise.all([loadCss(), loadView(), send({ type: "reportView", projectId, round })]);
        style.textContent = css + PANEL_CSS;
        if (!res.ok) throw new Error(res.error);
        title.textContent = res.vm.projectName || "Project Manager";
        body.replaceChildren(view.renderReport(res.vm, {
          onShowLatest: () => show(projectId),
          guardField,
          onReview: async () => {
            const r = await send({ type: "reviewCommitments", projectId, history: capturedHistory() });
            log("re-check from page", { ok: r.ok, changed: r.changed?.length });
            if (r.ok) show(projectId, round);
            return r;
          },
          onResolve: async (commitmentId, action, reason) => {
            const r = await send({ type: "resolveCommitment", projectId, commitmentId, action, reason });
            log("commitment resolved from page", { commitmentId, action, ok: r.ok });
            if (r.ok) show(projectId, round);
            return r;
          },
          // Item 18: what the panel showed, so a decline means it was seen.
          onSeen: commitmentId => send({ type: "recordView", projectId, surface: "page", seen: [commitmentId] }),
        }));
        send({ type: "recordView", projectId, surface: "page" });
      } catch (e) {
        style.textContent ||= PANEL_CSS;
        body.replaceChildren(el("p", { class: "error", text: `Couldn't show the verdict: ${e?.message || e}` }));
        reportError("report panel", e, false);
      }
    }
    return { host, show };
  }

  // "Round 5 · Progress" as a button that opens the report panel.
  function makeChip(res, prefix, onClick) {
    const s = statusFor(res);
    const chip = el("button", { type: "button", class: "chip", "aria-expanded": "false",
      title: "Show the verdict, checks, commitments and handoff for this round", text: prefix + s.text });
    chip.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return { chip, kind: s.kind };
  }

  // ---------------------------------------------------------------- inline bar

  function makeBar(msgEl) {
    const { host, root, ui } = shell();
    const cap = el("button", { type: "button", class: "cap", title: "Project Manager: count this response as one round" });
    const proj = el("button", { type: "button", class: "proj", "aria-haspopup": "listbox", "aria-expanded": "false", title: "Change project" });
    const status = el("span", { class: "status", role: "status" });
    const slot = el("div");
    const menu = el("div", { class: "menu", role: "listbox", "aria-label": "File under project", hidden: true });
    ui.append(el("div", { class: "bar" }, cap, proj, status), slot, menu);

    let panel = null;
    let busy = false;

    const bar = {
      host,
      msgEl,
      captured: null,   // { projectName, projectId, round, verdict, setup } once filed in a ledger
      update() {
        if (this.captured) {
          cap.textContent = this.captured.setup ? "Setup ✓" : "Captured ✓";
          cap.disabled = false;
          cap.title = "Show the verdict for this round";
          cap.classList.remove("solo");
          proj.hidden = false;
          proj.disabled = false;
          proj.textContent = this.captured.projectName;
          proj.title = "This round is in this project. Click to refile, unfile or remove.";
          return;
        }
        const pid = currentProjectId();
        cap.disabled = busy;
        cap.title = "Project Manager: count this response as one round";
        if (busy) cap.textContent = "Capturing…";
        else cap.textContent = pid ? "Capture round →" : "Capture round";
        cap.classList.toggle("solo", !pid);
        proj.hidden = !pid;
        proj.disabled = busy;
        proj.title = "Change project";
        proj.textContent = pid ? `${projectName(pid)} ▾` : "";
      },
    };

    function setStatus(kind, text, withOptionsLink) {
      status.className = "status" + (kind ? ` ${kind}` : "");
      status.textContent = text;
      if (withOptionsLink) {
        const a = el("button", { type: "button", class: "link", text: "Open Options" });
        a.addEventListener("click", e => { e.stopPropagation(); send({ type: "openOptions" }); });
        status.append(a);
      }
    }

    function markCaptured(res) {
      if (res.setup || res.status === "setup") return markSetup(res);
      bar.captured = { projectName: res.projectName || "", projectId: res.projectId, round: res.round, verdict: res.verdict };
      closeMenu();
      hidePanel();
      closeReport();
      bar.update();
      const { chip, kind } = makeChip(res, "", toggleReport);
      setStatus(kind, "");
      status.append(chip);
    }
    bar.markCaptured = markCaptured;

    // ---- report panel (verdict detail for this round)
    let reportPanel = null;
    function setExpanded(open) {
      cap.setAttribute("aria-expanded", String(open));
      status.querySelector(".chip")?.setAttribute("aria-expanded", String(open));
    }
    function closeReport() {
      if (!reportPanel) return;
      reportPanel.host.remove();
      reportPanel = null;
      setExpanded(false);
    }
    function toggleReport() {
      if (reportPanel) { closeReport(); cap.focus(); return; }
      if (!bar.captured?.projectId) return;
      closeMenu();
      reportPanel = makeReportPanel(() => { closeReport(); cap.focus(); });
      slot.append(reportPanel.host);
      setExpanded(true);
      // Setup captures have no round of their own: show the project's latest.
      reportPanel.show(bar.captured.projectId, bar.captured.setup ? undefined : bar.captured.round);
    }

    // The response was the goal being defined: recorded, not counted.
    function markSetup(res) {
      bar.captured = { projectName: res.projectName || "", projectId: res.projectId, setup: true };
      closeReport();
      closeMenu();
      hidePanel();
      bar.update();
      setStatus("", "Goal definition - recorded as setup, not counted as a round.");
      const again = el("button", { type: "button", class: "link", text: "Count it as a round" });
      again.addEventListener("click", e => {
        e.stopPropagation();
        bar.captured = null;
        closeReport();
        log("setup overridden by user");
        doCapture(flowUI, readText(msgEl), { projectId: res.projectId, force: true });
      });
      status.append(again);
    }

    function showPanel(p) {
      closeMenu();
      panel = p;
      slot.replaceChildren(p.node);
      p.focus();
    }
    function hidePanel() {
      if (!panel) return;
      panel = null;
      slot.replaceChildren();
      if (!bar.captured) cap.focus();
    }

    const flowUI = {
      get userText() { return userTextBefore(msgEl); },
      get userProbe() { return probeUserRows(msgEl); },
      get userRead() { const { reason, partial } = readUserMessage(msgEl); return { reason, partial, looked: unreadLook(msgEl) }; },
      setBusy(b, label) { busy = b; bar.update(); if (b) setStatus("", label || ""); },
      setStatus,
      showPanel,
      hidePanel,
      done(res) {
        if (!res.ok) {
          bar.update();
          cap.textContent = currentProjectId() ? "Retry capture →" : "Retry capture";
          setStatus("error", res.error);
        } else {
          markCaptured(res);
        }
      },
    };

    // ---- picker (refile this conversation)
    function onOutside(e) {
      if (!e.composedPath().includes(host)) closeMenu();
    }
    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      proj.setAttribute("aria-expanded", "false");
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    }
    function openMenu() {
      const cur = currentProjectId();
      menu.replaceChildren(el("div", { class: "head",
        text: ctx.isThread ? "File this conversation under" : "File under (this page)" }));
      for (const p of ctx.projects) {
        const b = el("button", { type: "button", class: "opt", role: "option", "aria-selected": String(p.id === cur) },
          el("span", { class: "tick", text: p.id === cur ? "✓" : "" }), el("span", { text: p.name }));
        b.addEventListener("click", async e => {
          e.stopPropagation();
          closeMenu();
          proj.focus();
          await fileUnder(p.id);
        });
        menu.append(b);
      }
      const nb = el("button", { type: "button", class: "opt", role: "option", "aria-selected": "false" },
        el("span", { class: "tick", text: "+" }), el("span", { text: "New project…" }));
      nb.addEventListener("click", e => {
        e.stopPropagation();
        closeMenu();
        showPanel(buildPanel({
          mode: "file",
          projects: ctx.projects,
          prefillName: conversationTitle(),
          draftFrom: readText(msgEl),
          onPick: () => {},
          onCreate: async fields => {
            const res = await send({ type: "createProject", url: location.href, ...fields });
            if (!res.ok) return setStatus("error", res.error);
            noteFiling(res);
            hidePanel();
            await refreshCtx();
            setStatus("", `Filed under “${fields.name}”.`);
          },
          onCancel: hidePanel,
        }));
      });
      menu.append(el("div", { class: "sep" }), nb);

      // Unfile: only when the conversation is filed. Remove: the conversation's
      // project, or for a captured bar, the project its round went into.
      const extra = [];
      if (cur) {
        const unfile = el("button", { type: "button", class: "opt", role: "option", "aria-selected": "false" },
          el("span", { class: "tick", text: "↺" }), el("span", { text: "Unfile this conversation" }));
        unfile.addEventListener("click", async e => {
          e.stopPropagation();
          closeMenu();
          const res = await send({ type: "unfileThread", url: location.href });
          pageOverride = null;
          await refreshCtx();
          setStatus(res.ok ? "" : "error", res.ok ? "Unfiled. The next capture here will ask which project." : res.error);
        });
        extra.push(unfile);
      }
      const phaseId = cur || bar.captured?.projectId;
      const phaseOf = ctx.projects.find(p => p.id === phaseId)?.phase;
      if (phaseId && phaseOf) {
        const waiting = phaseOf === "WAITING";
        const ph = el("button", { type: "button", class: "opt", role: "option", "aria-selected": "false" },
          el("span", { class: "tick", text: waiting ? "▶" : "⏸" }),
          el("span", { text: waiting ? `Set “${projectName(phaseId)}” to active` : `Set “${projectName(phaseId)}” to waiting (accumulating data)` }));
        ph.addEventListener("click", async e => {
          e.stopPropagation();
          closeMenu();
          const res = await send({ type: "setPhase", projectId: phaseId, phase: waiting ? "ACTIVE" : "WAITING" });
          await refreshCtx();
          setStatus(res.ok ? "" : "error", res.ok
            ? (res.phase === "WAITING" ? "Waiting phase: repeated shapes and few artefacts won't be penalised." : "Active phase.")
            : res.error);
        });
        extra.push(ph);
      }
      const removeId = cur || bar.captured?.projectId;
      const removeName = projectName(removeId);
      if (removeId && removeName) {
        const remove = el("button", { type: "button", class: "opt danger", role: "option", "aria-selected": "false" },
          el("span", { class: "tick", text: "×" }), el("span", { text: `Remove “${removeName}”…` }));
        remove.addEventListener("click", e => {
          e.stopPropagation();
          confirmRemove(removeId, removeName);
        });
        extra.push(remove);
      }
      if (extra.length) menu.append(el("div", { class: "sep" }), ...extra);
      menu.hidden = false;
      proj.setAttribute("aria-expanded", "true");
      // Fixed positioning escapes overflow:hidden chat containers.
      const r = proj.getBoundingClientRect();
      const mh = menu.offsetHeight;
      const below = r.bottom + 4 + mh <= window.innerHeight;
      menu.style.top = `${below ? r.bottom + 4 : Math.max(4, r.top - 4 - mh)}px`;
      menu.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4))}px`;
      (menu.querySelector('[aria-selected="true"]') || menu.querySelector(".opt"))?.focus();
      window.addEventListener("pointerdown", onOutside, true);
      window.addEventListener("scroll", closeMenu, true);
      window.addEventListener("resize", closeMenu);
    }
    // Inline confirmation inside the menu, so nothing is deleted by one click.
    function confirmRemove(id, name) {
      const rounds = ctx.projects.find(p => p.id === id)?.rounds ?? 0;
      const yes = el("button", { type: "button", class: "opt danger", text: "Delete project" });
      const no = el("button", { type: "button", class: "opt", text: "Cancel" });
      menu.replaceChildren(
        el("div", { class: "head confirm", text: `Delete “${name}” and its ${rounds} round${rounds === 1 ? "" : "s"}? ` +
          "Conversations filed under it will ask for a project again. This can't be undone." }),
        yes, no);
      no.addEventListener("click", e => { e.stopPropagation(); closeMenu(); proj.focus(); });
      yes.addEventListener("click", async e => {
        e.stopPropagation();
        closeMenu();
        const res = await send({ type: "deleteProject", projectId: id });
        pageOverride = null;
        await refreshCtx();
        setStatus(res.ok ? "" : "error", res.ok ? `Removed “${name}”.` : res.error);
      });
      no.focus();
    }

    function menuKey(e) {
      const opts = [...menu.querySelectorAll(".opt")];
      const i = opts.indexOf(root.activeElement);
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); proj.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); opts[(i + 1) % opts.length]?.focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); opts[(i - 1 + opts.length) % opts.length]?.focus(); }
      else if (e.key === "Tab") closeMenu();
    }

    keyHandlers.set(host, e => {
      if (!menu.hidden) menuKey(e);
      else if (panel) panel.keydown(e);
      else if (reportPanel && e.key === "Escape") { e.preventDefault(); closeReport(); cap.focus(); }
    });

    proj.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      menu.hidden ? openMenu() : closeMenu();
    });

    cap.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (bar.captured) return toggleReport();   // "Captured ✓" / "Setup ✓" open the verdict
      if (panel) return panel.focus();
      log("capture clicked", { chars: readText(msgEl).length });
      runCapture(flowUI, readText(msgEl)).catch(err => {
        busy = false;
        bar.update();
        setStatus("error", String(err?.message || err));
        reportError("capture", err);
      });
    });

    bar.orphan = () => {
      host.setAttribute("data-pm-orphaned", "");
      closeMenu();
      closeReport();
      const reload = el("button", { type: "button", class: "link", text: "Reload page" });
      reload.addEventListener("click", e => { e.stopPropagation(); location.reload(); });
      const text = busy
        ? "Project Manager was updated or reloaded before this capture finished. Reload this page to capture again."
        : ORPHAN_TEXT;
      ui.querySelector(".bar").replaceChildren(el("span", { class: "status error", role: "status", text }), reload);
    };

    bar.update();
    return bar;
  }

  // ---------------------------------------------------------------- floating panel (right-click capture)

  let floating = null;
  function captureSelection(text) {
    log("captureSelection: building floating panel", { chars: (text || "").length });
    floating?.host.remove();
    const { host, ui } = shell();
    const status = el("div", { class: "status", role: "status" });
    const slot = el("div");
    const close = el("button", { type: "button", class: "x", "aria-label": "Close", text: "×" });
    ui.append(el("div", { class: "float" },
      el("div", { class: "fhead" }, el("strong", { text: "Project Manager" }), close), status, slot));
    (document.body || document.documentElement).append(host);
    let panel = null;
    const dismiss = () => { host.remove(); if (floating?.host === host) floating = null; };
    close.addEventListener("click", e => { e.stopPropagation(); dismiss(); });
    floating = { host };

    const setStatus = (kind, t, withOptionsLink) => {
      status.className = "status" + (kind ? ` ${kind}` : "");
      status.textContent = t;
      if (withOptionsLink) {
        const a = el("button", { type: "button", class: "link", text: "Open Options" });
        a.addEventListener("click", e => { e.stopPropagation(); send({ type: "openOptions" }); });
        status.append(a);
      }
    };
    keyHandlers.set(host, e => {
      if (panel) panel.keydown(e);
      else if (e.key === "Escape") dismiss();
    });

    runCapture({
      setBusy(b, label) { if (b) setStatus("", label || "Capturing selection…"); },
      setStatus,
      showPanel(p) { panel = p; slot.replaceChildren(p.node); p.focus(); },
      hidePanel() {
        const wasOpen = Boolean(panel);
        panel = null;
        slot.replaceChildren();
        if (wasOpen && !status.textContent) dismiss();   // cancelled before capturing
      },
      done(res) {
        if (!res.ok) return setStatus("error", res.error);
        if (res.status === "setup") {
          setStatus("", `${res.projectName}: goal definition - recorded as setup, not counted as a round.`);
          return;
        }
        let report = null;
        const { chip, kind } = makeChip(res, `${res.projectName}: `, () => {
          if (report) { report.host.remove(); report = null; chip.setAttribute("aria-expanded", "false"); return; }
          report = makeReportPanel(() => { report.host.remove(); report = null; chip.setAttribute("aria-expanded", "false"); });
          slot.replaceChildren(report.host);
          chip.setAttribute("aria-expanded", "true");
          report.show(res.projectId, res.round);
        });
        setStatus(kind, "");
        status.append(chip);
        setTimeout(() => { if (!panel && !report) dismiss(); }, 8000);
      },
    }, (text || "").trim()).catch(err => {
      setStatus("error", String(err?.message || err));
      reportError("right-click capture", err);
    });
  }

  // Every request from the service worker gets a reply, so it can tell
  // "page script missing" apart from "page script failed".
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!alive()) return false;
    try {
      switch (msg?.type) {
        case "ping":
          sendResponse({ ok: true, version: VERSION, url: location.href, ...diag });
          break;
        case "projectsChanged":
          refreshCtx();
          break;
        case "captureSelection":
          log("captureSelection received", { chars: msg.text?.length });
          captureSelection(msg.text);
          sendResponse({ ok: true });
          break;
        case "testError":
          throw new Error("Test error. This is how Project Manager reports a problem on the page.");
      }
    } catch (e) {
      reportError(msg?.type || "message", e);
      sendResponse({ ok: false, error: String(e?.message || e), shown: true });
    }
    return false;
  });

  // ---------------------------------------------------------------- scanning

  const STUCK_MS = 20000;   // inject anyway if a "streaming" signal never clears but the text is stable
  const diag = { strategy: "not scanned yet", found: 0, bars: 0, scans: 0 };

  function readText(m) {
    const c = contentOf(m);
    return (c.innerText || c.textContent || "").trim();
  }

  function inject(m) {
    const st = state.get(m);
    const c = contentOf(m);
    const bar = makeBar(m);
    // Place the bar after the content node so innerText of the response never
    // includes our own UI.
    c.insertAdjacentElement("afterend", bar.host);
    if (st.bar) bars.delete(st.bar);
    st.bar = bar;
    bars.add(bar);
    // Show prior captures (e.g. after a page reload), in whichever project.
    send({ type: "isCaptured", text: st.text }).then(res => {
      if (res.ok && res.captured) bar.markCaptured(res);
    });
  }

  function scan() {
    if (!alive()) return orphan();
    try {
      // Bars an orphaned copy of this script left behind (see orphan()).
      for (const h of document.querySelectorAll("[data-pm-orphaned]")) h.remove();
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log("url changed", location.href);
        onUrlChange();
      }
      for (const b of bars) if (!b.host.isConnected) bars.delete(b);
      const { strategy, found } = findMessages();
      if (strategy !== diag.strategy || found.length !== diag.found) {
        log("scan", { strategy, found: found.length, composer: Boolean(findComposer()) });
      }
      diag.strategy = strategy;
      diag.found = found.length;
      diag.scans++;
      const now = Date.now();
      found.forEach((m, i) => {
        let st = state.get(m);
        if (st?.bar?.host.isConnected) return;     // already has a live bar
        const text = readText(m);
        if (!text) return;
        if (!st) {
          st = { text, since: now, bar: null, streamingSince: null };
          state.set(m, st);
        } else if (st.text !== text) {
          st.text = text;
          st.since = now;
        }
        if (isStreaming(m, i === found.length - 1)) {
          st.streamingSince ??= now;
          if (now - st.since < STUCK_MS) return;
          log("streaming signal stuck - injecting anyway", { strategy });
        } else {
          st.streamingSince = null;
        }
        if (now - st.since >= STABLE_MS) {
          inject(m);
          log("button added", { strategy, chars: text.length });
        }
      });
      diag.bars = [...bars].filter(b => b.host.isConnected).length;
    } catch (e) {
      reportError("scanning the page", e);
    }
    updatePill();
  }

  // Debug mode: a small status pill so you can see the script is alive and
  // what it found, without opening any console.
  let pill = null;
  function updatePill() {
    if (!debugOn || !document.body) { pill?.host.remove(); pill = null; return; }
    if (!pill || !pill.host.isConnected) {
      const { host, ui } = shell();
      host.style.pointerEvents = "none";   // never block clicks on the page
      const text = el("div", { class: "pill" });
      ui.append(text);
      document.body.append(host);
      pill = { host, text };
    }
    pill.text.textContent = `PM ${VERSION} · ${diag.strategy} · ${diag.found} found · ${diag.bars} buttons`;
  }

  let observer = null;
  let ticker = null;
  // This script is orphaned (see send()): stop, and say so in every bar, in
  // place of the controls that can no longer work. The new version's page
  // script (injected into open tabs on update) removes these bars and adds
  // its own; if none arrives, the reload prompt stays.
  const ORPHAN_TEXT = "Project Manager was updated or reloaded. Reload this page to keep capturing here.";
  let orphaned = false;
  function orphan() {
    if (orphaned) return;
    orphaned = true;
    clearInterval(ticker);
    observer?.disconnect();
    for (const b of bars) b.orphan();
    pill?.host.remove();
    if (floating) { floating.host.remove(); showToast(ORPHAN_TEXT); }
  }

  function start() {
    log("content script started", { version: VERSION, url: location.href, readyState: document.readyState });
    let pending = null;
    const schedule = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; scan(); }, 300);
    };
    observer = new MutationObserver(muts => {
      // Ignore mutations caused only by our own UI.
      for (const m of muts) {
        const t = m.target;
        if (t.nodeType === 1 && t.closest?.("[data-pm]")) continue;
        schedule();
        return;
      }
    });
    // Observe the document, not body: some apps replace <body> when they hydrate.
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["data-is-streaming"],
    });
    // Stability (and SPA URL changes) need a tick even when the DOM goes quiet.
    ticker = setInterval(scan, 1000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshCtx(); });
    refreshCtx().then(scan);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
