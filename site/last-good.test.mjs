import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCharts } from './charts.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 2026-11-23: Commits and Main CI time read "Data unavailable" for days. When the data job keeps the last good value because a read
// failed, the page shows that value and says it is the last good one, with its as-of time (stats.asOf), instead of passing it off as fresh.
const asOf = '2026-11-23T16:14:00+00:00';
function build(stats) {
  const dir = mkdtempSync(join(tmpdir(), 'last-good-'));
  try {
    const data = join(dir, 'roadmap.json'), out = join(dir, 'out');
    writeFileSync(data, JSON.stringify({ updatedAt: new Date().toISOString(), epics: [],
      stats: { 'danswett/agent-bridge': { issues: { counts: { resolved: 90, total: 123 } }, prsMergedTotal: 1, merges: { last_24_hours: 2 }, ...stats } } }));
    const run = spawnSync(process.execPath, ['site/build.mjs', data, out, join(dir, 'missing-fleet'), join(dir, 'missing-people')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(out, 'index.html'), 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const commitsTile = (html) => html.split('<h2>Commits</h2>')[1].split('</div></div>')[0];

test('a fresh commits total says nothing about last good', () => {
  const tile = commitsTile(build({ commits: { total: 616, per_day: [] } }));
  assert.match(tile, /class="stat num">616<\/div>/);
  assert.doesNotMatch(tile, /last good/i);
});

test('a last good commits total is shown with its as-of time and a last-good note, never as Data unavailable', () => {
  const tile = commitsTile(build({ commits: { total: 616, per_day: [] }, asOf: { commits: asOf } }));
  assert.match(tile, /class="stat num">616<\/div>/);
  assert.match(tile, /last good, as of Nov 23, 8:14 AM PT/);
  assert.doesNotMatch(tile, /Data unavailable/);
});

test('commits with no stored value still read Data unavailable, never a number', () => {
  assert.match(commitsTile(build({})), /Data unavailable/);
});

test('a last good main CI time is shown with its as-of time', () => {
  const html = renderCharts({ ci: { median_minutes: 6.8, samples: 3 }, asOf: { ci: asOf } });
  const ci = html.split('<h3>Main CI time</h3>')[1].split('</section>')[0];
  assert.match(ci, /6\.8/);
  assert.match(ci, /last good, as of Nov 23, 8:14 AM PT/);
  assert.doesNotMatch(renderCharts({ ci: { median_minutes: 6.8, samples: 3 } }).split('<h3>Main CI time</h3>')[1].split('</section>')[0], /last good/i);
});

test('an invalid as-of time is ignored, not printed', () => {
  const html = build({ commits: { total: 616, per_day: [] }, asOf: { commits: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(html, /onerror|<img/);
  assert.doesNotMatch(commitsTile(html), /last good, as of/);
});
