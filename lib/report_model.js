// The data behind a verdict report, shared by the popup and the on-page
// report panel (the service worker builds it for content scripts). Plain,
// serialisable object; rendering lives in report_view.js.

import { report, checkVersion, classifyScopeItem, USER_READ_TEXT, USER_PARTIAL_TEXT, unreadCounts, unreadLine } from "./core.js";
import { composeGoal, outOfScopeLines } from "./store.js";

// The out-of-scope rules exactly as C6 checks them: one per line of the field
// and of an "Explicitly out of scope" goal section, numbered in the order
// checked, with their classification. No joining or splitting: a line
// wrapped mid-sentence shows as the fragment the checker really receives.
export function scopeItemsOf(project) {
  return outOfScopeLines(project).map((line, i) => {
    const k = classifyScopeItem(line);
    return { n: i + 1, line, kind: k.kind, marker: k.marker };
  });
}

// Who must act, whether it is promised, and the sentence it came from:
// shown on every commitment so a mislabel costs one glance.
// A converted offer also carries what accepted it, so the conversion can be judged.
// actor_def: the definition the actor was judged under (none stored = 1).
// text_outside_source: words of the text its source sentence lacks (absent
// on commitments from before v0.29.0, which were never checked).
const labels = c => ({ actor: c.actor || "", actor_def: c.actor ? (c.actor_def || 1) : null, modality: c.modality || "", source_sentence: c.source_sentence || "", condition: c.condition || "",
  text_outside_source: Array.isArray(c.text_outside_source) ? c.text_outside_source : null,
  // "would", "should" or "I think" in the source, not in the text (v0.30.0).
  hedges_dropped: Array.isArray(c.hedges_dropped) ? c.hedges_dropped : null,
  accepted: c.accepted ? { round: c.accepted.round, quote: c.accepted.quote } : null });
const suggestionAt = (c, round) => {
  const s = c?.status === "OPEN" ? c.suggested_done : null;
  return s && (s.recorded_round ?? s.round) <= round
    ? { round: s.round, quote: s.quote || "", from: s.from || "", in_reply: s.in_reply ?? null, closed: Boolean(s.closed),
        superseded: Boolean(s.superseded), via: s.via || "" } : null;
};
const waitingOn = (round, modality) => (round._open_commitments || []).filter(c => c.modality === modality)
  .map(c => ({ id: c.id, text: c.text, round: c.round, waiting_rounds: round.round - c.round, ...labels(c) }));

// uptoRound: show the project as it stood at that round (the checks are
// deterministic over the round history), or omit for the latest round.
// opts: report options (graceRounds), from store.loadReportOpts().
export function viewModel(project, ledger, uptoRound, opts = {}) {
  const all = ledger?.rounds || [];
  const goalText = composeGoal(project) || String(project?.goal || "");
  const base = {
    projectId: project?.id,
    projectName: project?.name || "",
    goalText,
    hasGoal: Boolean(String(project?.goal || "").trim() || String(project?.outOfScope || "").trim()),
    setupCount: ledger?.setup?.length || 0,
    scopeItems: scopeItemsOf(project),
    totalRounds: all.length,
    phase: project?.phase === "WAITING" ? "WAITING" : "ACTIVE",
    verdict: null,
  };
  if (uptoRound != null && !all.some(r => r.round === uptoRound)) {
    return { ...base, missingRound: uptoRound };
  }
  const n = uptoRound == null ? all.length : all.findIndex(r => r.round === uptoRound) + 1;
  const r = report({ ...ledger, rounds: all.slice(0, n) }, goalText, opts);
  if (!r) return base;
  const readAt = Object.fromEntries(all.map(x => [x.round, x.read_at]));
  const byId = new Map((ledger.commitments || []).map(c => [c.id, c]));
  // Earlier rounds show what they were judged at capture (their record);
  // rounds from before recording are recomputed, and labelled so. The latest
  // round stays live, since resolving its commitments is meant to change it;
  // its record is shown alongside when the two differ.
  const rec = r.round.verdict_record || null;
  const isLatest = n === all.length;
  const shown = rec && !isLatest ? rec : null;
  return {
    ...base,
    verdict: shown ? rec.verdict : r.verdict,
    verdictNow: r.verdict,
    recorded: rec ? { versions: rec.checks.map(c => [c.id, checkVersion(rec, c.id)]), verdict: rec.verdict, shown: Boolean(shown) } : null,
    checksNow: r.checks,
    shownRound: r.round.round,
    isLatest,
    round: {
      round: r.round.round,
      output_shape: r.round.output_shape,
      summary: r.round.summary || "",
      read_at: r.round.read_at || "",
      source_url: r.round.source_url || "",
      userMessagesMissing: Boolean(r.round.user_messages_missing),
      userMessageNote: USER_READ_TEXT[r.round.user_message_reason] || null,
      userPartialNote: USER_PARTIAL_TEXT[r.round.user_message_partial] || null,
    },
    unreadLines: unreadCounts(all).map(unreadLine).filter(Boolean),
    items: r.items,
    artefacts: r.artefacts,
    checks: shown ? rec.checks : r.checks,
    // Offers and contingencies wait on an answer or an event: their own lists.
    offers: waitingOn(r.round, "offered"),
    contingent: waitingOn(r.round, "contingent"),
    open: r.open.map(c => ({
      id: c.id, text: c.text, round: c.round, age_rounds: c.age_rounds, ...labels(c),
      // "Done" found in the assistant's reply, the model's judgement or the
      // catch-up review, not in the user's words (v0.32.0): shown with its
      // quote, closed by one click, never on its own. From the ledger as it
      // is now, if made by the viewed round.
      suggested_done: suggestionAt(byId.get(c.id), r.round.round),
      restated: c.restated_rounds?.length || 0, since: readAt[c.round] || "", due_date: c.due_date || "",
      substeps: (c.substeps || []).filter(x => x.round <= r.round.round).map(x => ({ text: x.text, round: x.round })),
    })),
    scheduled: (r.scheduled || []).map(c => ({
      id: c.id, text: c.text, round: c.round, due_date: c.due_date, since: readAt[c.round] || "",
    })),
    phase: r.phase,
    // Auto-resolved from response content, newest first: shown with the
    // evidence quote and a one-click Reopen.
    // The viewed round's drop record: null for rounds captured before it
    // existed (not recorded), [] when nothing was dropped.
    drops: Array.isArray(r.round.drops) ? r.round.drops : null,
    resolvedFromContent: (ledger.commitments || [])
      .filter(c => c.resolved_by === "content" && ["EXECUTED", "SUPERSEDED"].includes(c.status) && (c.resolved_round ?? 0) <= r.round.round)
      .sort((a, b) => (b.resolved_round ?? 0) - (a.resolved_round ?? 0))
      .slice(0, 8)
      .map(c => ({ id: c.id, text: c.text, round: c.resolved_round, note: c.resolution_note || "", dropped: c.status === "SUPERSEDED",
        // Settled later than the round being viewed (the review back-dates to
        // its evidence round): say so instead of showing it as known then.
        recordedLater: c.recorded_round != null && c.recorded_round > r.round.round ? c.recorded_round : null,
        // A review closure from before the run was recorded: when is unknown.
        reviewedUnrecorded: Boolean(c.reviewed) && c.recorded_round == null })),
    handoff: r.handoff,
  };
}

// The stale backlog, for the sweep in Options (v0.34.0): exactly what C3
// counts as open 2+ rounds at the latest round (scheduled items, offers,
// contingencies and confirmations aside, as C3 sets them aside), oldest
// first, each with the sentence it came from and the round that raised it.
// Listing only: nothing here closes anything or calls a model; each item is
// closed or deferred by the user's click.
export function staleBacklog(project, ledger, opts = {}) {
  const all = ledger?.rounds || [];
  if (!all.length) return [];
  const r = report(ledger, composeGoal(project) || String(project?.goal || ""), opts);
  if (!r) return [];
  const readAt = Object.fromEntries(all.map(x => [x.round, x.read_at]));
  const byId = new Map((ledger.commitments || []).map(c => [c.id, c]));
  return r.open
    .filter(c => c.age_rounds >= 2 && byId.get(c.id)?.status === "OPEN")
    .sort((a, b) => a.round - b.round || a.id.localeCompare(b.id))
    .map(c => ({ id: c.id, text: c.text, round: c.round, raised_at: readAt[c.round] || "", age_rounds: c.age_rounds,
      due_date: c.due_date || "", source_sentence: c.source_sentence || "", actor: c.actor || "", modality: c.modality || "",
      suggested_done: suggestionAt(byId.get(c.id), r.round.round) }));
}
