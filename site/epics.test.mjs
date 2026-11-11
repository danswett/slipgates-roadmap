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
  assert.match(rows[2], /blk none/);
  for (const number of [803, 908])
    assert.match(html, new RegExp(`href="https://github.com/danswett/agent-bridge/issues/${number}"`));
  assert.match(html, /&lt;script&gt;Trust &amp; &quot;safety&quot;&lt;\/script&gt;/);
  assert.doesNotMatch(html.replace('<script type="module" src="people-freshness.mjs"></script>', ''),
    /PRIVATE_SENTINEL|#997|<script\b|(?:src|href)="(?:https?:)?\/\/(?!github\.com\/danswett\/agent-bridge\/issues\/)/i);
});

const blocker = (number, fields = {}) => ({ number, title: `Blocker ${number}`,
  reason: 'missing reply, P0', clearsIt: 'Engineering', ...fields });
const child = (number, blockers, fields = {}) => ({ number, title: `Child ${number}`,
  blockers, clearsIt: 'Engineering', ...fields });
const blockedEpic = (children, details = children.flatMap(c => c.blockers)) => epic(750,
  { blockers: children.map(c => c.number), blocked: true, blockedChildren: children, blockerDetails: details });

test('one blocker names the cause and opens a full escaped child, blocker and role list', () => {
  const { html } = render([blockedEpic([child(1927, [blocker(1925,
    { title: '<Reply & restart>', reason: 'missing <reply>, P0' })], { title: 'Child <reply>' })])]);
  assert.match(html, /<details class="blk"><summary>.*<b>Blocked by #1925<\/b> \(missing &lt;reply&gt;, P0\)/s);
  assert.match(html, /class="child".*issues\/1927.*Child &lt;reply&gt;/s);
  assert.match(html, /class="by".*issues\/1925.*&lt;Reply &amp; restart&gt;/s);
  assert.match(html, /Clears it: <b>Engineering<\/b>/);
  assert.doesNotMatch(html.replace('<script type="module" src="people-freshness.mjs"></script>', ''),
    /Needs a blocker|class="more"|<script\b|<reply>/);
  assert.doesNotMatch(html.match(/<li class="card epic[\s\S]*?<\/section>/)?.[0], /Data unavailable/);
});

test('several and mixed children name the first recorded cause and list every blocker', () => {
  const unknown = blocker(null, { title: 'No blocker recorded', reason: 'No blocker recorded' });
  const { html } = render([blockedEpic([child(1900, [unknown]),
    child(1927, [blocker(1925), blocker(1926)]), child(1930, [blocker(1929)])])]);
  assert.match(html, /<b>Blocked by #1925<\/b>.*<span class="more">\+2 more<\/span>/s);
  for (const n of [1900, 1927, 1925, 1926, 1930, 1929]) assert.match(html, new RegExp(`issues/${n}"`));
  assert.match(html, /Needs a blocker \(1\)/);
  const panel = html.split('<section class="need"')[1];
  assert.match(panel, /issues\/1900/); assert.doesNotMatch(panel, /issues\/1927|issues\/1930/);
});

test('label-only blocks ask for source correction, while private causes never get public links', () => {
  const unknown = blocker(null, { title: 'No blocker recorded', reason: 'No blocker recorded' });
  const missing = render([blockedEpic([child(1900, [unknown])])]).html;
  assert.match(missing, /<details class="blk none"><summary>.*<b>Blocked<\/b>: no blocker recorded/s);
  assert.match(missing, /No blocker recorded/); assert.match(missing, /Blocked by #N/); assert.match(missing, /Clears it: Engineering/);
  const own = render([blockedEpic([], [blocker(55, { title: 'private item', reason: 'private item', clearsIt: 'someone@example.com' })])]).html;
  assert.match(own, /<details class="blk">/); assert.match(own, /Blocked by private item/);
  assert.match(own, /Clears it: <b>Unassigned<\/b>/); assert.doesNotMatch(own, /issues\/55|#55|someone@example.com/);
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
