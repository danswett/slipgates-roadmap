import { readFileSync } from 'node:fs';

const bins = (prefix, size) => Array.from({ length: size }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);
const hours = bins('mergeHour', 24), days = bins('mergeDay', 14);
const keys = ['schema', 'generatedAt', 'issuesOpen', 'issuesResolved', 'commits',
  'prsMerged24h', 'prsMerged14d', ...hours, ...days];
const panel = (body) => `<section class="fleet-counts"><h2>slipgates-fleet (private repo, counts only)</h2>${body}</section>`;
const unavailable = (reason) => {
  console.error(`Fleet counts unavailable: ${reason}`);
  return panel('<p>Fleet counts unavailable</p>');
};

export function renderFleetCounts(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return unavailable('missing or invalid file');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) || value.schema !== 1 ||
    keys.some((key) => key !== 'generatedAt' &&
      (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 100000000)))
    return unavailable('invalid schema');
  const at = typeof value.generatedAt === 'string' ? Date.parse(value.generatedAt) : NaN;
  const age = Date.now() - at;
  if (typeof value.generatedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value.generatedAt) ||
    !Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== value.generatedAt.slice(0, 19) ||
    age < -60000 || age > 7200000)
    return unavailable('invalid or stale timestamp');
  const sum = (fields) => fields.reduce((total, key) => total + value[key], 0);
  if (value.prsMerged24h !== sum(hours) || value.prsMerged14d !== sum(days))
    return unavailable('inconsistent bin totals');
  const table = (fields, unit, step) => {
    const end = Math.floor(at / step) * step;
    return `<table aria-label="Fleet merges per ${unit}"><caption>Completed UTC ${unit}s, oldest first</caption>
<thead><tr><th scope="col">Starting UTC</th><th scope="col">Merged</th></tr></thead><tbody>${fields.map((key, i) =>
  `<tr><td>${new Date(end - (fields.length - i) * step).toISOString()}</td><td>${value[key]}</td></tr>`).join('')}</tbody></table>`;
  };
  return panel(`<p>Issues open: ${value.issuesOpen}; resolved: ${value.issuesResolved}; commits: ${value.commits}</p>
<p>Merged: ${value.prsMerged24h} in 24 hours; ${value.prsMerged14d} in 14 days</p>
${table(hours, 'hour', 3600000)}${table(days, 'day', 86400000)}
<p>Generated at <time datetime="${value.generatedAt}">${value.generatedAt}</time> (UTC)</p>`);
}
