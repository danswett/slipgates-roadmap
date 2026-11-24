import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCost, renderCostTile, COST_TARGET } from './cost.mjs';

const NOW = Date.parse('2026-11-23T20:30:00Z');
const day = (n, units = 1200 + n, merges = 4) => ({ day: `2026-11-${17 + n}`, units, merges,
  unitsPerMerge: merges ? Math.round(units / merges * 10) / 10 : null, coordinationSharePct: 71 });
const sample = (over = {}) => ({ schema: 1, generatedAt: '2026-11-23T20:05:11Z', day: '2026-11-23', units: 1200, merges: 4,
  unitsPerMerge: 300, coordinationSharePct: 71,
  roles: { Lead: { units: 600, unitsPerMerge: 150 }, Chief: { units: 252, unitsPerMerge: 63 },
    Builder: { units: 240, unitsPerMerge: 60 }, Reviewer: { units: 108, unitsPerMerge: 27 }, Other: { units: 0, unitsPerMerge: 0 } },
  series: Array.from({ length: 7 }, (_, n) => day(n)), ...over });

test('the target is 300 units per merge', () => assert.equal(COST_TARGET, 300));

test('only an exact, bounded public record validates', () => {
  assert.ok(validateCost(sample(), NOW));
  const bad = [null, [], 'x', sample({ schema: 2 }), sample({ units: -1 }), sample({ units: 1.5 }), sample({ units: '5' }),
    sample({ unitsPerMerge: NaN }), sample({ unitsPerMerge: 1e12 }), sample({ coordinationSharePct: 101 }),
    sample({ host: 'SECRET-HOST' }), sample({ series: sample().series.slice(0, 6) }),
    sample({ series: [...sample().series.slice(0, 6), { ...day(6), extra: 1 }] }),
    sample({ series: [...sample().series.slice(0, 6), { ...day(6), day: 'C:/people/bob' }] }),
    sample({ roles: { ...sample().roles, 'alice@host': { units: 1, unitsPerMerge: 1 } } }),
    sample({ roles: { Lead: { units: null, unitsPerMerge: 1 } } }),
    sample({ generatedAt: '2026-11-23T21:00:00Z' }),
    sample({ series: Array.from({ length: 7 }, () => day(6)) }),
    sample({ series: [...sample().series.slice(0, 6).reverse(), day(6)] }),
    sample({ day: '2026-11-22' }),
    sample({ merges: 0, unitsPerMerge: 5000 }), sample({ merges: null, unitsPerMerge: 5 }), sample({ unitsPerMerge: 999 }),
    sample({ series: [...sample().series.slice(0, 6), { ...day(6), unitsPerMerge: 1e7 }] }),
    JSON.parse('{"__proto__":{"x":1},"schema":1}'),
    sample({ roles: JSON.parse('{"__proto__":{"units":1,"unitsPerMerge":1}}') }), sample({ generatedAt: 'yesterday' })];
  for (const value of bad) assert.equal(validateCost(value, NOW), undefined, JSON.stringify(value)?.slice(0, 80));
  assert.ok(validateCost(sample({ merges: null, unitsPerMerge: null }), NOW), 'honest nulls are accepted');
});

test('the tile shows units per merge, the 300 target, roles, coordination share and the 7-day series', () => {
  const html = renderCostTile(validateCost(sample(), NOW), NOW);
  assert.match(html, /Cost per merge/);
  assert.match(html, />300<small>units per merge today/);
  assert.match(html, /target 300/);
  for (const role of ['Lead', 'Chief', 'Builder', 'Reviewer']) assert.match(html, new RegExp(role));
  assert.match(html, /71%[^<]*coordination|coordination[^<]*71%/);
  assert.match(html, /<caption>Units per merge, last 7 days/);
  assert.equal((html.match(/<tr><td>2026-11-/g) ?? []).length, 7);
  assert.doesNotMatch(html, /stale/i);
});

test('the verdict follows the rounded number shown', () => {
  const html = renderCostTile(validateCost(sample({ unitsPerMerge: 300.04, units: 1200.16 > 0 ? 1200 : 0 }), NOW), NOW);
  assert.match(html, />300<small>[^<]*within the 300 target/);
});

test('over the target says so in words, not only in colour', () => {
  const html = renderCostTile(validateCost(sample({ unitsPerMerge: 613.5, units: 2454 }), NOW), NOW);
  assert.match(html, /above the 300 target/);
  assert.match(renderCostTile(validateCost(sample({ unitsPerMerge: 250, units: 1000 }), NOW), NOW), /within the 300 target/);
});

test('null ratios and null days are Data unavailable, never zero', () => {
  const series = [day(0), { day: '2026-11-18', units: null, merges: null, unitsPerMerge: null, coordinationSharePct: null },
    ...Array.from({ length: 5 }, (_, n) => day(n + 2))];
  const html = renderCostTile(validateCost(sample({ merges: null, unitsPerMerge: null, series }), NOW), NOW);
  assert.match(html, /Data unavailable/);
  assert.doesNotMatch(html, />0<small>units per merge/);
  assert.match(html, /<td>2026-11-18<\/td><td>Data unavailable<\/td>/);
});

test('an old file shows the shared Stale badge with its own time and year; no file shows Data unavailable', () => {
  const html = renderCostTile(validateCost(sample(), NOW), NOW + 4 * 3600000);
  assert.equal(html.match(/class="stale-badge">Stale<\/span>/g)?.length, 1);
  assert.match(html, /Last good value from Nov 23, 2026, 12:05[\s ]PM PT/);
  assert.doesNotMatch(html, /Stale since|cost-stale/);
  assert.doesNotMatch(html, /<p class="sub">[^<]*<div/);  // a block inside a paragraph is invalid markup
  assert.match(html, /units per merge on 2026-11-23, target/);
  assert.doesNotMatch(renderCostTile(validateCost(sample(), NOW), Date.parse('2026-11-23T20:05:11Z') + 3 * 3600000), /stale-badge/);  // exactly 3 h is still fresh
  assert.match(renderCostTile(validateCost(sample(), NOW), Date.parse('2026-11-23T20:05:11Z') + 3 * 3600000 + 1000), /stale-badge/);
  assert.match(renderCostTile(undefined, NOW), /Data unavailable/);
  assert.doesNotMatch(renderCostTile(undefined, NOW), /stale-badge/);
});

function build(cost, roadmap = true) {
  const dir = mkdtempSync(join(tmpdir(), 'cost-tile-'));
  try {
    const data = join(dir, 'roadmap.json'), out = join(dir, 'out'), file = join(dir, 'cost.json');
    if (roadmap) writeFileSync(data, JSON.stringify({ updatedAt: new Date().toISOString(), epics: [],
      stats: { 'danswett/agent-bridge': { issues: { counts: { resolved: 90, total: 123 } }, commits: { total: 456 } } } }));
    if (cost !== undefined) writeFileSync(file, typeof cost === 'string' ? cost : JSON.stringify(cost));
    const run = spawnSync(process.execPath, ['site/build.mjs', data, out, join(dir, 'none.json'), join(dir, 'none2.json'), file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(out, 'index.html'), 'utf8');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the page builds with the tile from data/cost.json and without it', () => {
  const fresh = { ...sample(), generatedAt: new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, 'Z') };
  const tile = (html) => html.match(/<section class="card cost"[\s\S]*?<\/section>/)[0];
  assert.match(tile(build(fresh)), /target 300/);
  for (const missing of [undefined, '{not json']) {
    const html = tile(build(missing));
    assert.match(html, /Data unavailable/);
    assert.doesNotMatch(html, /target 300|<table/);
  }
  assert.doesNotMatch(build({ ...fresh, host: 'SECRET-HOST' }), /SECRET-HOST/);
});
