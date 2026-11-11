import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCharts } from './charts.mjs';

const series = (size, step) => Array.from({ length: size }, (_, i) => ({
  at: new Date(Date.UTC(2026, 10, 10) + i * step).toISOString(), count: i,
}));
const sample = () => ({ merges: { per_hour: series(48, 3600000) },
  pull_requests: { merged_per_day: series(30, 86400000), median_hours_to_merge: 1.25 },
  ci: { median_minutes: 6.8 } });

test('charts use the latest 24 hours and 14 days with labelled native table fallbacks', () => {
  const html = renderCharts(sample());
  assert.match(html, /Merges per hour, last 24 h/);
  assert.match(html, /47<small>this hour, peak 47/);
  assert.match(html, /<svg class="spark"[^>]+role="img"[^>]+aria-label="[^"]*47/);
  assert.match(html, /<circle class="dot"/);
  assert.equal(html.match(/<details>/g)?.length, 2);
  assert.equal(html.match(/<summary>View as a table<\/summary>/g)?.length, 2);
  assert.equal(html.match(/<tr><td>/g)?.length, 38);
  assert.equal(html.match(/<i style="--h:/g)?.length, 14);
  assert.match(html, /Today/);
  assert.match(html, /1<small>h<\/small> 15<small>min/);
  assert.match(html, /6.8<small>min/);
  assert.doesNotMatch(html, /NaN|Infinity|<script\b/);
});

test('zero merges remain real zeroes without dividing by zero', () => {
  const stats = sample();
  for (const bins of [stats.merges.per_hour, stats.pull_requests.merged_per_day]) bins.forEach(b => b.count = 0);
  const html = renderCharts(stats);
  assert.match(html, /0<small>this hour, peak 0/);
  assert.match(html, /--h:0%/);
  assert.doesNotMatch(html, /NaN|Infinity|Data unavailable/);
});

test('missing or malformed chart fields stay unavailable without hiding valid metrics', () => {
  for (const bins of [undefined, [], series(23, 3600000), [{ at: '<img src=x>', count: 1 }],
    series(48, 3600000).map((b, i) => i === 47 ? { ...b, count: -1 } : b),
    series(48, 3600000).map((b, i) => i === 47 ? { ...b, at: b.at.replace('23:', '22:') } : b)]) {
    const stats = sample(); stats.merges.per_hour = bins;
    const html = renderCharts(stats);
    assert.match(html, /Data unavailable/); assert.doesNotMatch(html, /class="spark"|<img/);
    assert.match(html, /6.8<small>min/);
  }
  const html = renderCharts({ pull_requests: { median_hours_to_merge: -1 }, ci: { median_minutes: '6.8' } });
  assert.equal(html.match(/Data unavailable/g)?.length, 4);
  assert.doesNotMatch(html, /class="spark"|--h:|NaN|Infinity/);
  const stats = sample(); stats.pull_requests.merged_per_day[29].count = '29';
  const partial = renderCharts(stats);
  assert.match(partial, /class="spark"/); assert.doesNotMatch(partial, /--h:/);
  assert.equal(partial.match(/Data unavailable/g)?.length, 1);
});
