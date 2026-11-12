import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePeopleFreshness } from './people-freshness.mjs';

test('the people badge crosses fifteen minutes without changing the producer time or counts', () => {
  const generatedAt = '2026-11-11T22:19:06Z', at = Date.parse(generatedAt);
  const badge = { hidden: true }, time = { dateTime: generatedAt, parentElement: { querySelector: () => badge } };
  const root = { querySelectorAll: () => [time] };
  for (const [now, hidden] of [[at, true], [at + 900000, true], [at + 900001, false],
    [at + 7200000, false], [at + 60000, true]]) {
    updatePeopleFreshness(root, now);
    assert.equal(badge.hidden, hidden, `age ${now - at} ms`);
    assert.equal(time.dateTime, generatedAt);
  }
});

test('an unavailable tile stays unavailable and an unusable timestamp cannot look fresh', () => {
  assert.doesNotThrow(() => updatePeopleFreshness({ querySelectorAll: () => [] }));
  for (const dateTime of ['', 'bad', '2026-11-11T23:19:06Z']) {
    const badge = { hidden: true }, time = { dateTime, parentElement: { querySelector: () => badge } };
    updatePeopleFreshness({ querySelectorAll: () => [time] }, Date.parse('2026-11-11T22:19:06Z'));
    assert.equal(badge.hidden, false);
  }
});
