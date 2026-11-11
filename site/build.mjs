import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [data = 'data/roadmap.json', out = '_site'] = process.argv.slice(2);
let value, reason = '';
try {
  value = JSON.parse(readFileSync(data, 'utf8'));
  const age = Date.now() - Date.parse(value?.updatedAt);
  if (typeof value?.error === 'string') reason = value.error || 'Repository read failed.';
  else if (typeof value?.unavailable === 'string') reason = value.unavailable || 'Repository data is unavailable.';
  else if (typeof value?.updatedAt !== 'string' || !Number.isFinite(age) || age < -60000 || age > 15 * 60000)
    reason = 'Data artifact is missing a valid update time or is out of date.';
  else if (!Array.isArray(value.epics) || !value.stats || typeof value.stats !== 'object' || Array.isArray(value.stats) ||
    value.epics.some((epic) => !epic || typeof epic.title !== 'string' ||
      ![epic.number, epic.closed, epic.open].every((n) => Number.isSafeInteger(n) && n >= 0)))
    reason = 'Data artifact has invalid epic or statistics fields.';
} catch (error) {
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  reason = error.code === 'ENOENT' ? 'Data artifact is missing.' : 'Data artifact is invalid JSON.';
}
if (reason) console.error(`Data unavailable: ${reason}`);
const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const timestamp = !reason ? value.updatedAt : new Date().toISOString();
const updated = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'long',
}).format(new Date(timestamp));
const count = (n) => {
  if (Number.isSafeInteger(n) && n >= 0) return n;
  console.error('Data unavailable: a repository statistic is missing or invalid.');
  return 'Data unavailable';
};
const stats = value?.stats?.['danswett/agent-bridge'], issues = stats?.issues?.counts;
const content = reason
  ? `<h2>Data unavailable</h2><p>The roadmap could not read its data at ${escape(updated)}. It tries again every few minutes. Nothing is lost.</p><p>Data unavailable: ${escape(reason)}</p>`
  : `<h2>Epics</h2>${value.epics.filter((e) => !e.repository || e.repository === 'danswett/agent-bridge')
    .map((e) => `<p>#${e.number} ${escape(e.title)}: ${e.closed} of ${e.closed + e.open} done</p>`).join('')}
<h2>danswett/agent-bridge</h2><p>Issues resolved: ${count(issues?.resolved)} of ${count(issues?.total)}</p>
<p>Commits on main: ${count(stats?.commits?.total)}; Merged in 24 hours: ${count(stats?.merges?.last_24_hours)}</p>`;
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'CNAME'), 'roadmap.slipgates.com\n');
writeFileSync(join(out, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Slipgates roadmap</title><style>
:root {
  color-scheme: light; --cp-bg: #f7f4ef; --cp-bg-elevated: #fcfbf8; --cp-surface: #ffffff; --cp-surface-soft: #f5f5f5;
  --cp-border: #dedede; --cp-border-strong: #919191; --cp-text: #242424; --cp-text-muted: #5c5c5c; --cp-text-soft: #6f6f6f;
  --cp-accent: #b11f4b; --cp-accent-hover: #9a1a41; --cp-accent-soft: rgba(177, 31, 75, 0.08); --cp-accent-fg: #ffffff;
  --cp-success: #16a34a; --cp-danger: #dc2626; --cp-warning: #f59e0b; --cp-link: #0078d4; --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
  --cp-overlay: rgba(255, 255, 255, 0.8); --cp-panel: rgba(255, 255, 255, 0.86); --cp-panel-strong: rgba(255, 255, 255, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.55); --cp-highlight: rgba(177, 31, 75, 0.12);
}
@media (prefers-color-scheme: dark) { :root {
  color-scheme: dark; --cp-bg: #3d3b3a; --cp-bg-elevated: #343231; --cp-surface: #292929; --cp-surface-soft: #2e2e2e;
  --cp-border: #474747; --cp-border-strong: #5f5f5f; --cp-text: #dedede; --cp-text-muted: #919191; --cp-text-soft: #b0b0b0;
  --cp-accent: #fd8ea1; --cp-accent-hover: #fb7b91; --cp-accent-soft: rgba(253, 142, 161, 0.14); --cp-accent-fg: #1a1a1a;
  --cp-success: #4ade80; --cp-danger: #f87171; --cp-warning: #fbbf24; --cp-link: #4da6ff; --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
  --cp-overlay: rgba(41, 41, 41, 0.88); --cp-panel: rgba(41, 41, 41, 0.72); --cp-panel-strong: rgba(41, 41, 41, 0.96);
  --cp-sheen: rgba(255, 255, 255, 0.04); --cp-highlight: rgba(253, 142, 161, 0.12);
} }
body { background: var(--cp-bg); color: var(--cp-text); margin: 32px; font-family: "Segoe UI", Aptos, Calibri, -apple-system, BlinkMacSystemFont, sans-serif; }
main { max-width: 48rem; margin: auto; } p { overflow-wrap: anywhere; } small { color: var(--cp-text-muted); }
</style></head><body><main><h1>Slipgates roadmap</h1>
${content}<p>The private slipgates-fleet repository is not included.</p>
<p><small>Updated at <time datetime="${escape(timestamp)}">${escape(updated)}</time></small></p>
</main></body></html>
`);
