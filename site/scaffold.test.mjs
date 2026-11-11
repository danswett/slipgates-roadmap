import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = () => readFileSync('.github/workflows/pages.yml', 'utf8').replaceAll('\r\n', '\n');
const job = (name) => workflow().split(`  ${name}:\n`)[1]?.split(/\n  \w+:\n/)[0] ?? '';

test('data failure cannot skip the token-free build or main-only serialized deploy', () => {
  assert.match(workflow(), /permissions: \{\}/);
  assert.match(job('data'), /continue-on-error: true/);
  for (const scope of ['contents', 'issues', 'pull-requests'])
    assert.match(job('data'), new RegExp(`${scope}: read`));
  assert.doesNotMatch(job('data'), /: write|secrets\./);
  assert.match(job('build'), /needs: data/);
  assert.match(job('build'), /if:.*always\(\).*refs\/heads\/main/);
  assert.match(job('build'), /permissions: \{\}/);
  assert.doesNotMatch(job('build'), /github\.token|secrets\.|GH_TOKEN|GITHUB_TOKEN|actions\/checkout|: write/);
  assert.match(job('build'), /continue-on-error: true/);
  assert.match(job('deploy'), /if:.*refs\/heads\/main/);
  assert.match(job('deploy'), /name: github-pages/);
  assert.doesNotMatch(job('deploy'), /GH_TOKEN|GITHUB_TOKEN|contents:|issues:|pull-requests:/);
  assert.match(workflow(), /cancel-in-progress: false/);
  assert.doesNotMatch(workflow(), /cancel-in-progress: true/);
  assert.equal(existsSync('CNAME'), false);
});

test('five-minute and manual refresh include a separate scoped keepalive', () => {
  assert.match(workflow(), /cron: '\*\/5 \* \* \* \*'/);
  assert.match(workflow(), /workflow_dispatch:/);
  assert.match(job('keepalive'), /actions: write/);
  assert.match(job('keepalive'), /gh api --method PUT.*actions\/workflows\/pages.yml\/enable/);
  assert.doesNotMatch(job('build') + job('data'), /actions: write|\/enable/);
});

test('data job runs the merged D1/D4 generator with its read-only token and timestamps the artifact', () => {
  assert.match(job('data'), /repo_dashboard\.py --json-output roadmap\.json/);
  assert.match(job('data'), /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(job('data'), /persist-credentials: false/);
  assert.match(job('data'), /updatedAt/);
  assert.match(job('data'), /name: roadmap-data/);
  assert.doesNotMatch(job('data'), /--write|npm|secrets\./);
});

test('fresh D1/D4 data renders agent-bridge only, its update time and safe totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  try {
    const data = join(dir, 'data.json'), out = join(dir, 'out');
    const updatedAt = new Date(Date.now() - 60000).toISOString();
    const stats = Object.fromEntries(['danswett/agent-bridge', 'danswett/slipgates-fleet'].map((repo) =>
      [repo, { issues: { counts: { total: 123, resolved: 90 } }, commits: { total: 456 },
        merges: { last_24_hours: 17 } }]));
    stats['danswett/slipgates-fleet'] = { issues: { counts: { total: 987654, resolved: 987653 } },
      commits: { total: 987652 }, merges: { last_24_hours: 987651 } };
    const privateStats = { 'danswett/agent-bridge': stats['danswett/agent-bridge'],
      'danswett/slipgates-fleet': { unavailable: ['Data unavailable: repository is not publicly readable'] } };
    const value = { updatedAt, epics: [{ number: 749, title: '<script>Trust & safety</script>', closed: 7, open: 3 },
      { number: 999, title: 'Private fleet epic', closed: 8, open: 1, repository: 'danswett/slipgates-fleet' }], stats };
    for (const change of [{}, { updatedAt: new Date(Date.now() - 3600000).toISOString() },
      { error: 'Repository read failed' }, { error: '' }, { updatedAt: null }, { epics: null }, { stats: null },
      { updatedAt: new Date(Date.now() + 3600000).toISOString() }, { stats: { 'danswett/agent-bridge': {} } },
      { stats: privateStats }]) {
      writeFileSync(data, JSON.stringify({ ...value, ...change }));
      const run = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      assert.doesNotMatch(html, /<script\b|<(?:link|img|iframe)\b[^>]*\b(?:src|href)=["'](?:https?:)?\/\//i);
      if (Object.keys(change).length && change.stats !== privateStats) {
        assert.match(html, /Data unavailable/);
        assert.match(run.stderr, /Data unavailable/);
      } else {
        assert.doesNotMatch(html, /<h1>Data unavailable/);
        assert.match(html, new RegExp(`datetime="${updatedAt}"`));
        assert.match(html, /#749.*&lt;script&gt;Trust &amp; safety&lt;\/script&gt;.*7 of 10/s);
        assert.match(html, /danswett\/agent-bridge/);
        assert.match(html, /The private slipgates-fleet repository is not included\./);
        assert.doesNotMatch(html, /<h2>danswett\/slipgates-fleet|Private fleet epic|#999|98765[1-4]/);
        assert.match(html, /90(?:<[^>]+>|\s)*of 123/);
        assert.match(html, /Commits.*456/s);
        assert.match(html, /17 in the last 24 h/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or malformed data yields a timestamped static unavailable page; reasons are escaped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  try {
    const data = join(dir, 'data.json'), out = join(dir, 'out');
    for (const input of [undefined, '{', 'null', '[]', JSON.stringify({ unavailable: '<script>bad</script>' })]) {
      if (input !== undefined) writeFileSync(data, input);
      const run = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      assert.match(html, /Data unavailable/);
      assert.match(html, /datetime="[^"]+">.* PT/);
      assert.match(html, /Content-Security-Policy/);
      assert.doesNotMatch(html, /<script\b|<(?:link|img|iframe)\b[^>]*\b(?:src|href)=["'](?:https?:)?\/\/|http-equiv="refresh"/i);
      assert.match(run.stderr, /Data unavailable/);
      if (input?.includes('bad')) assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
