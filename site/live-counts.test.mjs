import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshLiveCounts } from './live-counts.mjs';

const source = 'https://raw.githubusercontent.com/danswett/slipgates-roadmap/fleet-counts/';
const people = () => ({ schema: 1, generatedAt: new Date().toISOString(), builders: 7, reviewers: 4 });
const fleet = () => ({ schema: 1, generatedAt: new Date().toISOString(), issuesOpen: 4,
  issuesResolved: 9, commits: 12345, prsMerged24h: 0, prsMerged14d: 0, prsMergedTotal: 99,
  ...Object.fromEntries(['Hour', 'Day'].flatMap((unit) => Array.from({ length: unit === 'Hour' ? 24 : 14 },
    (_, i) => [`merge${unit}${String(i).padStart(2, '0')}`, 0]))) });
function page() {
  const targets = { people: { innerHTML: 'LAST_GOOD_VALUE', dataset: {} }, fleet: { innerHTML: 'LAST_GOOD_VALUE', dataset: {} } };
  return { targets, querySelector: (selector) => targets[selector.match(/data-live-counts="(people|fleet)"/)?.[1]] ?? null,
    querySelectorAll: () => [] };
}
const request = (input = people()) => async (url) =>
  new Response(url.endsWith('people-at-work.json') ? JSON.stringify(input) : JSON.stringify(fleet()));

test('view-time reads use only the two public paths with no credentials or redirects', async () => {
  const root = page(), calls = [];
  await refreshLiveCounts(root, async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.cache, 'no-store');
    assert.equal(options.headers, undefined); assert.ok(options.signal instanceof AbortSignal);
    return request()(url);
  });
  assert.deepEqual(calls.sort(), [`${source}fleet-counts.json`, `${source}people-at-work.json`]);
  assert.match(root.targets.people.innerHTML, />7<\/div>.*builders/s);
  assert.match(root.targets.fleet.innerHTML, /Issues open: 4; resolved: 9; commits: 12345/);
  const old = { ...people(), generatedAt: new Date(Date.now() - 7200000).toISOString() };
  await refreshLiveCounts(root, request(old));
  assert.ok(root.targets.people.innerHTML.includes(old.generatedAt), 'old but valid input keeps its honest time');
});

test('invalid, blocked and oversized data cannot retain a last good value or leak rejected text', async (t) => {
  const logs = []; t.mock.method(console, 'error', (line) => logs.push(line));
  const marker = 'PRIVATE_VIEW_CANARY', valid = JSON.stringify(people());
  for (const body of ['{', JSON.stringify({ ...people(), privateName: marker }),
    JSON.stringify({ ...people(), builders: marker }), valid.padEnd(65537, ' ')]) {
    const root = page();
    await refreshLiveCounts(root, async (url) => new Response(url.endsWith('people-at-work.json') ? body : JSON.stringify(fleet())));
    assert.match(root.targets.people.innerHTML, /Unavailable/);
    assert.doesNotMatch(root.targets.people.innerHTML, /LAST_GOOD_VALUE|PRIVATE_VIEW_CANARY/);
    assert.match(root.targets.fleet.innerHTML, /commits: 12345/);
  }
  const root = page();
  await refreshLiveCounts(root, async () => { throw new Error(marker); });
  for (const target of Object.values(root.targets)) assert.match(target.innerHTML, /unavailable/i);
  assert.ok(!logs.join('').includes(marker));
  await refreshLiveCounts(root, async (url) => new Response(url.endsWith('people-at-work.json') ? valid.padEnd(65536, ' ') : JSON.stringify(fleet())));
  assert.match(root.targets.people.innerHTML, />7<\/div>/, 'the 64 KB boundary is inclusive');
});

test('ten-second deadlines abort both reads and leave unavailable rather than a prior value', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = page(), signals = [];
  const pending = refreshLiveCounts(root, (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  });
  for (const target of Object.values(root.targets)) assert.doesNotMatch(target.innerHTML, /LAST_GOOD_VALUE/);
  t.mock.timers.tick(10000); await pending;
  assert.equal(signals.length, 2); assert.ok(signals.every((signal) => signal.aborted));
  for (const target of Object.values(root.targets)) assert.match(target.innerHTML, /unavailable/i);
});

test('a late response from before page resume cannot replace the newer unavailable result', async (t) => {
  t.mock.method(console, 'error', () => {});
  const root = page(), replies = [];
  const old = refreshLiveCounts(root, (url) => new Promise(resolve => replies.push(() => resolve(
    new Response(JSON.stringify(url.endsWith('people-at-work.json') ? people() : fleet()))))));
  await refreshLiveCounts(root, async () => { throw new Error('blocked'); });
  replies.forEach(reply => reply()); await old;
  for (const target of Object.values(root.targets)) assert.match(target.innerHTML, /unavailable/i);
});
