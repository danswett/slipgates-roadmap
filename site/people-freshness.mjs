export function updatePeopleFreshness(root, now = Date.now()) {
  for (const time of root.querySelectorAll('[data-people-generated-at]')) {
    const badge = time.parentElement.querySelector('[data-people-stale]');
    if (!badge) continue;
    const age = now - Date.parse(time.dateTime);
    badge.hidden = Number.isFinite(age) && age >= -60000 && age <= 15 * 60000;
  }
}
