export function updatePeopleFreshness(root, now = Date.now()) {
  const time = root.querySelector('[data-people-generated-at]');
  const badge = root.querySelector('[data-people-stale]');
  if (!time || !badge) return;
  const age = now - Date.parse(time.dateTime);
  badge.hidden = Number.isFinite(age) && age >= -60000 && age <= 15 * 60000;
}

if (typeof document !== 'undefined' && document.querySelector('[data-people-stale]')) {
  const update = () => updatePeopleFreshness(document);
  update();
  setInterval(update, 1000);
  document.addEventListener('visibilitychange', update);
  globalThis.addEventListener('pageshow', update);
}
