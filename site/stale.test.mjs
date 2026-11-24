import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Roadmap #37: a value carried over from an earlier run (stale_since) is labelled Stale on the page, never shown as fresh,
// and the text that reaches the page is escaped.
const build = (agentBridge) => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-'));
  try {
    const data = join(dir, 'data.json'), out = join(dir, 'out');
    const details = { priority_order: 1, open_prs: 0, merged_last_24h: 0, blockers: [] };
    writeFileSync(data, JSON.stringify({
      updatedAt: new Date(Date.now() - 60000).toISOString(),
      epics: [{ ...details, number: 1, title: 'Epic', closed: 1, open: 1 }],
      stats: { 'danswett/agent-bridge': { issues: { counts: { total: 10, resolved: 6 } }, prsMergedTotal: 7, ...agentBridge } },
    }));
    const run = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(out, 'index.html'), 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
};
const badges = (html) => [...html.matchAll(/<span class="stale-badge"[^>]*>Stale<\/span>/g)].length;

test('fresh values carry no Stale badge', () => {
  const html = build({ commits: { total: 456 }, merges: { last_24_hours: 17 } });
  assert.equal(badges(html), 0);
  assert.doesNotMatch(html, /last good value/);
});

test('a carried commits value shows a Stale badge with the time it is from', () => {
  const html = build({ commits: { total: 456, stale_since: '2026-11-11T05:00:00+00:00' }, merges: { last_24_hours: 17 } });
  assert.equal(badges(html), 1);
  assert.match(html, /Commits<[^]*?class="stale-badge"[^]*?Last good value from Nov 10, 9:00[\s\u202f]PM PT/);
});

test('a carried merge count shows a Stale badge on the merged tile', () => {
  const html = build({ commits: { total: 456 }, merges: { last_24_hours: 17, stale_since: '2026-11-11T05:00:00+00:00' } });
  assert.equal(badges(html), 1);
  assert.match(html, /Pull requests merged<[^]*?class="stale-badge"/);
});

test('stale_since is escaped, and anything that is not a timestamp is not printed as one', () => {
  const html = build({ commits: { total: 456, stale_since: '<img src=x onerror=alert(1)>' }, merges: { last_24_hours: 17 } });
  assert.equal(badges(html), 1);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /an earlier run|&lt;img/);
  const odd = build({ commits: { total: 456, stale_since: 42 }, merges: { last_24_hours: 17 } });
  assert.equal(badges(odd), 1);
  assert.match(odd, /Last good value from an earlier run/);
});
