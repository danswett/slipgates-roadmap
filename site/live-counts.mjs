import { validatePeopleCounts, renderPeopleCounts } from './people-at-work.mjs';
import { validateFleetCounts, renderFleetCounts, renderMergedCounts } from './fleet-counts.mjs';
import { updatePeopleFreshness } from './people-freshness.mjs';

const source = 'https://raw.githubusercontent.com/danswett/slipgates-roadmap/fleet-counts/';
const unavailable = '<div class="none">Unavailable</div>';
const active = new WeakMap();
async function readBounded(response) {
  if (!response.ok || !response.body) throw new Error('Public counts unavailable');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new Error('Public counts too large');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel(); }
}

export async function refreshLiveCounts(root, request = globalThis.fetch) {
  active.get(root)?.forEach(controller => controller.abort());
  const controllers = []; active.set(root, controllers);
  const merged = root.querySelector('[data-live-merged]');
  const total = Number(merged?.dataset.total), recent = Number(merged?.dataset.recent);
  if (merged) merged.innerHTML = renderMergedCounts(total, recent);
  await Promise.all([
    ['people', 'people-at-work.json', validatePeopleCounts, renderPeopleCounts],
    ['fleet', 'fleet-counts.json', validateFleetCounts, renderFleetCounts],
  ].map(async ([kind, file, validate, render]) => {
    const target = root.querySelector(`[data-live-counts="${kind}"]`);
    if (!target) return;
    const fallback = kind === 'fleet' ? renderFleetCounts() : unavailable;
    target.innerHTML = fallback;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    controllers.push(controller);
    try {
      const response = await request(source + file, { credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
      const value = validate(await readBounded(response), Date.now(), Infinity);
      if (active.get(root) !== controllers) return;
      if (!value) throw new Error('Public counts invalid');
      target.innerHTML = render(value);
      if (kind === 'fleet' && merged) merged.innerHTML = renderMergedCounts(total, recent, value);
      target.dataset.liveState = 'ready';
    } catch {
      if (active.get(root) !== controllers) return;
      console.error('Live counts unavailable.');
      target.innerHTML = fallback;
      target.dataset.liveState = 'unavailable';
    } finally { clearTimeout(timer); controller.abort(); updatePeopleFreshness(root); }
  }));
}

if (typeof document !== 'undefined') {
  void refreshLiveCounts(document);
  const update = () => updatePeopleFreshness(document);
  setInterval(update, 1000);
  document.addEventListener('visibilitychange', update);
  globalThis.addEventListener('pageshow', (event) => {
    if (event.persisted) void refreshLiveCounts(document);
    else update();
  });
}
