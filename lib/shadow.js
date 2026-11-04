// Shadow mode for automatic project assignment: on a conversation's first
// capture, predict which existing project it belongs to and store that next
// to the project the user actually chose. It acts on nothing: it never files
// a conversation and never writes to a ledger (the service worker keeps the
// records under their own storage key). The tally in Options shows what
// coverage is achievable before anything is automated.

import { quoteInText, clip } from "./core.js";

export const SHADOW_KEY = "shadowAssign";
// Score points (0-100) the best project must lead the runner-up by, where
// "belongs to none of them" counts as a runner-up too.
export const SHADOW_MIN_MARGIN = 25;
export const SHADOW_MARKER = "PREDICT PROJECT FOR CONVERSATION";

// candidates: [{ id, name, goal, outOfScope }] - the projects that existed
// before this capture. convo: { user, reply }.
export function buildShadowPrompt(candidates, convo) {
  const list = candidates.map((p, i) =>
    `P${i + 1}: ${clip(p.name || "", 80)}\nGoal: ${clip(String(p.goal || "").trim(), 600)}` +
    (String(p.outOfScope || "").trim() ? `\nOut of scope: ${clip(p.outOfScope.trim(), 300)}` : "")).join("\n\n");
  return `${SHADOW_MARKER}
You sort a conversation into one of the user's projects, or none of them.

PROJECTS:
${list}

CONVERSATION (the user's message, then the assistant's reply):
USER: ${clip(convo.user || "(not available)", 1500)}
ASSISTANT: ${clip(convo.reply || "", 2500)}

Return ONLY valid JSON, no prose:
{"scores": {"P1": 0-100, ..., "NONE": 0-100}, "best": "P1|...|NONE", "quote": "a sentence copied verbatim from the CONVERSATION that shows it belongs to the best project; empty if NONE"}
- scores: how well the conversation fits each project; NONE = it fits none of them.
- Score every project and NONE. Do not guess: a conversation that only shares general words
  (investment, validation, run, audit) with a project does not fit it.`;
}

// The model's answer -> a recorded prediction. Abstains unless the best pick
// is a real project, its quote is in the conversation, and it leads the
// runner-up (another project or NONE) by SHADOW_MIN_MARGIN.
export function shadowDecision(out, candidates, convo) {
  const scores = out && typeof out.scores === "object" && out.scores ? out.scores : {};
  const num = k => { const v = Number(scores[k]); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; };
  const keys = [...candidates.map((_, i) => `P${i + 1}`), "NONE"];
  const ranked = keys.map(k => ({ k, s: num(k) })).filter(x => x.s != null).sort((a, b) => b.s - a.s);
  const quote = String(out?.quote || "").trim();
  const text = `${convo.user || ""}\n${convo.reply || ""}`;
  const verified = quoteInText(quote, text);
  const top = ranked[0], second = ranked[1];
  const margin = top && second ? top.s - second.s : null;
  const idx = top && top.k !== "NONE" ? Number(top.k.slice(1)) - 1 : -1;
  const base = { quote: clip(quote, 300), verified, margin, scores: Object.fromEntries(ranked.map(x => [x.k, x.s])),
    best: idx >= 0 ? candidates[idx]?.id ?? null : null };
  const why = !candidates.length ? "no existing projects"
    : ranked.length < keys.length ? "scores missing"
    : idx < 0 ? "fits none of the projects"
    : !verified ? "quote not found in the conversation"
    : margin < SHADOW_MIN_MARGIN ? `margin ${margin} under ${SHADOW_MIN_MARGIN}`
    : "";
  return why ? { ...base, abstain: true, reason: why, projectId: null } : { ...base, abstain: false, reason: "", projectId: base.best };
}

// The project a record is judged against: the user's choice at filing
// ("first"), or the latest filing after any refiles ("latest"). A project
// that wasn't among the candidates counts as "none of the existing ones".
export function shadowChoice(r, basis = "first") {
  const pick = basis === "latest" && r.refiles?.length ? r.refiles.at(-1) : r.chosen;
  const known = r.candidates ? r.candidates.some(c => c.id === pick?.projectId) : !pick?.isNew;
  return { projectId: pick?.projectId, name: pick?.name || "", isNew: !known };
}

// records: the stored map's values; basis "first" or "latest" (see above).
export function shadowTally(records, basis = "first") {
  const t = { predictions: 0, agreements: 0, disagreements: 0, abstentions: 0,
    abstainedYouChoseExisting: 0, abstainedYouCreatedNew: 0, failed: 0 };
  for (const r of records) {
    if (!r.prediction) { if (r.error) t.failed++; continue; }
    t.predictions++;
    const choice = shadowChoice(r, basis);
    if (r.prediction.abstain) {
      t.abstentions++;
      if (choice.isNew) t.abstainedYouCreatedNew++; else t.abstainedYouChoseExisting++;
    } else if (!choice.isNew && r.prediction.projectId === choice.projectId) t.agreements++;
    else t.disagreements++;
  }
  t.refiled = records.filter(r => r.refiles?.length).length;
  return t;
}
