import { readFileSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFleetCounts, renderMergedCounts } from './fleet-counts.mjs';
import { renderEpics, renderNeedsBlocker, renderBlockers, validEpicDetails } from './epics.mjs';
import { renderCharts } from './charts.mjs';
import { renderPeopleCounts } from './people-at-work.mjs';
import { readPeopleCounts, readFleetCounts } from './counts-files.mjs';

const [data = 'data/roadmap.json', out = '_site', fleet = 'data/fleet-counts.json', people = 'data/people-at-work.json'] = process.argv.slice(2);
let value, reason = '';
try {
  value = JSON.parse(readFileSync(data, 'utf8'));
  const age = Date.now() - Date.parse(value?.updatedAt);
  if (typeof value?.error === 'string') reason = value.error || 'Repository read failed.';
  else if (typeof value?.unavailable === 'string') reason = value.unavailable || 'Repository data is unavailable.';
  else if (typeof value?.updatedAt !== 'string' || !Number.isFinite(age) || age < -60000 || age > 15 * 60000)
    reason = 'Data artifact is missing a valid update time or is out of date.';
  else if (!Array.isArray(value.epics) || !value.stats || typeof value.stats !== 'object' || Array.isArray(value.stats) ||
    value.epics.some((epic) => !epic || typeof epic.title !== 'string' ||
      ![epic.number, epic.closed, epic.open].every((n) => Number.isSafeInteger(n) && n >= 0) || !validEpicDetails(epic)))
    reason = 'Data artifact has invalid epic or statistics fields.';
} catch (error) {
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  reason = error.code === 'ENOENT' ? 'Data artifact is missing.' : 'Data artifact is invalid JSON.';
}
if (reason) console.error(`Data unavailable: ${reason}`);
const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const timestamp = typeof value?.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString();
const updated = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(timestamp)) + ' PT';
const count = (n) => {
  if (Number.isSafeInteger(n) && n >= 0) return n;
  console.error('Data unavailable: a repository statistic is missing or invalid.');
  return 'Data unavailable';
};
const stats = value?.stats?.['danswett/agent-bridge'], issues = stats?.issues?.counts;
const fleetCounts = readFleetCounts(fleet);
const glyph = (body) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const warn = glyph('<path d="M10 3l7.5 13h-15zM10 8.5v3.5M10 14.5v.01"/>');
const clock = glyph('<circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2.5"/>');
const mark = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8L13 8C10.791 8 9 9.791 9 12L6 12C6 8.134 9.134 5 13 5L21 5ZM3 16L11 16C13.209 16 15 14.209 15 12L18 12C18 15.866 14.866 19 11 19L3 19Z" fill="currentColor"/></svg>';
const percent = (done, total) => total ? Math.round(done / total * 100) : 0;
const bar = (done, total, label, small = false) => `<div class="bar${small ? ' sm' : ''}" role="progressbar" aria-label="${escape(label)}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-valuetext="${done} of ${total} ${label === 'Issues resolved' ? 'resolved' : 'slices done'}"><i style="--p:${percent(done, total)}%"></i></div>`;
const epics = reason ? [] : value.epics.filter((e) => !e.repository || e.repository === 'danswett/agent-bridge');
const done = epics.reduce((n, e) => n + e.closed, 0), total = epics.reduce((n, e) => n + e.closed + e.open, 0);
const tile = (title, body) => `<div class="card"><h2>${title}</h2>${body}</div>`;
const number = (n) => { const result = count(n); return `<div class="${typeof result === 'number' ? 'stat num' : 'none'}">${result}</div>`; };
const mergedTile = () => `<div data-live-merged data-total="${count(stats?.prsMergedTotal)}" data-recent="${count(stats?.merges?.last_24_hours)}" data-generated-at="${escape(timestamp)}">${renderMergedCounts(stats?.prsMergedTotal, stats?.merges?.last_24_hours, fleetCounts, timestamp)}</div>`;
const peopleTile = () => `<div data-live-counts="people">${renderPeopleCounts(readPeopleCounts(people))}</div>`;
const time = `<time datetime="${escape(timestamp)}">${escape(updated)}</time>`, stale = Date.now() - Date.parse(timestamp) > 15 * 60000;
const stamp = `<span class="stamp${reason ? ' stale' : ''}">${reason ? warn : clock}<span>${stale ? 'Out of date. Last update ' : reason ? 'Data unavailable. ' : 'Updated '}${time}</span></span>`;
const content = reason
  ? `<section class="hero"><h1>Data unavailable</h1><p class="lede">The roadmap could not read its data at ${time}. It tries again every few minutes. Nothing is lost.</p>${stale ? `<p class="lede">The last good update was at ${time}.</p>` : ''}</section>`
  : `<section class="hero"><h1>Where Slipgates stands</h1><p class="lede">Progress on each epic, and how fast the work is landing. Public repository data only.</p>
<div class="hero-bar"><div class="row"><span class="big num">${percent(done, total)}%</span><span class="lbl">${done} of ${total} planned slices done across ${epics.length} epics</span></div>${bar(done, total, 'All epics')}</div></section>
<div class="grid tiles" aria-label="Totals">${tile('Commits', number(stats?.commits?.total) + '<div class="sub">on main, all time</div>')}
${tile('Pull requests merged', mergedTile())}
${tile('Issues resolved', `<div class="stat num">${count(issues?.resolved)}<small>of ${count(issues?.total)}</small></div>` + ([issues?.resolved, issues?.total].every(Number.isSafeInteger) && issues.resolved >= 0 && issues.total >= issues.resolved ? bar(issues.resolved, issues.total, 'Issues resolved', true) : ''))}
${tile('People at work', peopleTile())}</div>${renderCharts(stats)}
<section class="grid" aria-labelledby="h-ep"><h2 id="h-ep">Epics</h2><ul class="epics">${renderEpics(epics, escape)}</ul></section>${renderBlockers(epics, escape)}${renderNeedsBlocker(epics, escape)}`;
mkdirSync(out, { recursive: true });
for (const asset of ['tokens.css', 'style.css', 'blockers.css', 'fonts', 'people-freshness.mjs', 'live-counts.mjs', 'people-at-work.mjs', 'fleet-counts.mjs']) cpSync(fileURLToPath(new URL(asset, import.meta.url)), join(out, asset), { recursive: true });
writeFileSync(join(out, 'CNAME'), 'roadmap.slipgates.com\n');
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src https://raw.githubusercontent.com/danswett/slipgates-roadmap/fleet-counts/; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'">
<title>Slipgates roadmap</title><meta name="color-scheme" content="light dark"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="blockers.css">
</head><body><div class="wrap"><header class="top"><a class="lockup" href="./">${mark}<span>Slipgates</span><span class="sep" aria-hidden="true">/</span><span>Roadmap</span></a>${stamp}</header><main>
${content}<div data-live-counts="fleet">${renderFleetCounts(fleetCounts)}</div>
</main><footer><span>Public data from github.com/danswett/agent-bridge; private slipgates-fleet epics are not included.</span><span>No cookies or trackers. Counts read from public GitHub.</span></footer></div><script type="module" src="live-counts.mjs"></script></body></html>
`);
