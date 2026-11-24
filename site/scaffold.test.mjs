import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = () => readFileSync('.github/workflows/pages.yml', 'utf8').replaceAll('\r\n', '\n');
const job = (name) => workflow().split(`  ${name}:\n`)[1]?.split(/\n  \w+:\n/)[0] ?? '';
const assertLocalFreshnessScript = (html) => {
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map(([script]) => script),
    ['<script type="module" src="live-counts.mjs"></script>']);
  assert.equal(html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1],
    "default-src 'none'; script-src 'self'; connect-src https://raw.githubusercontent.com/danswett/slipgates-roadmap/fleet-counts/; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'");
  assert.doesNotMatch(html, /<(?:link|img|iframe)\b[^>]*\b(?:src|href)=["'](?:https?:)?\/\//i);
};

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
    const details = { priority_order: 1, open_prs: 2, merged_last_24h: 4, blockers: [] };
    const value = { updatedAt, epics: [{ ...details, number: 749, title: '<script>Trust & safety</script>', closed: 7, open: 3 },
      { ...details, number: 999, title: 'Private fleet epic', closed: 8, open: 1, repository: 'danswett/slipgates-fleet' }], stats };
    for (const change of [{}, { updatedAt: new Date(Date.now() - 3600000).toISOString() },
      { error: 'Repository read failed' }, { error: '' }, { updatedAt: null }, { epics: null }, { stats: null },
      { updatedAt: new Date(Date.now() + 3600000).toISOString() }, { stats: { 'danswett/agent-bridge': {} } },
      { stats: privateStats }]) {
      writeFileSync(data, JSON.stringify({ ...value, ...change }));
      const run = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      assertLocalFreshnessScript(html);
      assert.ok(existsSync(join(out, 'live-counts.mjs')));
      if (Object.keys(change).length && change.stats !== privateStats) {
        assert.match(html, /Data unavailable/);
        assert.match(run.stderr, /Data unavailable/);
      } else {
        assert.doesNotMatch(html, /<h1>Data unavailable/);
        assert.match(html, new RegExp(`datetime="${updatedAt}"`));
        assert.match(html, /#749.*&lt;script&gt;Trust &amp; safety&lt;\/script&gt;.*7 of 10/s);
        assert.match(html, /danswett\/agent-bridge/);
        assert.match(html, /Fleet counts unavailable/);
        assert.doesNotMatch(html, /<h2>danswett\/slipgates-fleet|Private fleet epic|#999|98765[1-4]/);
        assert.match(html, /90(?:<[^>]+>|\s)*of 123/);
        assert.match(html, /Commits.*456/s);
        assert.match(html, /17 in the last 24 h/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or malformed data yields plain unavailable copy and keeps diagnostics in stderr', () => {
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
      assertLocalFreshnessScript(html);
      assert.doesNotMatch(html, /http-equiv="refresh"/i);
      assert.match(run.stderr, /Data unavailable/);
      assert.doesNotMatch(html, /Data unavailable:|&lt;script&gt;bad|valid update time|Data artifact/);
      if (input?.includes('bad')) assert.match(run.stderr, /<script>bad<\/script>/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('partial tiles use one muted unavailable note and preserve the real merge count', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-partial-'));
  try {
    const data = join(dir, 'data.json'), out = join(dir, 'out');
    writeFileSync(data, JSON.stringify({ updatedAt: new Date().toISOString(), epics: [],
      stats: { 'danswett/agent-bridge': { commits: { total: 1 }, issues: { counts: { resolved: 1, total: 2 } }, merges: { last_24_hours: 17 } } } }));
    const run = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    const people = html.split('<h2>People at work</h2>')[1]?.split('<section')[0];
    assert.equal(people?.match(/Data unavailable/g)?.length, 1);
    assert.doesNotMatch(people, /Data unavailable (?:builders|reviewers)/);
    assert.match(html, /17 in the last 24 h<\/div><div class="none">Data unavailable/);
    assert.match(html, /<footer>.*private slipgates-fleet epics.*No cookies or trackers\. Counts read from public GitHub\./s);
  } finally { rmSync(dir, { recursive: true }); }
});

test('--require-data fails the build instead of publishing the unavailable page, so the last good page stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-require-'));
  try {
    const data = join(dir, 'data.json');
    const stats = { 'danswett/agent-bridge': { commits: { total: 1 }, issues: { counts: { resolved: 1, total: 2 } }, merges: { last_24_hours: 17 } } };
    const fresh = { updatedAt: new Date().toISOString(), epics: [], stats };
    const build = (out) => spawnSync(process.execPath, ['site/build.mjs', data, out, '--require-data'], { encoding: 'utf8' });
    for (const [name, body] of [['an error from the read', { ...fresh, error: 'Repository read failed (CalledProcessError)' }],
      ['an out-of-date artifact', { ...fresh, updatedAt: new Date(Date.now() - 3600000).toISOString() }],
      ['invalid epics', { ...fresh, epics: null }], ['invalid JSON', null]]) {
      writeFileSync(data, body === null ? '{' : JSON.stringify(body));
      const out = join(dir, `out-${name.replaceAll(' ', '-')}`);
      const run = build(out);
      assert.equal(run.status, 1, `${name}: ${run.stderr}`);
      assert.match(run.stderr, /Data unavailable/);
      assert.equal(existsSync(join(out, 'index.html')), false, `${name} must not write a page`);
    }
    rmSync(data);
    const missing = build(join(dir, 'out-missing'));
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(existsSync(join(dir, 'out-missing', 'index.html')), false);
    writeFileSync(data, JSON.stringify(fresh));
    const ok = build(join(dir, 'out-fresh'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(existsSync(join(dir, 'out-fresh', 'index.html')));
    // Without the flag nothing changes: the unavailable page is still the default for local runs and tests.
    writeFileSync(data, JSON.stringify({ ...fresh, error: 'Repository read failed' }));
    const plain = spawnSync(process.execPath, ['site/build.mjs', data, join(dir, 'out-plain')], { encoding: 'utf8' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(readFileSync(join(dir, 'out-plain', 'index.html'), 'utf8'), /Data unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('inside the Pages workflow the build refuses to publish the unavailable page even without --require-data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-pages-env-'));
  try {
    const data = join(dir, 'data.json');
    const build = (workflow, out) => spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8', env: { ...process.env, GITHUB_WORKFLOW: workflow } });
    writeFileSync(data, JSON.stringify({ updatedAt: new Date().toISOString(), epics: [], stats: {}, error: 'Repository read failed (CalledProcessError): gh: HTTP 503' }));
    const pages = build('Pages', join(dir, 'out-pages'));
    assert.equal(pages.status, 1, pages.stderr);
    assert.match(pages.stderr, /Refusing to publish the unavailable page/);
    assert.equal(existsSync(join(dir, 'out-pages', 'index.html')), false);
    assert.equal(build('CI', join(dir, 'out-ci')).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
