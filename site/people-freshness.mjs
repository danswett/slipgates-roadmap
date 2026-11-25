export function updatePeopleFreshness(root, now = Date.now()) {
  for (const time of root.querySelectorAll('[data-people-generated-at]')) {
    const mark = time.nextElementSibling;  // a following <span data-age> shows how old the producer time is
    if (mark?.hasAttribute?.('data-age')) {
      const minutes = Math.floor((now - Date.parse(time.dateTime)) / 60000);
      mark.textContent = !Number.isFinite(minutes) || minutes < 0 ? '' : minutes < 1 ? ' (just now)' : minutes < 60 ? ` (${minutes} min ago)` : ` (${Math.floor(minutes / 60)} h ago)`;
    }
    const badge = time.parentElement.querySelector('[data-people-stale]');
    if (!badge) continue;
    const age = now - Date.parse(time.dateTime);
    badge.hidden = Number.isFinite(age) && age >= -60000 && age <= 15 * 60000;
  }
}
