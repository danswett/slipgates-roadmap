import { staleBadge } from './stale.mjs';
// Cost per merge tile: the public aggregate cost.json (units per merge, units by role, coordination share, 7 days).
// Aggregates only. Validated field by field; a bad or missing file is Data unavailable, an old one shows the shared Stale badge.
export const COST_TARGET = 300;
const STALE_AFTER = 3 * 3600000;
const ROLES = ['Lead', 'Chief', 'Builder', 'Reviewer', 'Other'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const whole = (n, high) => Number.isInteger(n) && n >= 0 && n <= high;
const num = (n, high) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= high;
const orNull = (check) => (n, high) => n === null || check(n, high);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const consistent = (units, merges, ratio) => merges === null || merges === 0 ? ratio === null
  : ratio !== null && Math.abs(ratio - units / merges) <= 0.1;  // a ratio must follow from its own units and merges
const unavailable = (reason) => { console.error(`Cost unavailable: ${reason}`); return undefined; };

export function validateCost(value, now = Date.now()) {
  const top = ['schema', 'generatedAt', 'day', 'units', 'merges', 'unitsPerMerge', 'coordinationSharePct', 'roles', 'series'];
  if (!exact(value, top) || value.schema !== 1 || !isDay(value.day) || !whole(value.units, 1e9) ||
    !orNull(whole)(value.merges, 1e6) || !orNull(num)(value.unitsPerMerge, 1e7) || !orNull(num)(value.coordinationSharePct, 100))
    return unavailable('invalid schema');
  if (!consistent(value.units, value.merges, value.unitsPerMerge)) return unavailable('inconsistent ratio');
  if (typeof value.generatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.generatedAt) ||
    !Number.isFinite(Date.parse(value.generatedAt)) || Date.parse(value.generatedAt) - now > 60000) return unavailable('invalid timestamp');
  if (!value.roles || typeof value.roles !== 'object' || Array.isArray(value.roles) ||
    !Object.entries(value.roles).every(([name, r]) => ROLES.includes(name) && exact(r, ['units', 'unitsPerMerge']) &&
      whole(r.units, 1e9) && orNull(num)(r.unitsPerMerge, 1e7))) return unavailable('invalid roles');
  if (!Array.isArray(value.series) || value.series.length !== 7 ||
    !value.series.every((d) => exact(d, ['day', 'units', 'merges', 'unitsPerMerge', 'coordinationSharePct']) && isDay(d.day) &&
      orNull(whole)(d.units, 1e9) && orNull(whole)(d.merges, 1e6) && orNull(num)(d.unitsPerMerge, 1e7) && orNull(num)(d.coordinationSharePct, 100)))
    return unavailable('invalid series');
  const days = value.series.map((d) => d.day);
  if (days.some((d, i) => i && d <= days[i - 1]) || days[6] !== value.day ||
    !value.series.every((d) => d.units === null ? d.merges === null && d.unitsPerMerge === null : consistent(d.units, d.merges, d.unitsPerMerge)))
    return unavailable('series out of order or inconsistent');
  return value;
}

const card = (body) => `<section class="card cost" aria-labelledby="h-cost"><h2 id="h-cost">Cost per merge</h2>${body}</section>`;
const fmt = (n) => Number(n.toFixed(1)).toString();

export function renderCostTile(cost, now = Date.now()) {
  if (!cost) return card('<p class="none">Data unavailable</p>');
  const ratio = cost.unitsPerMerge;
  const old = now - Date.parse(cost.generatedAt) > STALE_AFTER;
  const shown = ratio === null ? null : Number(fmt(ratio));  // the verdict follows the number shown
  const verdict = ratio === null ? '' : shown > COST_TARGET ? ` (above the ${COST_TARGET} target)` : ` (within the ${COST_TARGET} target)`;
  const head = ratio === null ? '<div class="none">Data unavailable</div>'
    : `<div class="stat num">${fmt(ratio)}<small>units per merge ${old ? `on ${cost.day}` : 'today'}, target ${COST_TARGET}${verdict}</small></div>`;
  const roles = ['Lead', 'Chief', 'Builder', 'Reviewer'].filter((name) => cost.roles[name]).map((name) => {
    const r = cost.roles[name];
    return `<tr><th scope="row">${name}</th><td>${r.unitsPerMerge === null ? 'Data unavailable' : fmt(r.unitsPerMerge)}</td><td>${r.units}</td></tr>`;
  }).join('');
  const share = cost.coordinationSharePct === null ? 'Data unavailable' : `${fmt(cost.coordinationSharePct)}%`;
  const max = Math.max(COST_TARGET * 1.25, ...cost.series.map((d) => d.unitsPerMerge ?? 0));
  const y = (v) => (112 - v / max * 100).toFixed(1);
  const bars = cost.series.map((d, i) => d.unitsPerMerge === null ? '' :
    `<rect class="cost-bar${i === 6 ? ' today' : ''}" x="${(8 + i * 78).toFixed(0)}" width="60" y="${y(d.unitsPerMerge)}" height="${(112 - y(d.unitsPerMerge)).toFixed(1)}"/>`).join('');
  const chart = `<svg class="spark" viewBox="0 0 560 120" role="img" aria-label="Units per merge over the last 7 days, target ${COST_TARGET}">
<line class="axis" x1="0" x2="560" y1="112" y2="112"/>${bars}<line class="cost-target" x1="0" x2="560" y1="${y(COST_TARGET)}" y2="${y(COST_TARGET)}"/></svg>
<div class="axis-l" aria-hidden="true"><span>6 days ago</span><span>Today (dashed line: target ${COST_TARGET})</span></div>`;
  const rows = cost.series.map((d) => `<tr><td>${d.day}</td><td>${d.unitsPerMerge === null ? 'Data unavailable' : fmt(d.unitsPerMerge)}</td></tr>`).join('');
  return card(`${head}${old ? staleBadge({ stale_since: cost.generatedAt }) : ''}<p class="sub">Of all units, the coordination (Lead and Chief) share is ${share}.</p>
<table aria-label="Units per merge by role"><thead><tr><th scope="col">Role</th><th scope="col">Units per merge</th><th scope="col">Units today</th></tr></thead><tbody>${roles}</tbody></table>
${chart}<details><summary>View as a table</summary><table><caption>Units per merge, last 7 days (Pacific days)</caption>
<thead><tr><th scope="col">Date</th><th scope="col">Units per merge</th></tr></thead><tbody>${rows}</tbody></table></details>
<p class="sub">Claude Code and Codex units (Opus 15, others 1) over all merges of both repos.${old ? '' : ` Updated <time data-people-generated-at datetime="${cost.generatedAt}">${cost.generatedAt}</time><span data-age></span>.`}</p>`);
}
