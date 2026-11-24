const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// A value carried over from an earlier run (stale_since, set by tools/epic-dashboard/stats.py) is labelled, never shown as fresh.
// Only a timestamp is formatted; anything else prints as a fixed phrase, and what is printed is escaped.
const when = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) + ' PT'
  : 'an earlier run';
export const staleBadge = (...parts) => {
  const part = parts.find((p) => p && typeof p === 'object' && p.stale_since !== undefined);
  if (!part) return '';
  const text = `Last good value from ${escape(when(part.stale_since))}`;
  return `<span class="stale-badge">Stale</span><div class="sub">${text}</div>`;
};
