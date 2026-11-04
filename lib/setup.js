// Setup detection: is a captured response just the project goal being
// defined (the assistant restating what the user typed), rather than work?
// Setup is not work, so such captures are recorded as SETUP and never enter
// the ledger's rounds or the checks.
//
// Compares content words (lowercased, light stemming, stop words dropped):
//   goalCovered     - share of the goal's words that appear in the response
//   responseCovered - share of the response's words that come from the goal
//   lengthRatio     - response length / goal length, in content words
// A response is setup when it reproduces most of the goal without adding much
// (a restatement), or when it is almost entirely goal words (a summary of it).

const STOP = new Set(("the and for that this with from are was were will have has had not but you your our its can any " +
  "all into than then they them their there what when which who how should would could been being also just only " +
  "more most such each per via out about over under does did done doing make made get got here let lets let's sure okay " +
  "goal goals project scope out-of-scope explicitly looks like").split(" "));

function stem(w) {
  if (w.length > 5) return w.replace(/(ing|ed|es|s)$/, "");
  if (w.length > 4) return w.replace(/s$/, "");
  return w;
}

export function contentWords(text) {
  return (String(text || "").toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [])
    .filter(w => w.length >= 3 && !STOP.has(w))
    .map(stem);
}

export function setupMatch(response, project) {
  const goalWords = contentWords(`${project?.goal || ""}\n${project?.outOfScope || ""}`);
  const respWords = contentWords(response);
  const g = new Set(goalWords);
  const r = new Set(respWords);
  const none = { isSetup: false, goalCovered: 0, responseCovered: 0, lengthRatio: 0 };
  // Too little text to tell a restatement from a short reply that happens to
  // reuse a few goal words.
  if (g.size < 5 || r.size < 5) return none;
  let shared = 0;
  for (const w of g) if (r.has(w)) shared++;
  const goalCovered = shared / g.size;
  const responseCovered = shared / r.size;
  const lengthRatio = respWords.length / goalWords.length;
  const restatement = goalCovered >= 0.6 && lengthRatio <= 2;
  const summary = responseCovered >= 0.8 && goalCovered >= 0.5;
  const round2 = x => Math.round(x * 100) / 100;
  return {
    isSetup: restatement || summary,
    goalCovered: round2(goalCovered),
    responseCovered: round2(responseCovered),
    lengthRatio: round2(lengthRatio),
  };
}
