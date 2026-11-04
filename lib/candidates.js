// Mechanical candidate generation (matcher plan, phase 2): for an open
// commitment, the sentences of the USER's message most likely to show it
// done, ranked. No model is involved anywhere here.
//
// A sentence's score is the number of distinct content-word stems it shares
// with the commitment's text, plus DONE_BONUS if it carries a done marker.
// A sentence scoring at least 1 is a candidate; candidates are ranked by
// score, then by their order in the message. All parameters are fixed here,
// before any measurement: they are not tuned to a result.

export const DONE_BONUS = 1;
export const MIN_SCORE = 1;

// Words that say something happened or is finished.
export const DONE_MARKERS = Object.freeze([
  "gone", "removed", "fixed", "shipped", "passes", "passed", "pass", "no longer", "confirmed",
  "it works", "works now", "now works", "done", "completed", "complete", "finished", "committed",
  "deployed", "succeeded", "successfully", "successful", "merged", "resolved", "built", "installed",
  "is live", "went live", "ran", "updated", "created", "saved",
]);
const DONE_RE = new RegExp(`\\b(?:${DONE_MARKERS.map(m => m.replace(/ /g, "\\s+")).join("|")})\\b`, "i");

const STOP = new Set(("the and for with that this from into onto then than them they their there these those your yours you " +
  "our ours are was were been being have has had not but all any can will would should could may might must just only also " +
  "its it's into about over under after before when where which while what who whom whose how why one two each every some " +
  "more most other such very own same out off now here use used using via per").split(" "));

// A light suffix stemmer: enough that "removed", "removes" and "remove" meet.
export function stem(w) {
  for (const suf of ["ingly", "edly", "ing", "ed", "es", "ly", "s"]) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) return w.slice(0, -suf.length);
  }
  return w;
}
export function stems(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

// The user's message as sentences: lines first, then sentence ends.
export function sentences(text) {
  return String(text || "").split(/\n+/).flatMap(l => l.split(/(?<=[.!?])\s+/)).map(s => s.trim()).filter(Boolean);
}

export function hasDoneMarker(s) { return DONE_RE.test(s); }

// Phase 2b: exact identifiers in pasted machine output. A commitment's
// identifiers come from its context (its text, source sentence and the
// reply that raised it); each one a user sentence carries exactly
// (case-sensitive) adds IDENT_BONUS to its score. Not content words, not
// done markers.
// Run A: compared on the VALUE side. In KEY=value and key: value forms only
// the value counts (one starting with $, a shell variable, does not); key
// names alone no longer count. Commit hashes (7-40 hex characters with a
// digit and a letter) and run ids (tokens with two or more hyphens) are
// values. A line containing command-substitution syntax ($( or a backtick)
// is not a candidate at all.
export const IDENT_BONUS = 1;
const VALUE_RE = /[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*["']?([^\s"',;)]+)/g;
const STANDALONE_RES = [
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  /\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+){2,}\b/g,
];
export const COMMAND_SUBSTITUTION = /\$\(|`/;
export function identifiers(text) {
  const out = new Set();
  for (const m of String(text || "").matchAll(VALUE_RE)) if (!m[1].startsWith("$")) out.add(m[1]);
  for (const re of STANDALONE_RES) for (const m of String(text || "").matchAll(re)) out.add(m[0]);
  return out;
}

// Ranked candidates for one commitment: [{ sentence, score, overlap, done, ids }].
// context (phase 2b, optional): the commitment's source sentence and raising
// reply, read for identifiers only.
export function candidates(commitmentText, userText, context = "") {
  const want = stems(commitmentText);
  const wantIds = context ? identifiers(`${commitmentText}\n${context}`) : new Set();
  const out = [];
  sentences(userText).forEach((sentence, pos) => {
    if (COMMAND_SUBSTITUTION.test(sentence)) return;   // a command, not its output
    let overlap = 0;
    for (const s of stems(sentence)) if (want.has(s)) overlap++;
    const done = hasDoneMarker(sentence);
    let ids = 0;
    for (const id of identifiers(sentence)) if (wantIds.has(id)) ids++;
    const score = overlap + (done ? DONE_BONUS : 0) + ids * IDENT_BONUS;
    if (score >= MIN_SCORE) out.push({ sentence, score, overlap, done, ids, pos });
  });
  return out.sort((a, b) => b.score - a.score || a.pos - b.pos).map(({ pos, ...c }) => c);
}
