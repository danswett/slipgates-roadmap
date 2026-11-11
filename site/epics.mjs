const count = (n) => Number.isSafeInteger(n) && n >= 0;
export const validEpicDetails = (e) => [e.priority_order, e.open_prs, e.merged_last_24h,
  e.closed + e.open].every(count) && Array.isArray(e.blockers) &&
  e.blockers.every((n) => count(n) && n > 0);

const icon = (path) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const warning = icon('M10 3l7.5 13h-15z M10 8.5v3.5M10 14.5v.01');
const check = icon('M4.5 10.5l3.5 3.5 7.5-8');
const issue = (number) => `https://github.com/danswett/agent-bridge/issues/${number}`;

export function renderEpics(epics, escape) {
  return [...epics].sort((a, b) => a.priority_order - b.priority_order || a.number - b.number).map((e) => {
    const total = e.closed + e.open, percent = total ? Math.round(e.closed / total * 100) : 0;
    const blocked = e.blockers.length > 0;
    const status = blocked
      ? `<span class="chip blocked">${warning}<span>Blocked: ${e.blockers.map((n) =>
        `<a href="${issue(n)}">#${n}</a>`).join(', ')}</span></span>`
      : total > 0 && e.open === 0 ? `<span class="chip done">${check}Done</span>` : '';
    return `<li class="card epic${blocked ? ' is-blocked' : ''}"><h3><a href="${issue(e.number)}"><span class="id mono">#${e.number}</span> ${escape(e.title)}</a></h3><span class="pct num">${percent}%</span>` +
      `<div class="bar sm" role="progressbar" aria-label="${escape(e.title)}" aria-valuemin="0" aria-valuemax="${Math.max(total, 1)}" aria-valuenow="${e.closed}" aria-valuetext="${e.closed} of ${total} slices done"><i style="--p:${percent}%"></i></div>` +
      `<div class="meta"><span class="num">${e.closed} of ${total} done; ${e.open} open</span><span class="num">${e.open_prs} open PRs</span><span class="num">${e.merged_last_24h} merged in 24 h</span>${status}</div></li>`;
  }).join('');
}
