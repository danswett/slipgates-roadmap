import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshLiveCounts } from './live-counts.mjs';

const source = 'https://raw.githubusercontent.com/danswett/slipgates-roadmap/fleet-counts/';
const people = () => ({ schema: 1, generatedAt: new Date().toISOString(), builders: 7, reviewers: 4 });
const fleet = () => ({ schema: 1, generatedAt: new Date().toISOString(), issuesOpen: 4,
  issuesResolved: 9, commits: 12345, prsMerged24h: 0, prsMerged14d: 0, prsMergedTotal: 99,
  ...Object.fromEntries(['Hour', 'Day'].flatMap((unit) => Array.from({ length: unit === 'Hour' ? 24 : 14 },
    (_, i) => [`merge${unit}${String(i).padStart(2, '0')}`, 0]))) });
function page(merged) {
  const targets = { people: { innerHTML: 'LAST_GOOD_VALUE', dataset: {} }, fleet: { innerHTML: 'LAST_GOOD_VALUE', dataset: {} } };
  return { targets, querySelector: (selector) => selector === '[data-live-merged]' ? merged : targets[selector.match(/data-live-counts="(people|fleet)"/)?.[1]] ?? null,
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

test('fresh fleet data cannot hide the public source age of old HTML', async () => {
  const generatedAt = new Date(Date.now() - 10800000).toISOString();
  const merged = { dataset: { total: '100', recent: '17', generatedAt }, innerHTML: '' };
  await refreshLiveCounts(page(merged), request());
  assert.match(merged.innerHTML, /class="stat num">199<\/div>/);
  assert.ok(merged.innerHTML.includes(`agent-bridge Updated at <time data-people-generated-at datetime="${generatedAt}"`));
  assert.match(merged.innerHTML, /slipgates-fleet Updated at <time/);
  merged.dataset.generatedAt = '';
  await refreshLiveCounts(page(merged), request());
  assert.match(merged.innerHTML, /agent-bridge Update time unavailable/);
});

test('persisted pageshow rereads both public files but an ordinary pageshow does not', async (t) => {
  const root = { ...page(), addEventListener() {} }, listeners = new Map(), calls = [];
  const globals = ['document', 'addEventListener'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => globals.forEach(([key, descriptor]) => descriptor
    ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key)));
  globalThis.document = root;
  globalThis.addEventListener = (name, listener) => listeners.set(name, listener);
  t.mock.method(globalThis, 'setInterval', () => 0);
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); return request()(url); });
  await import('./live-counts.mjs?persisted-pageshow-test');
  await new Promise(setImmediate);
  assert.ok(Object.values(root.targets).every(target => target.dataset.liveState === 'ready'));
  calls.length = 0;
  listeners.get('pageshow')({ persisted: false });
  assert.deepEqual(calls, []);
  listeners.get('pageshow')({ persisted: true });
  await new Promise(setImmediate);
  assert.deepEqual(calls.sort(), [`${source}fleet-counts.json`, `${source}people-at-work.json`]);
  assert.ok(Object.values(root.targets).every(target => target.dataset.liveState === 'ready'));
});

test('blocked fleet rereads reset baked merged totals to public-only and show fleet unavailable', async (t) => {
  t.mock.method(console, 'error', () => {});
  const generatedAt = new Date(Date.now() - 10800000).toISOString();
  const merged = { dataset: { total: '100', recent: '17', generatedAt }, innerHTML: '' }, root = page(merged);
  await refreshLiveCounts(root, request());
  const baked = merged.innerHTML;
  assert.match(baked, /class="stat num">199<\/div>/);
  const reload = page({ dataset: merged.dataset, innerHTML: baked });
  const target = reload.querySelector('[data-live-merged]');
  await refreshLiveCounts(reload, async url => {
    if (url.endsWith('fleet-counts.json')) throw new Error('blocked');
    return request()(url);
  });
  assert.match(target.innerHTML, /class="stat num">100<\/div>/);
  assert.match(target.innerHTML, /17 in the last 24 h; agent-bridge only/);
  assert.ok(target.innerHTML.includes(generatedAt));
  assert.doesNotMatch(target.innerHTML, />199<\/div>|slipgates-fleet Updated at/);
  assert.match(reload.targets.fleet.innerHTML, /unavailable/i);
  assert.equal(reload.targets.fleet.dataset.liveState, 'unavailable');
  assert.match(reload.targets.people.innerHTML, />7<\/div>/);
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
  const root = page(), signals = [], rejects = [];
  const pending = refreshLiveCounts(root, (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      rejects.push(reject);
      signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
  });
  t.after(async () => { rejects.forEach(reject => reject(new Error('cleanup'))); await pending; });
  for (const target of Object.values(root.targets)) assert.doesNotMatch(target.innerHTML, /LAST_GOOD_VALUE/);
  assert.equal(signals.length, 2);
  t.mock.timers.tick(9999);
  assert.ok(signals.every(signal => !signal.aborted), 'neither deadline fires before ten seconds');
  t.mock.timers.tick(1);
  assert.ok(signals.every(signal => signal.aborted), 'both reads abort at ten seconds before awaiting completion');
  await pending;
  for (const target of Object.values(root.targets)) assert.match(target.innerHTML, /unavailable/i);
});

test('a late error cannot overwrite newer ready counts or log an outage', async (t) => {
  const logs = []; t.mock.method(console, 'error', line => logs.push(line));
  const root = page(), rejects = [];
  const old = refreshLiveCounts(root, () => new Promise((_resolve, reject) => rejects.push(reject)));
  t.after(async () => { rejects.forEach(reject => reject(new Error('cleanup'))); await old; });
  await refreshLiveCounts(root, request());
  const latest = Object.fromEntries(Object.entries(root.targets).map(([kind, target]) => [kind, target.innerHTML]));
  rejects.forEach(reject => reject(new Error('late error')));
  await old;
  for (const [kind, target] of Object.entries(root.targets)) {
    assert.equal(target.innerHTML, latest[kind], `${kind}: a stale catch must preserve the newer HTML`);
    assert.equal(target.dataset.liveState, 'ready');
  }
  assert.deepEqual(logs, []);
});

test('starting a newer refresh aborts both previous controllers before either read completes', async (t) => {
  const root = page(), first = [], second = [], replies = [];
  const deferred = signals => (url, { signal }) => new Promise((resolve, reject) => {
    signals.push(signal);
    replies.push(() => resolve(request()(url)));
    signal.addEventListener('abort', () => reject(new Error('superseded')), { once: true });
  });
  const old = refreshLiveCounts(root, deferred(first));
  const current = refreshLiveCounts(root, deferred(second));
  t.after(async () => { replies.forEach(reply => reply()); await Promise.all([old, current]); });
  assert.equal(first.length, 2); assert.equal(second.length, 2);
  assert.ok(first.every(signal => signal.aborted), 'both superseded reads must abort immediately');
  assert.ok(second.every(signal => !signal.aborted), 'the new reads must remain active');
  replies.forEach(reply => reply());
  await Promise.all([old, current]);
  for (const target of Object.values(root.targets)) assert.equal(target.dataset.liveState, 'ready');
});

test('non-ok responses with valid payloads are unavailable without reading their bodies', async (t) => {
  t.mock.method(console, 'error', () => {});
  const root = page(), bodyReads = [];
  await refreshLiveCounts(root, async url => {
    const response = await request()(url);
    return { ok: false, status: 500, get body() { bodyReads.push(url); return response.body; } };
  });
  assert.deepEqual(bodyReads, [], 'HTTP errors must be rejected before accessing a valid body');
  for (const target of Object.values(root.targets)) {
    assert.match(target.innerHTML, /unavailable/i);
    assert.equal(target.dataset.liveState, 'unavailable');
  }
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
