import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

test('designed roadmap renders on phone and desktop without outside requests', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-design-')), out = join(dir, 'out');
  const data = join(dir, 'data.json'), people = join(dir, 'people.json'), requests = [], failures = [], pending = new Map();
  const raw = 'https://raw.githubusercontent.com/danswett/slipgates-roadmap/fleet-counts/';
  const publicUrls = [`${raw}people-at-work.json`, `${raw}fleet-counts.json`], expectedFailures = new Set();
  let fixtureMode = 'fresh', fixtureAt;
  const value = { updatedAt: new Date().toISOString(), totals: { prsMerged: 100 }, people: { builders: 3, reviewers: 2 },
    epics: [{ number: 2, title: 'Finished', closed: 3, open: 0, priority_order: 1, open_prs: 0, merged_last_24h: 4, blockers: [] },
      { number: 1, title: 'Blocked', closed: 1, open: 2, priority_order: 2, open_prs: 2, merged_last_24h: 1, blockers: [7],
        blocked: true, blockerDetails: [{ number: 1925, title: 'Phone layout decision', reason: 'waiting on the phone layout decision from the design review next week', clearsIt: 'Creative' }],
        blockedChildren: [{ number: 7, title: 'Row menu on a phone', clearsIt: 'Creative', blockers: [{ number: 1925, title: 'Phone layout decision', reason: 'waiting on the phone layout decision from the design review next week', clearsIt: 'Creative' }] },
          { number: 9, title: 'Missing source blocker', clearsIt: 'Unassigned', blockers: [{ number: null, title: 'No blocker recorded', reason: 'No blocker recorded', clearsIt: 'Unassigned' }] }] },
      { number: 3, title: 'No slices yet', closed: 0, open: 0, priority_order: 3, open_prs: 0, merged_last_24h: 0, blockers: [] }],
    stats: { 'danswett/agent-bridge': { prsMergedTotal: 100, commits: { total: 456 }, issues: { counts: { total: 123, resolved: 90 } },
      merges: { last_24_hours: 17, per_hour: Array.from({ length: 48 }, (_, i) => ({ at: new Date((Math.floor(Date.now() / 3600000) - 47 + i) * 3600000).toISOString(), count: i % 8 })) },
      pull_requests: { merged_per_day: Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), count: i })), median_hours_to_merge: 1.25 },
      ci: { median_minutes: 6.8 } } } };
  fixtureAt = value.updatedAt;
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try { res.setHeader('Content-Type', path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/html'); res.end(readFileSync(join(out, path === '/' ? 'index.html' : path.slice(1)))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = spawn(process.env.ROADMAP_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let socket, sequence = 0;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''; browser.on('error', reject); browser.on('exit', (code) => reject(new Error(`Browser exited: ${code}\n${output}`)));
      browser.stderr.on('data', (chunk) => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) resolve(match[1]); });
    });
    const target = await (await fetch(`http://${new URL(endpoint).host}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data); if (event.id) { const call = pending.get(event.id); pending.delete(event.id); event.error ? call.reject(new Error(JSON.stringify(event.error))) : call.resolve(event.result); }
      if (event.method === 'Network.requestWillBeSent') requests.push(event.params.request.url);
      if (event.method === 'Fetch.requestPaused') {
        const { request, requestId, networkId } = event.params;
        assert.ok(publicUrls.includes(request.url)); assert.ok(!Object.keys(request.headers).some(key => /^(authorization|cookie)$/i.test(key)));
        if (fixtureMode === 'blocked') { expectedFailures.add(networkId); void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); }
        else {
          const sample = request.url.endsWith('people-at-work.json') ? { schema: 1, generatedAt: fixtureAt, builders: 7, reviewers: 4 }
            : { schema: 1, generatedAt: fixtureAt, issuesOpen: 4, issuesResolved: 9, commits: 12345, prsMerged24h: 0, prsMerged14d: 0, prsMergedTotal: 99,
              ...Object.fromEntries(['Hour', 'Day'].flatMap(unit => Array.from({ length: unit === 'Hour' ? 24 : 14 }, (_, i) => [`merge${unit}${String(i).padStart(2, '0')}`, 0]))) };
          void send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(JSON.stringify(sample)).toString('base64') });
        }
      }
      if ((event.method === 'Network.loadingFailed' && !expectedFailures.has(event.params.requestId)) || (event.method === 'Network.responseReceived' && event.params.response.status >= 400)) failures.push(event);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.equal(result.exceptionDetails, undefined, JSON.stringify(result)); return result.result.value; };
    await send('Network.enable'); await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: `${raw}*`, requestStage: 'Request' }] });
    const liveReady = (state = 'ready') => evaluate(`new Promise((resolve, reject) => { let tries = 0; const check = () => [...document.querySelectorAll('[data-live-counts]')].every(e => e.dataset.liveState === '${state}') ? resolve() : ++tries > 300 ? reject(new Error('Live fixtures did not finish')) : setTimeout(check, 10); check(); })`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const width of [390, 820, 1180, 1376]) for (const state of ['fresh', 'partial', 'missing', 'stale']) {
      fixtureMode = state === 'partial' ? 'blocked' : 'fresh';
      writeFileSync(data, JSON.stringify(state === 'missing' ? { error: 'Repository read failed' } : { ...value, ...(state === 'partial' ? { people: undefined, totals: undefined, stats: { 'danswett/agent-bridge': { ...value.stats['danswett/agent-bridge'], prsMergedTotal: undefined, merges: { last_24_hours: 17 }, pull_requests: undefined, ci: undefined } } } : {}), ...(state === 'stale' ? { updatedAt: new Date(Date.now() - 3600000).toISOString() } : {}) }));
      writeFileSync(people, JSON.stringify(state === 'fresh' ? { schema: 1, generatedAt: value.updatedAt, builders: 3, reviewers: 2 } : null));
      const build = spawnSync(process.execPath, ['site/build.mjs', data, out, join(dir, 'missing-fleet'), people], { encoding: 'utf8' }); assert.equal(build.status, 0, build.stderr);
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setTouchEmulationEnabled', { enabled: width === 390, maxTouchPoints: 1 });
      await send('Page.navigate', { url: `${origin}/?${width}-${state}` });
      await evaluate("new Promise(r => { const ready = async () => { await document.fonts.ready; r(true); }; document.readyState === 'complete' ? ready() : addEventListener('load', ready, {once:true}); })");
      await liveReady(fixtureMode === 'blocked' ? 'unavailable' : 'ready');
      const view = await evaluate(`({ title: document.querySelector('h1')?.textContent, header: document.querySelector('.lockup')?.textContent, tiles: document.querySelectorAll('.tiles .card').length, epics: [...document.querySelectorAll('.epic')].map(e => ({ id: e.querySelector('a')?.textContent, bar: e.querySelector('[role=progressbar]')?.getAttribute('aria-valuetext'), chip: e.querySelector('.chip')?.textContent })), overflow: document.documentElement.scrollWidth > innerWidth, fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family), targets: [...document.querySelectorAll('a')].filter(a => a.getClientRects().length).every(a => a.getBoundingClientRect().height >= 44), motion: [...document.querySelectorAll('.bar i')].every(e => getComputedStyle(e).animationName === 'none'), text: document.body.textContent })`);
      const style = await evaluate(`({ repeat: getComputedStyle(document.body).backgroundRepeat, height: document.body.getBoundingClientRect().height, footer: document.querySelector('footer') && { size: getComputedStyle(document.querySelector('footer')).fontSize, color: getComputedStyle(document.querySelector('footer')).color, text3: getComputedStyle(document.body).getPropertyValue('--ab-text3').trim(), border: getComputedStyle(document.querySelector('footer')).borderTopStyle }, columns: document.querySelector('.tiles') && getComputedStyle(document.querySelector('.tiles')).gridTemplateColumns.split(' ').length })`);
      assert.equal(style.repeat, 'no-repeat'); assert.ok(style.height >= 1000); assert.equal(style.footer?.size, '13px'); assert.equal(style.footer.border, 'solid');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('footer')).color === getComputedStyle(document.querySelector('.epic .id') ?? document.querySelector('footer')).color"), true);
      assert.doesNotMatch(view.text, /Data unavailable:|Data artifact/);
      assert.match(view.header, /Slipgates.*Roadmap/); assert.equal(view.overflow, false); assert.equal(view.targets, true);
      assert.ok(view.fonts.includes('Slipgates Sans')); assert.equal(view.motion, true); assert.match(view.text, /slipgates-fleet \(private repo, counts only\)/);
      if (state === 'fresh' || state === 'partial') {
        assert.equal(view.title, 'Where Slipgates stands'); assert.equal(view.tiles, 4); assert.equal(view.epics.length, 3);
        const blockers = await evaluate(`(() => { const card = document.querySelector('[aria-labelledby="h-bl"]'); return card && { title: card.querySelector('h2').textContent, text: card.textContent, rows: card.querySelectorAll('li').length, glyphs: card.querySelectorAll('svg[aria-hidden="true"]').length, clipped: [...card.querySelectorAll('a,p')].some(e => e.scrollWidth > e.clientWidth + 1), color: getComputedStyle(card.querySelector('svg')).color, amber: getComputedStyle(document.querySelector('.blk summary svg')).color }; })()`);
        assert.ok(blockers, `${width}-${state}: standalone Blockers card`);
        assert.equal(blockers.title, 'Blockers'); assert.equal(blockers.rows, 1); assert.equal(blockers.glyphs, 1);
        assert.match(blockers.text, /Blocked by #1925.*phone layout decision/); assert.match(blockers.text, /No blocker recorded/);
        assert.equal(blockers.clipped, false); assert.equal(blockers.color, blockers.amber);
        assert.match(view.epics[0].id, /#2.*Finished/); assert.equal(view.epics[0].bar, '3 of 3 slices done'); assert.match(view.epics[0].chip, /Done/);
        const badge = await evaluate(`({ text: document.querySelector('.blk summary')?.textContent, height: document.querySelector('.blk summary')?.getBoundingClientRect().height, motion: getComputedStyle(document.querySelector('.blk .chev') ?? document.body).transitionDuration })`);
        assert.match(badge.text, /Blocked by #1925/); assert.match(badge.text, /\+1 more/); assert.ok(badge.height >= (width === 390 ? 44 : 32)); assert.equal(badge.motion, '0s');
        assert.equal(await evaluate("(() => { const label = document.querySelector('.blk .what b').getBoundingClientRect(), what = document.querySelector('.blk .what').getBoundingClientRect(); return label.right <= what.right && label.height < 25; })()"), true, `${width}-${state}: issue label never clips or wraps`);
        assert.equal(await evaluate("(() => { const more = document.querySelector('.blk .more').getBoundingClientRect(), summary = document.querySelector('.blk summary').getBoundingClientRect(); return more.top >= summary.top && more.bottom <= summary.bottom && more.right <= summary.right; })()"), true, `${width}-${state}: more count stays visible`);
        await send('Runtime.evaluate', { expression: "document.querySelector('.blk summary').focus()" });
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        assert.deepEqual(await evaluate("({ open: document.querySelector('.blk').open, role: document.querySelector('.blk-list').textContent.includes('Clears it: Creative'), focused: document.activeElement.tagName })"), { open: true, role: true, focused: 'SUMMARY' }, `${width}-${state}`);
        assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth && !document.querySelector('.epic').textContent.includes('Data unavailable')"), true);
        assert.equal(await evaluate("[...document.querySelectorAll('.blk-list a')].every(a => a.getBoundingClientRect().height >= 44) && document.querySelector('.need').textContent.includes('Needs a blocker (1)')"), true);
        for (const features of [[{ name: 'prefers-color-scheme', value: 'light' }], [{ name: 'forced-colors', value: 'active' }]]) {
          await send('Emulation.setEmulatedMedia', { features });
          assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('.blk summary')).color !== getComputedStyle(document.body).backgroundColor"), true);
        }
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
        assert.equal(view.epics[2].bar, undefined); assert.equal(view.epics[2].chip, undefined);
        assert.equal(style.columns, width < 900 ? 2 : 4); assert.match(view.text, /No slices planned/);
        assert.match(view.text, /Merges per hour, last 24 h/); assert.match(view.text, /Throughput/);
        const charts = await evaluate(`({ spark: document.querySelectorAll('.spark .dot').length, bars: document.querySelectorAll('.bars i').length, tables: document.querySelectorAll('.charts details').length, notes: document.querySelector('.charts').textContent.match(/Data unavailable/g)?.length ?? 0 })`);
        assert.deepEqual(charts, state === 'fresh' ? { spark: 1, bars: 14, tables: 2, notes: 0 } : { spark: 0, bars: 0, tables: 0, notes: 4 });
        if (state === 'fresh') {
          assert.deepEqual(await evaluate("[...document.querySelectorAll('.people .stat')].map(e => e.textContent)"), ['7', '4']);
          assert.equal(await evaluate("document.querySelector('[data-live-merged] .stat')?.textContent"), '199');
          assert.ok(await evaluate("document.querySelector('.people + .sub time')?.dateTime"));
          const producerAt = Date.parse(value.updatedAt);
          const badge = () => evaluate("(() => { const root = document.querySelector('[data-live-counts=\"people\"]'), badge = root.querySelector('[data-people-stale]'); return { hidden: badge?.hidden, text: badge?.textContent, display: badge && getComputedStyle(badge).display, at: root.querySelector('[data-people-generated-at]')?.dateTime }; })()");
          assert.equal((await badge()).hidden, true, 'fresh counts have no stale badge');
          await evaluate(`Date.now = () => ${producerAt + 900000}; dispatchEvent(new Event('pageshow'))`);
          assert.equal((await badge()).hidden, true, 'exactly fifteen minutes is fresh');
          await evaluate(`Date.now = () => ${producerAt + 900001}; new Promise((resolve, reject) => { let tries = 0; const check = () => !document.querySelector('[data-live-counts="people"] [data-people-stale]').hidden ? resolve() : ++tries > 50 ? reject(new Error('Badge did not age')) : setTimeout(check, 100); check(); })`);
          assert.deepEqual(await badge(), { hidden: false, text: 'Stale', display: 'inline-block', at: value.updatedAt },
            'an open page ages without a deployment or reload');
          await evaluate(`Date.now = () => ${producerAt}; document.dispatchEvent(new Event('visibilitychange'))`);
          assert.equal((await badge()).hidden, true);
          const injected = await send('Page.addScriptToEvaluateOnNewDocument', { source: `Date.now = () => ${producerAt + 7200000}` });
          await send('Page.navigate', { url: `${origin}/?${width}-old-deployment` });
          await evaluate("new Promise(r => document.readyState === 'complete' ? r() : addEventListener('load', r, { once: true }))");
          await liveReady();
          assert.equal((await badge()).hidden, false, 'an already old deployment is marked on load');
          assert.equal((await badge()).at, value.updatedAt);
          assert.deepEqual(await evaluate("[...document.querySelectorAll('.people .stat')].map(e => e.textContent)"), ['7', '4']);
          assert.equal(await evaluate("[...document.querySelectorAll('[data-people-stale]')].every(e => !e.hidden)"), true);
          assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
          fixtureAt = new Date(producerAt + 7200000).toISOString();
          await send('Page.navigate', { url: `${origin}/?${width}-old-html-fresh-fleet` });
          await evaluate("new Promise(r => document.readyState === 'complete' ? r() : addEventListener('load', r, { once: true }))");
          await liveReady();
          assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-live-merged] time')].map(e => ({ at: e.dateTime, stale: !e.parentElement.querySelector('[data-people-stale]').hidden }))"),
            [{ at: value.updatedAt, stale: true }, { at: fixtureAt, stale: false }], 'fresh fleet must not freshen the baked public component');
          const beforeResume = requests.filter(url => publicUrls.includes(url)).length;
          fixtureMode = 'blocked';
          await evaluate("dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
          await liveReady('unavailable');
          assert.equal(requests.filter(url => publicUrls.includes(url)).length, beforeResume + 2, 'persisted resume rereads both fixed public files');
          assert.equal(await evaluate("[...document.querySelectorAll('[data-live-counts]')].every(e => /unavailable/i.test(e.textContent)) && document.querySelector('[data-live-merged] .stat').textContent === '100'"), true);
          fixtureMode = 'fresh'; fixtureAt = value.updatedAt;
          await evaluate("dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
          await liveReady();
          await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
          await evaluate("document.querySelectorAll('.charts details').forEach(e => e.open = true)");
          assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
          assert.equal(await evaluate("[...document.querySelectorAll('.charts summary')].every(e => e.getBoundingClientRect().height >= 44)"), true);
          assert.equal(await evaluate("[...document.querySelectorAll('.charts .line,.charts .bars i')].every(e => getComputedStyle(e).animationName === 'none')"), true);
          for (const mode of ['light', 'contrast']) {
            await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'forced-colors', value: mode === 'contrast' ? 'active' : 'none' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
            assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll('.charts h2,.charts h3,.charts .stat,.charts summary,.charts th,.charts td')].some(e => e.scrollWidth > e.clientWidth + 1)"), false);
            if (mode === 'contrast') assert.equal(await evaluate("getComputedStyle(document.querySelector('.spark .area')).fill"), 'none');
            if (process.env.ROADMAP_SCREENSHOTS) { mkdirSync(process.env.ROADMAP_SCREENSHOTS, { recursive: true }); writeFileSync(join(process.env.ROADMAP_SCREENSHOTS, `${width}-${mode}.png`), Buffer.from((await send('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64')); }
          }
          await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'forced-colors', value: 'none' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
          await evaluate("document.querySelectorAll('.charts details').forEach(e => e.open = false)");
        }
        assert.match(view.text, /4 of 6 planned slices done across 3 epics/); assert.ok(view.fonts.includes('Slipgates Mono'));
        if (state === 'partial') assert.equal(await evaluate("[...document.querySelectorAll('.tiles .card')].filter(e => /Pull requests merged|People at work/.test(e.textContent)).every(e => e.textContent.match(/Data unavailable|Unavailable/g)?.length === 1 && getComputedStyle(e.querySelector('.none')).fontSize === '16px' && !e.querySelector('.stat'))"), true);
      } else { assert.equal(view.title, 'Data unavailable'); assert.equal(await evaluate("document.querySelector('[aria-labelledby=\"h-bl\"]')"), null); if (state === 'stale') { assert.match(view.text, /Out of date\. Last update/); assert.match(view.text, /The last good update was at .* PT/); } }
      if (process.env.ROADMAP_SCREENSHOTS) { mkdirSync(process.env.ROADMAP_SCREENSHOTS, { recursive: true }); writeFileSync(join(process.env.ROADMAP_SCREENSHOTS, `${width}-${state}.png`), Buffer.from((await send('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64')); }
    }
    assert.ok(requests.some(url => url.endsWith('.woff2'))); assert.ok(publicUrls.every(url => requests.includes(url)));
    assert.ok(requests.every(url => new URL(url).origin === origin || publicUrls.includes(url)), requests.join('\n')); assert.deepEqual(failures, []);
  } finally { socket?.close(); browser.kill(); await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit', resolve)); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
});
