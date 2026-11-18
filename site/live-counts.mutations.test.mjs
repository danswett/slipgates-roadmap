import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const mutations = [
  ['stale catch guard', '    } catch {\n      if (active.get(root) !== controllers) return;', '    } catch {'],
  ['previous controllers', '  active.get(root)?.forEach(controller => controller.abort());', ''],
  ['non-ok response', '!response.ok || ', ''],
  ['ten-second deadline', 'timer = setTimeout(() => controller.abort(), 10000)',
    'timer = setTimeout(() => controller.abort(), 10001)'],
];

test('live-counts regressions kill the four review mutations by assertion', async (t) => {
  for (const [name, before, after] of mutations) {
    await t.test(name, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'roadmap-live-counts-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      for (const file of ['live-counts.test.mjs', 'live-counts.mjs', 'people-at-work.mjs',
        'fleet-counts.mjs', 'people-freshness.mjs']) {
        copyFileSync(new URL(file, import.meta.url), join(directory, file));
      }
      const module = join(directory, 'live-counts.mjs');
      const source = readFileSync(module, 'utf8').replaceAll('\r\n', '\n');
      assert.equal(source.split(before).length, 2, `${name}: mutation must match exactly once`);
      writeFileSync(module, source.replace(before, after));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath,
        ['--test', '--test-concurrency=1', '--test-reporter=tap', join(directory, 'live-counts.test.mjs')],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, env });
      const output = result.stdout + result.stderr;
      assert.equal(result.error, undefined, `${name}: child must finish within five seconds\n${output}`);
      assert.equal(result.signal, null, `${name}: child must not be killed\n${output}`);
      assert.equal(result.status, 1, `${name}: mutation survived\n${output}`);
      assert.match(output, /ERR_ASSERTION/, `${name}: must fail by assertion\n${output}`);
      assert.doesNotMatch(output, /cancelledByParent|testTimeoutFailure|Promise resolution is still pending/,
        `${name}: must not hang or cancel tests\n${output}`);
    });
  }
});
