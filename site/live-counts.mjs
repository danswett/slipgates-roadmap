import { validatePeopleCounts, renderPeopleCounts } from './people-at-work.mjs';
import { validateFleetCounts, renderFleetCounts, renderMergedCounts } from './fleet-counts.mjs';
import { validateCost, renderCostTile } from './cost.mjs';
import { updatePeopleFreshness } from './people-freshness.mjs';

const source = 'https://raw.githubusercontent.com/danswett/slipgates-roadmap/fleet-counts/';
const unavailable = '<div class="none">Unavailable</div>';
const active = new WeakMap();
const good = new WeakMap();  // per page: the last value that passed validation, kept when a later read fails
const staleMark = '<span class="live-stale">Stale</span>';
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
  const publicGeneratedAt = merged?.dataset.generatedAt;
  const fleetKeep = good.get(root.querySelector('[data-live-counts="fleet"]'));
  if (merged && !fleetKeep) merged.innerHTML = renderMergedCounts(total, recent, undefined, publicGeneratedAt);
  await Promise.all([
    ['people', 'people-at-work.json', validatePeopleCounts, renderPeopleCounts],
    ['fleet', 'fleet-counts.json', validateFleetCounts, renderFleetCounts],
    ['cost', 'cost.json', validateCost, renderCostTile],
  ].map(async ([kind, file, validate, render]) => {
    const target = root.querySelector(`[data-live-counts="${kind}"]`);
    if (!target) return;
    const fallback = kind === 'fleet' ? renderFleetCounts() : unavailable;
    const keep = good.get(target);  // a copy this page already read and validated: never blanked by a slow or failed re-read
    if (!keep && kind !== 'cost') target.innerHTML = fallback;  // the cost card keeps its built copy until a read replaces it
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    controllers.push(controller);
    try {
      const response = await request(`${source}${file}?t=${Math.floor(Date.now() / 60000)}`, { credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
      const value = validate(await readBounded(response), Date.now(), Infinity);
      if (active.get(root) !== controllers) return;
      if (!value) throw new Error('Public counts invalid');
      target.innerHTML = render(value); good.set(target, { html: target.innerHTML, value });
      if (kind === 'fleet' && merged) merged.innerHTML = renderMergedCounts(total, recent, value, publicGeneratedAt);
      target.dataset.liveState = 'ready';
    } catch {
      if (active.get(root) !== controllers) return;
      console.error('Live counts unavailable.');
      if (keep) { target.innerHTML = keep.html + staleMark;
        if (kind === 'fleet' && merged) merged.innerHTML = renderMergedCounts(total, recent, keep.value, publicGeneratedAt);
        target.dataset.liveState = 'stale'; }
      else { if (kind !== 'cost') target.innerHTML = fallback; target.dataset.liveState = 'unavailable'; }
    } finally { clearTimeout(timer); controller.abort(); updatePeopleFreshness(root); }
  }));
}

if (typeof document !== 'undefined') {
  void refreshLiveCounts(document);
  const update = () => updatePeopleFreshness(document);
  setInterval(update, 1000);
  setInterval(() => { if (!document.hidden) void refreshLiveCounts(document); }, 60000);
  document.addEventListener('visibilitychange', update);
  globalThis.addEventListener('pageshow', (event) => {
    if (event.persisted) void refreshLiveCounts(document);
    else update();
  });
}
