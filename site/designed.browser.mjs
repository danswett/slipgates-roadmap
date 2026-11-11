import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

test('designed roadmap renders on phone and desktop without outside requests', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadmap-design-')), out = join(dir, 'out');
  const data = join(dir, 'data.json'), requests = [], failures = [], pending = new Map();
  const value = { updatedAt: new Date().toISOString(), people: { builders: 3, reviewers: 2 },
    epics: [{ number: 2, title: 'Finished', closed: 3, open: 0 }, { number: 1, title: 'Blocked', closed: 1, open: 2, blockers: [7] },
      { number: 3, title: 'No slices yet', closed: 0, open: 0 }],
    stats: { 'danswett/agent-bridge': { commits: { total: 456 }, issues: { counts: { total: 123, resolved: 90 } },
      merges: { last_24_hours: 17 }, pull_requests: { total_merged: 100 } } } };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try { res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.woff2') ? 'font/woff2' : 'text/html'); res.end(readFileSync(join(out, path === '/' ? 'index.html' : path.slice(1)))); }
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
    const target = await (await fetch(`http://${new URL(endpoint).host}/json/new?${origin}`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data); if (event.id) { const call = pending.get(event.id); pending.delete(event.id); event.error ? call.reject(new Error(JSON.stringify(event.error))) : call.resolve(event.result); }
      if (event.method === 'Network.requestWillBeSent') requests.push(event.params.request.url);
      if (event.method === 'Network.loadingFailed' || (event.method === 'Network.responseReceived' && event.params.response.status >= 400)) failures.push(event);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.equal(result.exceptionDetails, undefined, JSON.stringify(result)); return result.result.value; };
    await send('Network.enable'); await send('Page.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const width of [390, 1180]) for (const state of ['fresh', 'partial', 'missing', 'stale']) {
      writeFileSync(data, JSON.stringify(state === 'missing' ? { error: 'Repository read failed' } : { ...value, ...(state === 'partial' ? { people: undefined, stats: { 'danswett/agent-bridge': { ...value.stats['danswett/agent-bridge'], pull_requests: undefined } } } : {}), ...(state === 'stale' ? { updatedAt: new Date(Date.now() - 3600000).toISOString() } : {}) }));
      const build = spawnSync(process.execPath, ['site/build.mjs', data, out], { encoding: 'utf8' }); assert.equal(build.status, 0, build.stderr);
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: `${origin}/?${width}-${state}` });
      await evaluate("new Promise(r => { const ready = async () => { await document.fonts.ready; r(true); }; document.readyState === 'complete' ? ready() : addEventListener('load', ready, {once:true}); })");
      const view = await evaluate(`({ title: document.querySelector('h1')?.textContent, header: document.querySelector('.lockup')?.textContent, tiles: document.querySelectorAll('.tiles .card').length, epics: [...document.querySelectorAll('.epic')].map(e => ({ id: e.querySelector('a')?.textContent, bar: e.querySelector('[role=progressbar]')?.getAttribute('aria-valuetext'), chip: e.querySelector('.chip')?.textContent })), overflow: document.documentElement.scrollWidth > innerWidth, fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family), targets: [...document.querySelectorAll('a')].every(a => a.getBoundingClientRect().height >= 44), motion: [...document.querySelectorAll('.bar i')].every(e => getComputedStyle(e).animationName === 'none'), text: document.body.textContent })`);
      assert.match(view.header, /Slipgates.*Roadmap/); assert.equal(view.overflow, false); assert.equal(view.targets, true);
      assert.ok(view.fonts.includes('Slipgates Sans')); assert.equal(view.motion, true); assert.match(view.text, /The private slipgates-fleet repository is not included/);
      if (state === 'fresh' || state === 'partial') {
        assert.equal(view.title, 'Where Slipgates stands'); assert.equal(view.tiles, 4); assert.equal(view.epics.length, 3);
        assert.match(view.epics[0].id, /#2.*Finished/); assert.equal(view.epics[0].bar, '3 of 3 slices done'); assert.match(view.epics[0].chip, /Done/);
        assert.match(view.epics[1].chip, /Blocked/); assert.equal(view.epics[2].bar, '0 of 0 slices done'); assert.equal(view.epics[2].chip, undefined);
        assert.match(view.text, /4 of 6 planned slices done across 3 epics/); assert.ok(view.fonts.includes('Slipgates Mono'));
        if (state === 'partial') assert.equal(await evaluate("[...document.querySelectorAll('.tiles .card')].filter(e => /Pull requests merged|People at work/.test(e.textContent)).every(e => e.textContent.includes('Data unavailable'))"), true);
      } else { assert.equal(view.title, 'Data unavailable'); if (state === 'stale') assert.match(view.text, /Out of date\. Last update/); }
      if (process.env.ROADMAP_SCREENSHOTS) { mkdirSync(process.env.ROADMAP_SCREENSHOTS, { recursive: true }); writeFileSync(join(process.env.ROADMAP_SCREENSHOTS, `${width}-${state}.png`), Buffer.from((await send('Page.captureScreenshot', { captureBeyondViewport: true })).data, 'base64')); }
    }
    assert.ok(requests.some(url => url.endsWith('.woff2'))); assert.ok(requests.every(url => new URL(url).origin === origin), requests.join('\n')); assert.deepEqual(failures, []);
  } finally { socket?.close(); browser.kill(); await new Promise(resolve => browser.exitCode !== null ? resolve() : browser.once('exit', resolve)); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
});
