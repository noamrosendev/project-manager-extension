// One-time repairs of stored project definitions. None in this release.
export const REPAIRS = Object.freeze([]);

// projects: stored project records (mutated when restored). done: the
// repairs already run, by id. Returns one result per repair run now:
// { id, project, field, outcome, from, to }.
export function applyRepairs(projects, done = {}) {
  const out = [];
  for (const r of REPAIRS) {
    if (done[r.id]) continue;
    const p = projects.find(x => x?.id === r.project);
    if (!p) continue;   // not this install's project: nothing to do, and not marked run
    if (p[r.field] !== r.expect) {
      out.push({ id: r.id, project: r.project, field: r.field, outcome: `skipped: the field no longer holds the text this repair was written against${r === REPAIRS[0] ? " (it has changed since 25 Oct)" : ""}, so it is left alone` });
      continue;
    }
    const from = p[r.field];
    p[r.field] = r.restore;
    out.push({ id: r.id, project: r.project, field: r.field, outcome: "restored", from, to: r.restore });
  }
  return out;
}
