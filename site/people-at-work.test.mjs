import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPeopleCounts } from './counts-files.mjs';

const now = Date.parse('2026-11-11T16:00:00Z');
const sample = (at = now) => ({ schema: 1, generatedAt: new Date(at).toISOString(), builders: 3, reviewers: 2 });
const markers = ['PRIVATE-NAME-1945', 'PRIVATE-NODE-1945', 'PRIVATE-MACHINE-1945', 'PRIVATE-TITLE-1945', 'PRIVATE-PATH-1945'];
function withFile(input, action) {
  const dir = mkdtempSync(join(tmpdir(), 'people-1945-')), path = join(dir, 'people.json');
  try {
    if (input !== undefined) writeFileSync(path, typeof input === 'string' ? input : JSON.stringify(input));
    return action(path, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function render(input) {
  return withFile(input, (path, dir) => {
    const data = join(dir, 'roadmap.json'), out = join(dir, 'out');
    writeFileSync(data, JSON.stringify({ updatedAt: new Date().toISOString(), epics: [],
      people: { builders: 999, reviewers: 998 }, stats: { 'danswett/agent-bridge': {
        commits: { total: 123 }, issues: { counts: { resolved: 2, total: 4 } } } } }));
    const run = spawnSync(process.execPath, ['site/build.mjs', data, out, join(dir, 'missing-fleet'), path], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    return { html, tile: html.split('<h2>People at work</h2>')[1].split('</div></div>')[0], stderr: run.stderr };
  });
}

test('only the exact bounded schema with a real fresh UTC time is accepted', () => {
  for (const input of [sample(), { ...sample(now - 900000), builders: 0, reviewers: 1000 },
    sample(now + 60000), { ...sample(), generatedAt: '2026-11-11T16:00:00+00:00' }])
    withFile(input, (path) => assert.deepEqual(readPeopleCounts(path, now), input));
  const missing = sample(); delete missing.reviewers;
  for (const input of [undefined, '{', null, [], {}, missing, { ...sample(), schema: 2 },
    ...['3', true, null, {}, [], -1, 1.5, 1001].map((builders) => ({ ...sample(), builders })),
    ...['bad', null, '2026-02-30T16:00:00Z', '2026-11-11T16:00:00', '2026-11-11T17:00:00+01:00',
      new Date(now - 900001).toISOString(), new Date(now + 60001).toISOString()].map((generatedAt) => ({ ...sample(), generatedAt })),
    ...['name', 'node', 'machine', 'title', 'path'].map((key, i) => ({ ...sample(), [key]: markers[i] }))])
    withFile(input, (path) => assert.equal(readPeopleCounts(path, now), undefined));
});

test('the tile uses only validated public counts, never fallback roadmap people or rejected text', () => {
  const valid = { ...sample(Date.now() - 60000), builders: 0, reviewers: 1000 };
  const good = render(valid);
  assert.match(good.tile, /class="stat num">0<\/div><span class="sub">builders/);
  assert.match(good.tile, /class="stat num">1000<\/div><span class="sub">reviewers/);
  assert.ok(good.html.includes(`datetime="${valid.generatedAt}"`));
  assert.doesNotMatch(good.tile, /Data unavailable|999|998/);
  for (const input of [undefined,
    ...markers.map((marker) => ({ ...valid, privateName: marker })),
    { ...valid, builders: markers[0] }, { ...valid, generatedAt: markers[1] }]) {
    const bad = render(input);
    assert.match(bad.tile, /Data unavailable/);
    assert.doesNotMatch(bad.tile, /class="stat num"|999|998/);
    assert.match(bad.html, /<h2>Commits<\/h2><div class="stat num">123/);
    for (const marker of markers) assert.ok(!(bad.html + bad.stderr).includes(marker));
  }
});

// 2026-11-23: the counts task stopped publishing and the people tile read "Data unavailable" for days. The last good file is shown with its
// own as-of time and the Stale badge instead; a file that is invalid, from the future or not the exact schema is still unavailable.
test('a stale but valid people file shows the last good counts with their as-of time and the Stale badge, not Data unavailable', () => {
  for (const age of [901000, 3 * 86400000]) {
    const old = sample(Date.now() - age), { html, tile } = render(old);
    assert.match(tile, /class="stat num">3<\/div><span class="sub">builders/);
    assert.match(tile, /class="stat num">2<\/div><span class="sub">reviewers/);
    assert.doesNotMatch(tile, /Data unavailable|999|998/);
    assert.ok(html.includes(`datetime="${old.generatedAt}"`));
    assert.match(html, /<span\b[^>]*data-people-stale[^>]*>Stale<\/span>/);
  }
  for (const input of [sample(Date.now() + 3600000), { ...sample(Date.now() - 86400000), builders: markers[0] }, { ...sample(Date.now() - 86400000), schema: 2 }])
    assert.match(render(input).tile, /Data unavailable/);
});

test('the strict reader still rejects an old file unless the caller asks for the last good one', () => {
  const old = sample(now - 3 * 86400000);
  withFile(old, (path) => {
    assert.equal(readPeopleCounts(path, now), undefined);
    assert.deepEqual(readPeopleCounts(path, now, Infinity), old);
  });
});

test('the public people fetch has no credential or private endpoint', () => {
  const build = readFileSync('.github/workflows/pages.yml', 'utf8').replaceAll('\r\n', '\n').split('  build:\n')[1].split('\n  deploy:\n')[0];
  assert.match(build, /permissions: \{\}/);
  assert.doesNotMatch(build, /github\.token|secrets\.|GH_TOKEN|GITHUB_TOKEN|api\.github\.com|repos\/danswett\/slipgates-fleet/);
  const fetch = build.split('      - name: Fetch public people counts\n')[1]?.split('\n      - ')[0] ?? '';
  assert.match(fetch, /continue-on-error: true/);
  assert.match(fetch, /--max-time 15 --max-filesize 4096/);
  assert.match(fetch, /https:\/\/raw\.githubusercontent\.com\/danswett\/slipgates-roadmap\/fleet-counts\/people-at-work\.json/);
});

test('without scripts the built counts keep their generated time and a visible Stale badge', () => {
  const value = sample(Date.now() - 60000), { html } = render(value);
  const badge = html.match(/<span\b[^>]*data-people-stale[^>]*>Stale<\/span>/)?.[0];
  assert.ok(badge);
  assert.doesNotMatch(badge, /\bhidden\b/);
  assert.ok(html.includes(`datetime="${value.generatedAt}"`));
  assert.match(html, /Updated at <time data-people-generated-at/);
});
