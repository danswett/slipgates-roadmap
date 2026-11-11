import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const bins = (prefix, size) => Object.fromEntries(Array.from({ length: size },
  (_, i) => [`${prefix}${String(i).padStart(2, '0')}`, i + 1]));
const sample = () => ({ schema: 1, generatedAt: new Date(Date.now() - 60000).toISOString(),
  issuesOpen: 4, issuesResolved: 9, prsMerged24h: 300, prsMerged14d: 105, commits: 12345,
  ...bins('mergeHour', 24), ...bins('mergeDay', 14) });
function render(fleet, roadmap = true) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-counts-'));
  try {
    const data = join(dir, 'roadmap.json'), counts = join(dir, 'fleet.json'), out = join(dir, 'out');
    if (roadmap) writeFileSync(data, JSON.stringify({ updatedAt: new Date().toISOString(), epics: [],
      totals: { prsMerged: 789 }, people: { builders: 3, reviewers: 2 },
      stats: { 'danswett/agent-bridge': { issues: { counts: { resolved: 90, total: 123 } },
        commits: { total: 456 }, merges: { last_24_hours: 17 } } } }));
    if (fleet !== undefined) writeFileSync(counts, typeof fleet === 'string' ? fleet : JSON.stringify(fleet));
    const run = spawnSync(process.execPath, ['site/build.mjs', data, out, counts], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return { html: readFileSync(join(out, 'index.html'), 'utf8'), stderr: run.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('only validated fleet counts render, independently of agent-bridge data', () => {
  const counts = sample();
  for (const roadmap of [true, false]) {
    const { html } = render(counts, roadmap);
    assert.match(html, /slipgates-fleet \(private repo, counts only\)/);
    assert.match(html, /Issues open: 4; resolved: 9; commits: 12345/);
    assert.match(html, /300 in 24 hours; 105 in 14 days/);
    for (const [label, size, step] of [['hour', 24, 3600000], ['day', 14, 86400000]]) {
      const table = html.split(`<table aria-label="Fleet merges per ${label}">`)[1]?.split('</table>')[0] ?? '';
      assert.deepEqual([...table.matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1])),
        Array.from({ length: size }, (_, i) => i + 1));
      const end = Math.floor(Date.parse(counts.generatedAt) / step) * step;
      assert.ok(table.includes(new Date(end - size * step).toISOString()));
    }
    assert.doesNotMatch(html, /Average per hour/);
    assert.ok(html.includes(`datetime="${counts.generatedAt}"`));
    assert.doesNotMatch(html, /Fleet counts unavailable|<script\b|<(?:link|img|iframe)\b[^>]*\b(?:src|href)=["'](?:https?:)?\/\//i);
    if (roadmap) assert.match(html, /90(?:<[^>]+>|\s)*of 123/);
  }
  const { html } = render({ ...counts, issuesOpen: 0, commits: 100000000,
    generatedAt: counts.generatedAt.replace('Z', '+00:00') });
  assert.match(html, /Issues open: 0; resolved: 9; commits: 100000000/);
});

test('missing, malformed, stale or non-allow-listed fleet data fails only its panel', () => {
  const counts = sample();
  const missing = { ...counts }; delete missing.commits;
  const missingBin = { ...counts }; delete missingBin.mergeHour23;
  for (const input of [undefined, '{', null, [], missing, missingBin, { ...counts, schema: 2 },
    { ...counts, prsMerged24h: 301 }, { ...counts, prsMerged14d: 106 }, { ...counts, mergeHour24: 0 },
    { ...counts, mergeHour00: 1.5 }, { ...counts, mergeDay00: -1 },
    ...['4', 1.5, -1, 100000001, true, {}, []].map((issuesOpen) => ({ ...counts, issuesOpen })),
    ...['not a time', null, new Date(Date.now() - 7201000).toISOString(),
      new Date(Date.now() + 3600000).toISOString()].map((generatedAt) => ({ ...counts, generatedAt }))]) {
    const { html, stderr } = render(input);
    assert.match(html, /Fleet counts unavailable/);
    assert.match(stderr, /Fleet counts unavailable/);
    assert.match(html, /90(?:<[^>]+>|\s)*of 123/);
    assert.doesNotMatch(html, /commits: 12345|300 in 24 hours/);
  }
});

test('private titles, labels, authors and branches never reach the page or logs', () => {
  const privateText = { title: 'PRIVATE_TITLE_SENTINEL', labels: 'PRIVATE_LABEL_SENTINEL',
    author: 'PRIVATE_AUTHOR_SENTINEL', branch: 'PRIVATE_BRANCH_SENTINEL' };
  for (const [key, text] of Object.entries(privateText)) {
    for (const input of [{ ...sample(), [key]: text }, { ...sample(), issuesOpen: text },
      { ...sample(), generatedAt: text }]) {
      const { html, stderr } = render(input);
      assert.match(html, /Fleet counts unavailable/);
      for (const marker of Object.values(privateText)) assert.ok(!(html + stderr).includes(marker));
    }
  }
});

test('public fleet fetch adds no token, private API request or permissions', () => {
  const workflow = readFileSync('.github/workflows/pages.yml', 'utf8').replaceAll('\r\n', '\n');
  const build = workflow.split('  build:\n')[1].split('\n  deploy:\n')[0];
  const fetch = build.split('      - name: Fetch public fleet counts\n')[1]?.split('\n      - ')[0] ?? '';
  assert.match(build, /permissions: \{\}/);
  assert.doesNotMatch(build, /github\.token|secrets\.|GH_TOKEN|GITHUB_TOKEN|api\.github\.com|repos\/danswett\/slipgates-fleet/);
  assert.match(fetch, /continue-on-error: true/);
  assert.match(fetch, /https:\/\/raw\.githubusercontent\.com\/danswett\/slipgates-roadmap\/fleet-counts\/fleet-counts\.json/);
  assert.match(fetch, /--max-time/);
});
