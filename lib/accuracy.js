// Accuracy of the checks, computed from the event record (events: see
// ledgerEvents in core.js) through a declared, versioned mapping. The events
// say what happened; only MAPPING decides what that means. Change the mapping
// and the same stored events are simply re-read: history is never rewritten.
//
// Three outcomes: right, wrong, no outcome. Silence is never "right": a
// resolution nobody reopened is counted as unchallenged, separately.

// ------------------------------------------------------------------ mapping
// What each check claims (canonical wording), and what scores it.
//
// C1. "This round repeats the shape of the previous ones, so the
//     conversation is cycling rather than advancing."
//     Wrong if the repetition was the work itself. No event signal.
//
// C2. "A commitment the assistant made earlier has not been shown executed
//     in the conversation since." (v3: the assistant's *committed* ones only,
//     and it reports without driving the verdict; v2: the assistant's
//     commitments; v1: any commitment, "A commitment made earlier...")
//     Wrong if it had already been shown executed in or before the round C2
//     judged. A click with no time evidence is no outcome.
//   Rows (WARN or FAIL naming commitment X, in round N):
//   - X later resolved from content, evidence round > N      -> right
//   - X later resolved from content, evidence round <= N     -> wrong
//   - X closed by a click, never resolved, or its resolution
//     was reopened                                           -> no outcome
//   A C2 PASS is not a claim these rows score.
//
// C3. "These commitments have been open two or more rounds and nothing
//     since has settled them."
//     Mechanically always true, so what is scored is whether surfacing them
//     was useful. Close with reason suggests yes. Mark executed is
//     ambiguous and is no outcome, not right.
//   No rows in mapping v1.
//
// C4. "A rejection reason in this round matches one already given."
//     Wrong if the reasons only look alike. No event signal.
//
// C6. "Something in this round falls outside the goal or inside an
//     out-of-scope item."
//     Wrong if it does not, which only a reader can say. No event signal.
//
// C7. "The things being asked of you are accumulating."
//     Wrong if an item counted as a request of the user is not one, for
//     example an assistant self-commitment classified as a user ask.
//   No rows in mapping v1.
//
// AUTO-RESOLUTION (not a check; the commitment closed from content):
//   "This commitment was done (or the user decided against it), as the
//   quoted text shows."
//   - reversed by a Reopen                                   -> wrong
//   - never reversed                                         -> unchallenged (not right)
//
// Verdicts from an undone round, and resolutions reversed or undone, are
// never scored.
export const MAPPING_V1 = Object.freeze({
  version: 1,
  noSignal: ["C1", "C4", "C6"],
  rows: Object.freeze([
    { subject: "AUTO", when: "reopened", outcome: "wrong" },
    { subject: "C2", when: "content-resolved-after", outcome: "right" },
    { subject: "C2", when: "content-resolved-by", outcome: "wrong" },
  ]),
});
export const MAPPING = MAPPING_V1;   // the mapping in use

const SCORED_CHECKS = ["C1", "C2", "C3", "C4", "C6", "C7"];
const isContent = e => e.by === "content" && (e.via === "capture" || e.via === "review");
const key = e => `${e.project}|${e.commitment}`;

// events: one or more projects' records. Returns
// { mapping, auto: {resolutions, wrong, right, unchallenged}, checks: { C2: { "<version>": {claims, right, wrong, none} }, C1: {signal:false}, C3: {mapped:false} } }
export function measure(events, mapping = MAPPING) {
  const rowFor = (subject, when) => mapping.rows.find(r => r.subject === subject && r.when === when);
  const reversed = new Set(events.filter(e => e.type === "reopened").map(e => `${e.project}|${e.reverses}`));
  const undone = events.filter(e => e.type === "undone");
  const roundUndone = v => undone.some(u => u.project === v.project && String(u.at) > String(v.at) && (u.rounds || []).includes(v.round));
  const resolutionUndone = r => undone.some(u => u.project === r.project && String(u.at) > String(r.at) && (u.commitments || []).includes(r.commitment));
  const live = r => !reversed.has(`${r.project}|${r.resolution}`) && !resolutionUndone(r);
  const resolutions = events.filter(e => e.type === "resolved");

  // Auto-resolution.
  const auto = { resolutions: 0, right: 0, wrong: 0, unchallenged: 0 };
  for (const r of resolutions.filter(isContent)) {
    if (resolutionUndone(r)) continue;
    auto.resolutions++;
    const row = reversed.has(`${r.project}|${r.resolution}`) ? rowFor("AUTO", "reopened") : null;
    if (row?.outcome === "wrong") auto.wrong++;
    else if (row?.outcome === "right") auto.right++;
    else auto.unchallenged++;
  }

  // Checks.
  const checks = {};
  for (const id of SCORED_CHECKS) {
    if (mapping.noSignal.includes(id)) checks[id] = { signal: false };
    else if (!mapping.rows.some(r => r.subject === id)) checks[id] = { mapped: false };
    else checks[id] = {};
  }
  const byCommitment = new Map();
  for (const r of resolutions) (byCommitment.get(key(r)) || byCommitment.set(key(r), []).get(key(r))).push(r);
  for (const v of events.filter(e => e.type === "verdict" && e.check === "C2" && e.status !== "PASS" && e.subjects?.length)) {
    if (!checks.C2 || checks.C2.signal === false || checks.C2.mapped === false) break;
    if (roundUndone(v)) continue;
    const ver = String(v.version ?? "?");
    const cell = checks.C2[ver] ??= { claims: 0, right: 0, wrong: 0, none: 0 };
    cell.claims++;
    const later = (byCommitment.get(`${v.project}|${v.subjects[0]}`) || [])
      .filter(r => String(r.at) >= String(v.at) && live(r)).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
    const when = later && isContent(later) ? (later.round > v.round ? "content-resolved-after" : "content-resolved-by") : null;
    const row = when ? rowFor("C2", when) : null;
    if (row?.outcome === "right") cell.right++;
    else if (row?.outcome === "wrong") cell.wrong++;
    else cell.none++;
  }
  return { mapping: mapping.version, auto, checks };
}

// -------------------------------------------------------- three states
// Measured by events (a decided claim, through the mapping's rows), measured by hand (the owner's
// scored panels, recorded here with their source because nothing in the
// extension produced them), or never tested (neither). A check can be both
// measured by events and by hand. "No outcome signal" says events can't
// score a check, not that nothing has; and a check that has never been
// scored is never tested, however often it passed.
export const HAND_SCORES = Object.freeze({
  C1: Object.freeze({ version: 1, right: 8, wrong: 0, panels: 18,
    source: "the owner's hand-scored panels (spreadsheet), as reported on 22 Oct 2026" }),
});
// Hand scores that exist but are NOT counted, each with the reason, so nobody
// adds them later. Accuracy is version-scoped: a figure scored at an older
// check version says nothing about the current one.
export const EXCLUDED_HAND_SCORES = Object.freeze({
  C2: Object.freeze({ version: 1, right: 2, wrong: 6, excluded_on: "2026-10-22",
    reason: "scored at v1; C2 is now v3, and accuracy is kept per check version" }),
  C3: Object.freeze({ version: 1, right: 10, wrong: 0, excluded_on: "2026-10-22", withdrawn: true,
    reason: "withdrawn by the scorer, 22 Oct: measured the count, not the claim" }),
  C5: Object.freeze({ version: 1, right: 3, wrong: 7, excluded_on: "2026-10-22",
    reason: "C5 is retired (v0.18.0)" }),
  C6: Object.freeze({ version: 2, right: 6, wrong: 6, excluded_on: "2026-10-22",
    reason: "scored at v2; C6 is now v3, and accuracy is kept per check version" }),
  C7: Object.freeze({ version: 1, right: 5, wrong: 0, excluded_on: "2026-10-22",
    reason: "scored at v1, before C7 became counts only (v2)" }),
});
// C3's figure scored whether the stale count was arithmetically right, not
// whether the flag meant anything: most items it calls abandoned are completed
// procedural steps. The same mistake kept C5 alive for a week.

// Checked against the 22 Oct 2026 export: C4 never failed, and recomputed
// over all 148 rounds it warned once (never recorded, never scored).
const NOTES = Object.freeze({
  C4: "Never failed; recomputed over the 148 rounds of the 22 Oct 2026 export it warned once, unscored. Its passes are not counted as right.",
});

// m: measure()'s result. One row per scored check, in order.
export function accuracyRows(m, hand = HAND_SCORES, excluded = EXCLUDED_HAND_SCORES) {
  return SCORED_CHECKS.map(id => {
    const c = m.checks[id] || {};
    // Events measure a check only once one of its claims is decided.
    const byEvents = c.signal !== false && c.mapped !== false && Object.values(c).some(x => x.right + x.wrong > 0);
    const events = c.signal === false ? "no outcome signal"
      : c.mapped === false ? `no rows in mapping v${m.mapping}`
      : Object.entries(c).map(([v, x]) => ({ version: v, ...x }));
    const h = hand[id] || null;
    const state = byEvents ? "measured by events" : h ? "measured by hand" : "never tested";
    return { id, state, events, hand: h, ...(byEvents && h ? { alsoByHand: true } : {}), ...(NOTES[id] ? { note: NOTES[id] } : {}),
      ...(!h && excluded[id] ? { excludedHand: excluded[id] } : {}) };
  });
}
