const bins = (prefix, size) => Array.from({ length: size }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
const hours = bins('mergeHour', 24), days = bins('mergeDay', 14);
const keys = ['schema', 'generatedAt', 'issuesOpen', 'issuesResolved', 'commits',
  'prsMerged24h', 'prsMerged14d', ...hours, ...days];
const panel = (body) => `<section class="fleet-counts"><h2>slipgates-fleet (private repo, counts only)</h2>${body}</section>`;
const unavailable = (reason) => {
  console.error(`Fleet counts unavailable: ${reason}`);
  return undefined;
};

export function validateFleetCounts(value, now = Date.now(), maxAge = 7200000) {
  const allowed = Object.hasOwn(value ?? {}, 'prsMergedTotal') ? [...keys, 'prsMergedTotal'] : keys;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== allowed.length ||
    allowed.some((key) => !Object.hasOwn(value, key)) || value.schema !== 1 ||
    allowed.some((key) => key !== 'generatedAt' &&
      (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100000000)))
    return unavailable('invalid schema');
  const at = typeof value.generatedAt === 'string' ? Date.parse(value.generatedAt) : NaN;
  const age = now - at;
  if (typeof value.generatedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value.generatedAt) ||
    !Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== value.generatedAt.slice(0, 19) ||
    age < -60000 || age > maxAge)
    return unavailable('invalid or stale timestamp');
  const sum = (fields) => fields.reduce((total, key) => total + value[key], 0);
  if (value.prsMerged24h !== sum(hours) || value.prsMerged14d !== sum(days))
    return unavailable('inconsistent bin totals');
  return value;
}

const stamp = (value, label = '') => {
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)))
    return `<div class="sub">${label}Update time unavailable</div>`;
  const timestamp = value.generatedAt.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<div class="sub">${label}Updated at <time data-people-generated-at datetime="${timestamp}">${timestamp}</time> (UTC)
<span class="people-stale" data-people-stale role="status">Stale</span></div>`;
};

export function renderMergedCounts(total, recent, fleet, publicGeneratedAt) {
  const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : 'Data unavailable';
  const all = count(total), last = count(recent), combined = typeof all === 'number' && fleet?.prsMergedTotal !== undefined;
  const detail = `<div class="sub">${typeof last === 'number' && combined ? count(last + fleet.prsMerged24h) : last} in the last 24 h${typeof all === 'number' && !combined ? '; agent-bridge only' : ''}</div>`;
  const sources = stamp({ generatedAt: publicGeneratedAt }, 'agent-bridge ') + (combined ? stamp(fleet, 'slipgates-fleet ') : '');
  return typeof all === 'number' ? `<div class="stat num">${count(all + (combined ? fleet.prsMergedTotal : 0))}</div>${detail}${sources}`
    : detail + '<div class="none">Data unavailable</div>';
}

export function renderFleetCounts(value) {
  if (!value) return panel('<p>Fleet counts unavailable</p>');
  const at = Date.parse(value.generatedAt);
  const table = (fields, unit, step) => {
    const end = Math.floor(at / step) * step;
    return `<table aria-label="Fleet merges per ${unit}"><caption>Completed UTC ${unit}s, oldest first</caption>
<thead><tr><th scope="col">Starting UTC</th><th scope="col">Merged</th></tr></thead><tbody>${fields.map((key, i) =>
  `<tr><td>${new Date(end - (fields.length - i) * step).toISOString()}</td><td>${value[key]}</td></tr>`).join('')}</tbody></table>`;
  };
  return panel(`<p>Issues open: ${value.issuesOpen}; resolved: ${value.issuesResolved}; commits: ${value.commits}</p>
<p>Merged: ${value.prsMerged24h} in 24 hours; ${value.prsMerged14d} in 14 days</p>
${table(hours, 'hour', 3600000)}${table(days, 'day', 86400000)}
${stamp(value)}`);
}
