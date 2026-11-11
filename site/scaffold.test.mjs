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

test('missing or malformed data yields a timestamped static unavailable page; reasons are escaped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-'));
  try {
    const data = join(dir, 'data.json'), out = join(dir, 'out');
    for (const input of [undefined, '{', JSON.stringify({ unavailable: '<script>bad</script>' })]) {
      if (input !== undefined) writeFileSync(data, input);
      const run = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      assert.match(html, /Data unavailable/);
      assert.match(html, /Updated at .* (PST|PDT)/);
      assert.match(html, /Content-Security-Policy/);
      assert.doesNotMatch(html, /<script\b|\b(?:src|href)=|http-equiv="refresh"/i);
      assert.match(run.stderr, /Data unavailable/);
      if (input?.includes('bad')) assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
