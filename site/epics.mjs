const count = (n) => Number.isSafeInteger(n) && n >= 0;
const validBlockers = (items) => Array.isArray(items) && items.every(b => b &&
  (b.number === null || (count(b.number) && b.number > 0)) && typeof b.title === 'string' && typeof b.reason === 'string');
export const validEpicDetails = (e) => [e.priority_order, e.open_prs, e.merged_last_24h,
  e.closed + e.open].every(count) && Array.isArray(e.blockers) &&
  e.blockers.every((n) => count(n) && n > 0) &&
  (e.blockerDetails === undefined || validBlockers(e.blockerDetails)) &&
  (e.blockedChildren === undefined || (Array.isArray(e.blockedChildren) && e.blockedChildren.every(c =>
    c && count(c.number) && c.number > 0 && typeof c.title === 'string' && validBlockers(c.blockers))));

const icon = (path) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const warning = icon('M10 3l7.5 13h-15z M10 8.5v3.5M10 14.5v.01');
const check = icon('M4.5 10.5l3.5 3.5 7.5-8');
const issue = (number) => `https://github.com/danswett/agent-bridge/issues/${number}`;
const role = (value) => ['Engineering', 'Quality', 'Product', 'SRE', 'Creative', 'Migration', 'Owner'].includes(value) ? value : 'Unassigned';
const rows = (e) => {
  const children = e.blockedChildren ?? e.blockers.map(number => ({ number, title: '', blockers: [] }));
  const own = (e.blockerDetails ?? []).filter(b => !children.some(c =>
    c.blockers.some(other => ['number', 'title', 'reason', 'clearsIt'].every(key => b[key] === other[key]))));
  return own.length || (!children.length && e.blocked) ? [{ ...e, blockers: own, clearsIt: own[0]?.clearsIt }, ...children] : children;
};
const recorded = (b) => b.number !== null;
const link = (n, title, escape) => `<a href="${issue(n)}"><span class="id">#${n}</span>${escape(title)}</a>`;
function blockedBadge(items, escape) {
  if (!items.length) return '';
  const first = items.flatMap(c => c.blockers).find(recorded);
  const label = first ? `<b>Blocked by ${first.title === 'private item' ? 'private item' : `#${first.number}`}</b> (${escape(first.reason)})` : '<b>Blocked</b>: no blocker recorded';
  const list = items.map(c => `<li><span class="child">${link(c.number, c.title, escape)}</span>` +
    (c.blockers.some(recorded) ? c.blockers.filter(recorded).map(b => `<span class="by">Blocked by ${b.title === 'private item' ? 'private item' : link(b.number, b.title, escape)} (${escape(b.reason)})</span>`).join('') :
      '<span class="by">No blocker recorded</span><span class="who">Add "Blocked by #N" and "Clears it: role" to the issue.</span>') +
    `<span class="who">Clears it: <b>${role(c.clearsIt)}</b></span></li>`).join('');
  return `<details class="blk${first ? '' : ' none'}"><summary>${warning}<span class="what">${label}</span>${items.length > 1 ? `<span class="more">+${items.length - 1} more</span>` : ''}<span class="chev">${icon('M5 8l5 5 5-5')}</span></summary><ul class="blk-list">${list}</ul></details>`;
}
export function renderNeedsBlocker(epics, escape) {
  const missing = [...new Map(epics.flatMap(rows).filter(c => !c.blockers.some(recorded)).map(c => [c.number, c])).values()];
  return missing.length ? `<section class="need" aria-labelledby="h-need"><h2 id="h-need">Needs a blocker (${missing.length})</h2><p>These issues are marked blocked but have no stated blocker. Add two lines to each issue.</p><ul>${missing.map(c => `<li>${link(c.number, c.title, escape)}</li>`).join('')}</ul><p>Lines to add: <code>Blocked by #N</code> and <code>Clears it: Engineering</code></p></section>` : '';
}

export function renderBlockers(epics, escape) {
  const blocked = [...epics].sort((a, b) => a.priority_order - b.priority_order || a.number - b.number)
    .map(e => ({ epic: e, items: rows(e) })).filter(({ items }) => items.length);
  const entries = blocked.map(({ epic, items }) => {
    const causes = items.flatMap(c => c.blockers.some(recorded) ? c.blockers.filter(recorded).map(b =>
      `${b.title === 'private item' ? 'Blocked by private item' : `Blocked by #${b.number}: ${escape(b.reason)}`}. Clears it: ${role(b.clearsIt ?? c.clearsIt)}.`) :
      [`No blocker recorded. Clears it: ${role(c.clearsIt)}.`]);
    return `<li>${warning}<div>${link(epic.number, epic.title, escape)}<p class="sub">${[...new Set(causes)].join('<br>')}</p></div></li>`;
  }).join('');
  return `<section class="card block" aria-labelledby="h-bl"><h2 id="h-bl">Blockers</h2>${entries ? `<ul>${entries}</ul>` : '<p class="none">No blockers.</p>'}</section>`;
}

export function renderEpics(epics, escape) {
  return [...epics].sort((a, b) => a.priority_order - b.priority_order || a.number - b.number).map((e) => {
    const total = e.closed + e.open, percent = total ? Math.round(e.closed / total * 100) : 0;
    const items = rows(e), blocked = items.length > 0;
    const status = blocked
      ? ''
      : (total > 0 && e.open === 0) || e.state === 'CLOSED' ? `<span class="chip done">${check}Done</span>` : '';
    return `<li class="card epic${blocked ? ' is-blocked' : ''}"><h3><a href="${issue(e.number)}"><span class="id mono">#${e.number}</span> ${escape(e.title)}</a></h3>` +
      (total ? `<span class="pct num">${percent}%</span><div class="bar sm" role="progressbar" aria-label="${escape(e.title)}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${e.closed}" aria-valuetext="${e.closed} of ${total} slices done"><i style="--p:${percent}%"></i></div>` : '') +
      `<div class="meta"><span class="${total ? 'num' : 'none'}">${total ? `${e.closed} of ${total} done; ${e.open} open` : 'No slices planned'}</span><span class="num">${e.open_prs} open PRs</span><span class="num">${e.merged_last_24h} merged in 24 h</span>${status}</div>${blockedBadge(items, escape)}</li>`;
  }).join('');
}
