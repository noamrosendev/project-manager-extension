// Renders a verdict report (from report_model.js viewModel) as DOM. Used by
// the popup and by the on-page panel the capture chip opens, so the two always
// look and behave the same. No imports: content scripts load this file alone.
// Styles: lib/ui.css + lib/report.css.

const VERDICT_TEXT = {
  PROGRESS: "Progress",
  AT_RISK: "At risk",
  LOOP: "Loop detected",
  DEVIATION: "Goal deviation",
};
const CUMULATIVE = new Set(["C3", "C5"]);

// h("div", {class: "x"}, child, "text", ...). Skips null/false children:
// DOM append() would otherwise write the text "null".
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

// Append to a fragment, skipping null/false (same reason as h()).
function add(parent, ...nodes) {
  parent.append(...nodes.flat().filter(n => n != null && n !== false));
}

// "2027-03-01" -> "1 Mar 2027" (dates without a time).
export function fmtDay(ymd) {
  if (!ymd) return "";
  const d = new Date(`${ymd}T00:00:00`);
  return isNaN(d) ? ymd : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

const STATE_TAG = { UNVERIFIABLE: "unverifiable", WAITING: "waiting phase", IN_PROGRESS: "in progress", OUT_OF_SCOPE: "out of scope",
  RISING: "rising", STAGNANT: "stuck", ONGOING: "ongoing, flagged earlier", OUT_OF_SCOPE_CONDITIONAL: "out of scope, conditional",
  COUNTS_ONLY: "counts only, not scored", NO_ASSISTANT_COMMITMENT: "nothing to judge",
  SCOPE_CHECK_FAILED: "unknown: a check failed", SUGGESTED: "done? confirm it", REPLACED: "replaced? decide" };

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function copy(text, ta, note) {
  try {
    await navigator.clipboard.writeText(text);
    note.textContent = "Copied. Paste it into your AI assistant.";
  } catch {
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    note.textContent = ok ? "Copied. Paste it into your AI assistant." : "Press ⌘C / Ctrl+C to copy.";
  }
}

// The project goal, always visible (a collapsed "Project goal" row read as an
// empty box). Long goals are clipped to a few lines with "Show all".
// The out-of-scope rules as C6 checks them, one per line, verbatim and
// numbered. A line that ends mid-sentence shows as the fragment it is.
export function scopeList(items) {
  if (!items?.length) return null;
  return h("div", { class: "scope-items" },
    h("div", { class: "goal-label" }, `Out-of-scope rules as checked (${items.length}, one per line)`),
    h("ol", { class: "scope-list" }, items.map(it => h("li", { "data-kind": it.kind },
      h("span", { class: "scope-line" }, it.line),
      h("span", { class: `tag scope-kind kind-${it.kind.toLowerCase()}` },
        it.kind === "CONDITIONAL" ? `CONDITIONAL ("${it.marker}")` : "HARD")))));
}

function goalBlock(vm) {
  const text = vm.hasGoal ? String(vm.goalText || "").trim() : "";
  const body = text || "No goal saved for this project. Add one in Options.";
  const pre = h("pre", { class: "goal-text" }, body);
  const block = h("section", { class: "goal", "data-has-goal": String(Boolean(text)) },
    h("div", { class: "goal-label" }, "Project goal"), pre, scopeList(vm.scopeItems));
  if (body.split("\n").length > 6 || body.length > 320) {
    const more = h("button", { type: "button", class: "linklike goal-more" }, "Show all");
    more.addEventListener("click", e => {
      e.stopPropagation();
      const open = block.classList.toggle("expanded");
      more.textContent = open ? "Show less" : "Show all";
    });
    block.append(more);
  }
  return block;
}

// "Mark executed" / "Close with reason…" for one open commitment.
function resolveControls(c, opts, { deferLabel = "Defer with date…" } = {}) {
  const wrap = h("div", { class: "resolve" });
  const msg = h("span", { class: "resolve-msg", role: "status" });
  const run = async (action, reason, buttons) => {
    buttons.forEach(b => { b.disabled = true; });
    msg.textContent = "";
    let res;
    try { res = await opts.onResolve(c.id, action, reason); } catch (e) { res = { ok: false, error: String(e?.message || e) }; }
    if (!res?.ok) {
      buttons.forEach(b => { b.disabled = false; });
      msg.className = "resolve-msg error-text";
      msg.textContent = res?.error || "Couldn't save that.";
    }
  };
  const done = h("button", { type: "button", class: "small" }, "Mark executed");
  const close = h("button", { type: "button", class: "small" }, "Close with reason…");
  const defer = h("button", { type: "button", class: "small" }, deferLabel);
  const all = [done, close, defer];
  done.addEventListener("click", e => { e.stopPropagation(); run("executed", "", all); });
  defer.addEventListener("click", e => {
    e.stopPropagation();
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const input = h("input", { type: "date", class: "reason due", min: tomorrow, value: c.due_date && c.due_date > tomorrow ? c.due_date : "",
      "aria-label": `New due date for ${c.id}` });
    const ok = h("button", { type: "submit", class: "small primary" }, "Defer");
    const cancel = h("button", { type: "button", class: "small" }, "Cancel");
    const form = h("form", { class: "resolve-form" }, input, ok, cancel);
    form.addEventListener("submit", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!input.value) { msg.className = "resolve-msg error-text"; msg.textContent = "Pick a date."; input.focus(); return; }
      run("defer", input.value, [ok, cancel]);
    });
    cancel.addEventListener("click", ev => { ev.stopPropagation(); wrap.replaceChildren(...all, msg); defer.focus(); });
    wrap.replaceChildren(form, msg);
    opts.guardField?.(input);
    input.focus();
  });
  close.addEventListener("click", e => {
    e.stopPropagation();
    const input = h("input", { type: "text", class: "reason", placeholder: "Why it's no longer worth doing", "aria-label": `Reason for closing ${c.id}` });
    const ok = h("button", { type: "submit", class: "small primary" }, "Close it");
    const cancel = h("button", { type: "button", class: "small" }, "Cancel");
    const form = h("form", { class: "resolve-form" }, input, ok, cancel);
    form.addEventListener("submit", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!input.value.trim()) { msg.className = "resolve-msg error-text"; msg.textContent = "Give a reason."; input.focus(); return; }
      run("closed", input.value.trim(), [ok, cancel]);
    });
    cancel.addEventListener("click", ev => { ev.stopPropagation(); wrap.replaceChildren(...all, msg); done.focus(); });
    wrap.replaceChildren(form, msg);
    opts.guardField?.(input);
    input.focus();
  });
  wrap.append(...all, msg);
  return wrap;
}

// Commitments resolved automatically from response content: shown near the
// top with their evidence and a one-click Reopen.
function resolvedSection(vm, opts) {
  const auto = vm.resolvedFromContent || [];
  if (!auto.length) return null;
  return [h("h2", {}, `Resolved from content (${auto.length})`),
      h("ul", { class: "commitments auto" }, auto.map(c => {
        const quote = (c.note.match(/^(?:Resolved from|Superseded in|Dropped in) round \d+: "([\s\S]*)"$/) || [])[1] || c.note;
        const li = h("li", {},
          h("div", {}, c.text),
          h("div", { class: `age auto-note${c.dropped ? " dropped" : ""}` }, `${c.id} · ${c.dropped ? "Superseded in" : "Resolved from"} round ${c.round}` +
            (c.recordedLater ? ` · recorded later, in round ${c.recordedLater}`
              : c.reviewedUnrecorded ? " · found later by the catch-up review; when was not recorded" : "")),
          h("blockquote", { class: "evidence" }, `“${quote}”`));
        if (opts.onResolve && vm.isLatest) {
          const msg = h("span", { class: "resolve-msg", role: "status" });
          const reopen = h("button", { type: "button", class: "small" }, "Reopen");
          reopen.addEventListener("click", async e => {
            e.stopPropagation();
            reopen.disabled = true;
            let res;
            try { res = await opts.onResolve(c.id, "reopen"); } catch (err) { res = { ok: false, error: String(err?.message || err) }; }
            if (!res?.ok) { reopen.disabled = false; msg.className = "resolve-msg error-text"; msg.textContent = res?.error || "Couldn't reopen."; }
          });
          li.append(h("div", { class: "resolve" }, reopen, h("span", { class: "muted resolve-msg" },
            c.dropped ? "Still wanted? Put it back to open." : "Wasn't actually done? Put it back to open."), msg));
        }
        return li;
      }))];
}

// The drop record: one line, expandable, when anything was dropped this
// round (truncated, capped, skipped, merged, overwritten, not run).
const DROP_KIND = { truncated: "Cut short", capped: "Capped", skipped: "Skipped", merged: "Merged",
  overwritten: "Overwritten", "not run": "Not run", declined: "Declined", unseen: "Unseen", unrecorded: "Not acted on" };
const unitOf = (n, unit) => (n === 1 ? String(unit || "").replace(/s$/, "") : unit);
function dropText(d) {
  const label = `${DROP_KIND[d.kind] || d.kind}: ${d.where}`;
  if (["overwritten", "not run", "declined", "unseen", "unrecorded"].includes(d.kind)) return d.detail ? `${label}, ${d.detail}` : label;
  return `${label} (${Number(d.lost).toLocaleString("en-GB")} ${unitOf(d.lost, d.unit)} lost${d.detail ? `: ${d.detail}` : ""})` +
    (d.during ? ` · during a ${d.during}` : "");
}
function dropsLine(vm) {
  const drops = vm.drops || [];
  if (!drops.length) return null;
  const n = drops.length;
  return h("details", { class: "drops" },
    h("summary", {}, `${n} thing${n === 1 ? " was" : "s were"} dropped this round`),
    h("ul", {}, drops.map(d => h("li", {}, dropText(d)))));
}

// Open for more than two rounds without being judged from content.
const isStale = c => c.age_rounds > 2;

// Who must act, whether it is promised, and the sentence it came from,
// always visible: a mislabel should cost one glance.
function labelsLine(c) {
  const actor = c.actor || "no actor recorded";
  const modality = c.modality || "no modality recorded";
  return [h("div", { class: "labels" },
      h("span", { class: `tag label-actor actor-${(c.actor || "none-recorded").replace(/\W/g, "")}`,
        title: c.actor_def === 2 ? "definition 2: whose responsibility it is" : c.actor_def === 1 ? "definition 1: who performs it" : "" },
        `actor: ${actor}${c.actor_def ? ` (def. ${c.actor_def})` : ""}`),
      h("span", { class: `tag label-modality modality-${(c.modality || "none-recorded").replace(/\W/g, "")}` }, `modality: ${modality}`)),
    h("blockquote", { class: "source" }, c.source_sentence ? `“${c.source_sentence}”` : "no source sentence recorded (from before v0.21)"),
    c.text_outside_source?.length ? h("div", { class: "outside-source" },
      `the text adds words its source sentence does not have: ${c.text_outside_source.join(", ")}`) : null,
    c.hedges_dropped?.length ? h("div", { class: "hedges-dropped" },
      `the text drops ${c.hedges_dropped.map(x => `“${x}”`).join(", ")} from its source sentence`) : null,
    c.condition ? h("div", { class: "condition muted" }, `condition: “${c.condition}”`) : null,
    c.accepted ? h("div", { class: "accepted muted" }, `accepted in round ${c.accepted.round}: “${c.accepted.quote}”`) : null];
}

// A "done" (or "closed") found in the assistant's reply, the extraction's own
// judgement, or the catch-up review: not the user's words, so it never closes
// by itself (v0.32.0). Shown with its quote; one click confirms it.
const SUGGESTED_BY = {
  user: (r, w) => `Your message in round ${r} says this is ${w}`,
  reply: (r, w) => `The assistant's reply in round ${r} says this is ${w}`,
  model: (r, w) => `The extraction judged this ${w} in round ${r}`,
  review: (r, w) => `The catch-up review found it ${w} in round ${r}`,
};
function suggestionBlock(c, vm, opts) {
  const s = c.suggested_done;
  if (!s) return null;
  const head = s.superseded ? `Your message in round ${s.round} decides against this${s.via === "review" ? " (found by the catch-up review)" : ""}`
    : (SUGGESTED_BY[s.from] || SUGGESTED_BY.reply)(s.round, s.closed ? "no longer needed" : "done") + (s.from === "user" && s.via === "review" ? " (found by the catch-up review)" : "");
  const box = h("div", { class: "suggested", "data-commitment": c.id },
    h("div", { class: "suggested-head" }, `${head}. It stays open until you confirm it.`),
    s.quote ? h("blockquote", { class: "evidence" }, `“${s.quote}”`) : null,
    s.from === "model" && s.in_reply === false ? h("div", { class: "muted" }, "That evidence is not in the reply.") : null);
  if (opts.onResolve && vm.isLatest) {
    const msg = h("span", { class: "resolve-msg", role: "status" });
    const btn = h("button", { type: "button", class: "small primary confirm-suggested" }, s.superseded ? "Confirm superseded" : s.closed ? "Confirm closed" : "Confirm done");
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      btn.disabled = true;
      const note = `Confirmed from round ${s.round}: "${s.quote}"`;
      let res;
      try { res = await opts.onResolve(c.id, s.superseded ? "superseded" : s.closed ? "closed" : "executed", note); } catch (err) { res = { ok: false, error: String(err?.message || err) }; }
      if (!res?.ok) { btn.disabled = false; msg.className = "resolve-msg error-text"; msg.textContent = res?.error || "Couldn't save that."; }
    });
    box.append(h("div", { class: "resolve" }, btn, msg));
  }
  return box;
}

function commitmentItem(c, vm, opts) {
  const restated = c.restated ? ` · restated ${c.restated}×` : "";
  const since = c.since ? `, ${fmtDate(c.since)}` : "";
  return h("li", {},
    h("div", {}, c.text),
    ...labelsLine(c),
    h("div", { class: `age${c.age_rounds >= 2 ? " stale" : ""}` },
      c.due_date
        ? `${c.id} · was due ${fmtDay(c.due_date)} · ${c.age_rounds} round${c.age_rounds === 1 ? "" : "s"} since${restated}`
        : `${c.id} · open ${c.age_rounds} round${c.age_rounds === 1 ? "" : "s"} (since round ${c.round}${since})${restated}`),
    c.substeps?.length ? h("details", { class: "substeps" },
      h("summary", {}, `${c.substeps.length} sub-step${c.substeps.length === 1 ? "" : "s"}`),
      h("ol", {}, c.substeps.map(x => h("li", {}, x.text, h("span", { class: "muted" }, ` · round ${x.round}`))))) : null,
    suggestionBlock(c, vm, opts),
    opts.onResolve && vm.isLatest ? resolveControls(c, opts) : null);
}

// "Re-check against past responses": the model re-judges every open
// commitment from the rounds since it was raised. Optional - nothing waits on it.
function recheckControl(vm, opts) {
  if (!opts.onReview || !vm.isLatest || !vm.open.length) return null;
  const btn = h("button", { type: "button", class: "small" }, "Re-check against past responses");
  const msg = h("span", { class: "resolve-msg", role: "status" });
  btn.addEventListener("click", async e => {
    e.stopPropagation();
    btn.disabled = true;
    msg.className = "resolve-msg";
    msg.textContent = "Checking…";
    let res;
    try { res = await opts.onReview(); } catch (err) { res = { ok: false, error: String(err?.message || err) }; }
    btn.disabled = false;
    if (!res?.ok) { msg.className = "resolve-msg error-text"; msg.textContent = res?.error || "Couldn't re-check."; return; }
    const done = res.changed.filter(c => c.status === "EXECUTED").length;
    const dropped = res.changed.filter(c => c.status === "SUPERSEDED").length;
    msg.textContent = res.changed.length
      ? `Found evidence: ${done} done, ${dropped} superseded. ${res.stillOpen} still open.`
      : `No clear evidence in past responses. ${res.stillOpen} still open.`;
  });
  return h("div", { class: "resolve recheck" }, btn, msg);
}

// Stale commitments, surfaced (never a gate): oldest first, with actions.
function staleSection(vm, opts) {
  const stale = vm.open.filter(isStale).sort((a, b) => a.round - b.round);
  if (!stale.length) return null;
  return [h("h2", {}, `Stale - open more than 2 rounds (${stale.length})`),
    h("p", { class: "muted stale-hint" }, "Nothing in the responses since has settled these. Act on them when you choose, or let them age - C3 tracks it."),
    h("ul", { class: "commitments stale-list" }, stale.map(c => commitmentItem(c, vm, opts))),
    recheckControl(vm, opts)];
}

// Item 18: opts.onSeen(commitmentId), once per render for each suggestion
// whose block is at least half on screen in a visible page, so a decline
// can mean "seen and not confirmed".
export const SEEN_RATIO = 0.5;
function watchSuggestions(frag, opts) {
  if (!opts.onSeen || typeof IntersectionObserver === "undefined") return;
  const boxes = [...frag.querySelectorAll(".suggested[data-commitment]")];
  if (!boxes.length) return;
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.intersectionRatio < SEEN_RATIO || document.visibilityState !== "visible") continue;
      io.unobserve(e.target);
      opts.onSeen(e.target.dataset.commitment);
    }
  }, { threshold: [SEEN_RATIO] });
  for (const b of boxes) io.observe(b);
}

// opts.onShowLatest: shown as "Show latest" when vm is an earlier round.
// opts.onResolve(commitmentId, "executed" | "closed", reason) -> {ok, error}:
//   adds one-click resolution buttons to open commitments (latest round only).
// opts.guardField(input): lets the on-page panel protect text fields from the
//   chat page's key/focus handlers.
// opts.onReview() -> {ok, changed, stillOpen}: "Re-check against past responses".
// opts.onSeen(commitmentId): a suggestion was on screen (see watchSuggestions).
export function renderReport(vm, opts = {}) {
  const frag = document.createDocumentFragment();

  const setupNote = vm.setupCount
    ? h("p", { class: "muted setup-note" }, `${vm.setupCount} setup capture${vm.setupCount === 1 ? "" : "s"} (goal definition) recorded, not counted as rounds.`)
    : null;
  const goal = goalBlock(vm);

  if (vm.missingRound != null) {
    add(frag, h("p", { class: "muted" }, `Round ${vm.missingRound} is no longer in “${vm.projectName}” (it was undone or the ledger was reset).`),
      opts.onShowLatest && vm.totalRounds ? latestLink(opts.onShowLatest) : null, goal);
    return frag;
  }

  if (!vm.verdict) {
    add(frag, h("p", { class: "muted" }, `No rounds captured for “${vm.projectName}” yet.`), setupNote, goal);
    return frag;
  }

  const cur = vm.round;
  add(frag, 
    h("section", { class: `verdict v-${vm.verdict}` },
      h("div", { class: "big" }, VERDICT_TEXT[vm.verdict] || vm.verdict),
      h("div", { class: "meta" }, `Round ${cur.round} of ${vm.totalRounds} · ${cur.output_shape} · ${fmtDate(cur.read_at)}`),
      h("div", { class: "judged" }, !vm.recorded ? "Recomputed with current rules: no record from the time"
        : vm.recorded.shown ? `As judged at capture (${ruleVersions(vm.recorded)})`
        : `Latest round: live. Recorded at capture (${ruleVersions(vm.recorded)})`)),
    vm.recorded?.shown && vm.verdictNow !== vm.verdict ? h("p", { class: "phase-note recomputed" },
      h("strong", {}, `Recomputed now: ${VERDICT_TEXT[vm.verdictNow] || vm.verdictNow}. `),
      "Changes since capture (commitments resolved, or newer rules) give a different result. The verdict above is what this round was given at the time.") : null,
    vm.recorded && !vm.recorded.shown && vm.recorded.verdict !== vm.verdict ? h("p", { class: "phase-note recomputed" },
      h("strong", {}, `At capture this round was judged: ${VERDICT_TEXT[vm.recorded.verdict] || vm.recorded.verdict}. `),
      "What you've resolved since changed it to the verdict above.") : null,
    vm.phase === "WAITING" ? h("p", { class: "phase-note" },
      h("strong", {}, "Waiting phase. "), "Repeated output shapes and a low artefact count aren't penalised; commitments and goal alignment are checked as usual.") : null,
    cur.userMessagesMissing ? h("p", { class: "phase-note user-missing" },
      h("strong", {}, cur.userMessageNote ? `${cur.userMessageNote}. `.replace(/^./, c => c.toUpperCase())
        : "Project Manager couldn't read your message before this response. "),
      (cur.userMessageNote ? "" : "The cause wasn't recorded. ") +
      "Output in that message isn't seen, so commitments executed in a terminal won't resolve.") : null,
    cur.userPartialNote ? h("p", { class: "phase-note user-missing" },
      h("strong", {}, `${cur.userPartialNote}. `.replace(/^./, c => c.toUpperCase())),
      "Output in it isn't seen, so commitments executed in a terminal may not resolve.") : null,
    dropsLine(vm),
    (vm.unreadLines || []).map(t => h("p", { class: "unread-counts muted" }, t)),
    vm.isLatest ? null : h("p", { class: "later-note" },
      `Showing the project as it stood at round ${cur.round}. Later rounds exist.`,
      opts.onShowLatest ? [" ", latestLink(opts.onShowLatest)] : null),
    h("p", { class: "summary" }, cur.summary),
    cur.source_url ? h("p", { class: "source muted" }, h("a", { href: cur.source_url, target: "_blank", rel: "noreferrer" }, "Source")) : null,
    resolvedSection(vm, opts),
    staleSection(vm, opts),
    setupNote,
    goal);

  // Handoff, placed above the details when there's a problem
  // The handoff is for acting now: shown when the current judgement (not the
  // recorded one) has a problem.
  const now = vm.verdictNow || vm.verdict;
  if (now !== "PROGRESS") {
    const text = String(vm.handoff || "").trim()
      ? vm.handoff
      : `Couldn't build the handoff prompt for verdict ${vm.verdict}. Open Options > Debug and send the log.`;
    const ta = h("textarea", { readonly: true, "aria-label": "Handoff prompt" }, text);
    ta.value = text;
    const btn = h("button", { type: "button", class: "primary" }, "Copy handoff prompt");
    const note = h("span", { class: "muted", role: "status" });
    btn.addEventListener("click", e => { e.stopPropagation(); copy(text, ta, note); });
    add(frag, h("h2", {}, "Handoff prompt"),
      h("section", { class: "handoff" }, ta, h("div", { class: "row" }, btn, note)));
  }

  add(frag, h("h2", {}, "Checks"),
    h("ul", { class: "checks" }, vm.checks.map(c =>
      h("li", {},
        h("span", { class: `pill s-${c.status}` }, c.status),
        h("span", { class: "name" }, h("span", { class: "id" }, c.id), c.name,
          CUMULATIVE.has(c.id) ? h("span", { class: "tag" }, "cumulative, context only") : null,
          c.advisory ? h("span", { class: "tag advisory" }, "reports only, not in the verdict") : null,
          c.state ? h("span", { class: `tag state state-${c.state.toLowerCase()}` }, STATE_TAG[c.state] || c.state.toLowerCase()) : null),
        h("span", { class: "ev" }, c.evidence || "—"),
        // C6's one-line reason for a breach, so a word-match shows as one.
        c.reason ? h("span", { class: "reason" }, `model's reason: ${c.reason}`)
          : c.id === "C6" && /^OUT_OF_SCOPE/.test(c.state || "") ? h("span", { class: "reason" }, "no reason recorded (captured before v0.26)") : null))));

  // Fresh open commitments (stale ones are listed near the top).
  const fresh = vm.open.filter(c => !isStale(c));
  add(frag, h("h2", {}, `Open commitments (${fresh.length})`));
  if (!fresh.length) {
    add(frag, h("p", { class: "muted" }, vm.open.length ? "None besides the stale ones above." : "None."));
  } else {
    add(frag, h("ul", { class: "commitments" }, fresh.map(c => commitmentItem(c, vm, opts))));
    if (!vm.open.some(isStale)) add(frag, recheckControl(vm, opts));
  }

  // Offers wait on your answer; contingencies on an event. Not aged by C3,
  // not judged by C2: listed with how long they have waited.
  for (const [list, title] of [[vm.offers, "Offered, not yet accepted"], [vm.contingent, "Waiting on a condition"]]) {
    if (!list?.length) continue;
    add(frag, h("h2", {}, `${title} (${list.length})`),
      h("ul", { class: "commitments waiting" }, list.map(c => h("li", {},
        h("div", {}, c.text), ...labelsLine(c),
        h("div", { class: "age" }, `${c.id} · waiting ${c.waiting_rounds} round${c.waiting_rounds === 1 ? "" : "s"} (since round ${c.round})`)))));
  }

  // Future-dated commitments: not open for C2/C3 until their date.
  const scheduled = vm.scheduled || [];
  if (scheduled.length) {
    add(frag, h("h2", {}, `Scheduled (${scheduled.length})`),
      h("ul", { class: "commitments scheduled" }, scheduled.map(c => h("li", {},
        h("div", {}, c.text),
        h("div", { class: "age due" }, `${c.id} · due ${fmtDay(c.due_date)} · not counted until then (from round ${c.round})`),
        opts.onResolve && vm.isLatest ? resolveControls(c, opts, { deferLabel: "Change date…" }) : null))));
  }
  watchSuggestions(frag, opts);
  return frag;
}

// "rules: C1 v1 · C2 v1 · ... · C6 v2": the version each check was judged under.
function ruleVersions(recorded) {
  return "rules: " + recorded.versions.map(([id, v]) => `${id} v${v ?? "?"}`).join(" · ");
}

function latestLink(onShowLatest) {
  const b = h("button", { type: "button", class: "linklike" }, "Show latest");
  b.addEventListener("click", e => { e.stopPropagation(); onShowLatest(); });
  return b;
}
