export function validatePeopleCounts(value, now = Date.now(), maxAge = 900000) {
  const unavailable = () => { console.error('People counts unavailable: missing, invalid or stale file.'); };
  const keys = ['schema', 'generatedAt', 'builders', 'reviewers'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) ||
    value.schema !== 1 || ['builders', 'reviewers'].some((key) =>
      !Number.isInteger(value[key]) || value[key] < 0 || value[key] > 1000))
    return unavailable();
  const at = typeof value.generatedAt === 'string' ? Date.parse(value.generatedAt) : NaN;
  if (typeof value.generatedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value.generatedAt) ||
    !Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== value.generatedAt.slice(0, 19) ||
    now - at < -60000 || now - at > maxAge)
    return unavailable();
  return value;
}

export function renderPeopleCounts(value) {
  if (!value) return '<div class="none">Data unavailable</div>';
  const at = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value.generatedAt));
  const timestamp = value.generatedAt.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<div class="people">${['builders', 'reviewers'].map((role) =>
    `<div><div class="stat num">${value[role]}</div><span class="sub">${role}</span></div>`).join('')}</div>
<div class="sub">Updated at <time data-people-generated-at datetime="${timestamp}">${at} PT</time>
<span class="people-stale" data-people-stale role="status">Stale</span></div>`;
}
