import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const epic = (number, fields = {}) => ({ number, title: `Epic ${number}`, state: 'OPEN',
  closed: 7, open: 3, priority_order: number, open_prs: 2, merged_last_24h: 4, blockers: [], ...fields });
function render(epics) {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-epics-'));
  try {
    const data = join(dir, 'data.json'), out = join(dir, 'out');
    writeFileSync(data, JSON.stringify({ updatedAt: new Date().toISOString(), epics,
      stats: { 'danswett/agent-bridge': { issues: { counts: { resolved: 90, total: 123 } },
        commits: { total: 456 }, merges: { last_24_hours: 17 } } } }));
    const run = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return { html: readFileSync(join(out, 'index.html'), 'utf8'), stderr: run.stderr };
  } finally { rmSync(dir, { recursive: true }); }
}

test('every public epic has progress, child counts, PRs and blockers in D1 roadmap order', () => {
  const { html } = render([
    epic(749, { priority_order: 3, title: '<script>Trust & "safety"</script>', blockers: [803, 908] }),
    epic(728, { priority_order: 2 }),
    epic(750, { priority_order: 1 }),
    epic(997, { priority_order: 0, repository: 'danswett/slipgates-fleet', title: 'PRIVATE_SENTINEL' }),
  ]);
  const rows = [...html.matchAll(/<li class="[^"]*\bepic\b[^"]*">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => Number(row.match(/issues\/(\d+)/)[1])), [750, 728, 749]);
  for (const row of rows) {
    assert.match(row, /70%/);
    assert.match(row, /role="progressbar"/);
    assert.match(row, /aria-valuenow="7"/);
    assert.match(row, /aria-valuemax="10"/);
    assert.match(row, /aria-valuetext="7 of 10 slices done"/);
    assert.match(row, /7 of 10 done/);
    assert.match(row, /3 open/);
    assert.match(row, /2 open PRs/);
    assert.match(row, /4 merged in 24 h/);
  }
  assert.match(rows[2], /chip blocked/);
  for (const number of [803, 908])
    assert.match(rows[2], new RegExp(`href="https://github.com/danswett/agent-bridge/issues/${number}"[^>]*>#${number}</a>`));
  assert.match(html, /&lt;script&gt;Trust &amp; &quot;safety&quot;&lt;\/script&gt;/);
  assert.doesNotMatch(html, /PRIVATE_SENTINEL|#997|<script\b|(?:src|href)="(?:https?:)?\/\/(?!github\.com\/danswett\/agent-bridge\/issues\/)/i);
});

test('empty and completed epics keep honest progress without false completion', () => {
  const { html } = render([epic(800, { closed: 0, open: 0, open_prs: 0, merged_last_24h: 0 }),
    epic(801, { closed: 3, open: 0, state: 'CLOSED' }),
    epic(802, { closed: 0, open: 0, state: 'CLOSED', open_prs: 0, merged_last_24h: 0 })]);
  const rows = [...html.matchAll(/<li class="[^"]*\bepic\b[^"]*">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /No slices planned/);
  assert.doesNotMatch(rows[0], /class="pct|role="progressbar"|0 of 0|chip done|NaN|Infinity/);
  assert.match(rows[1], /100%/);
  assert.match(rows[1], /chip done/);
  assert.match(rows[1], /Done/);
  assert.match(rows[2], /chip done/);
  assert.match(rows[2], /No slices planned/);
  assert.doesNotMatch(rows[2], /class="pct|role="progressbar"|0 of 0/);
});

test('invalid epic detail data is visibly unavailable, never invented as zero', () => {
  for (const fields of [{ open_prs: -1 }, { merged_last_24h: '4' }, { blockers: ['<img>'] },
    { blockers: null }, { priority_order: null }, { open: Number.MAX_SAFE_INTEGER }]) {
    const { html, stderr } = render([epic(750, fields)]);
    assert.match(html, /Data unavailable/);
    assert.match(stderr, /Data unavailable/);
    assert.doesNotMatch(html, /<li class="[^"]*\bepic\b/);
  }
});
