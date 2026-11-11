const unavailable = (field) => {
  console.error(`Data unavailable: ${field}.`);
  return '<p class="none">Data unavailable</p>';
};
function window(bins, size, step) {
  if (!Array.isArray(bins) || bins.length < size) return null;
  const rows = bins.slice(-size);
  return rows.every((b, i) => b && Number.isSafeInteger(b.count) && b.count >= 0 &&
    typeof b.at === 'string' && Number.isFinite(Date.parse(b.at)) &&
    (!i || Date.parse(b.at) - Date.parse(rows[i - 1].at) === step)) ? rows : null;
}
const pt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const table = (rows, hourly) => `<details><summary>View as a table</summary><table>
<caption>${hourly ? 'Hourly merges (Pacific time)' : 'Daily merged PRs (Pacific dates)'}</caption>
<thead><tr><th scope="col">${hourly ? 'Hour starting' : 'Date'}</th><th scope="col">Merged</th></tr></thead>
<tbody>${rows.map(b => `<tr><td>${hourly ? pt.format(new Date(b.at)) : new Date(b.at).toISOString().slice(0, 10)}</td><td>${b.count}</td></tr>`).join('')}</tbody></table></details>`;
function metric(value, hours) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 60)
    return unavailable(hours ? 'median time to merge' : 'main CI time');
  const minutes = Math.round(value * 60);
  return `<div class="stat num">${hours ? `${Math.floor(minutes / 60)}<small>h</small> ${minutes % 60}<small>min</small>` : `${Number(value.toFixed(1))}<small>min</small>`}</div>`;
}
export function renderCharts(stats) {
  const hours = window(stats?.merges?.per_hour, 24, 3600000);
  const days = window(stats?.pull_requests?.merged_per_day, 14, 86400000);
  let hourly = '', daily = '';
  if (hours) {
    const peak = Math.max(...hours.map(b => b.count)), max = Math.max(peak, 1);
    const points = hours.map((b, i) => `${(4 + i * 552 / 23).toFixed(1)} ${(112 - b.count / max * 96).toFixed(1)}`);
    const line = `M${points.join('L')}`, last = points.at(-1).split(' ');
    hourly = `<div class="stat num">${hours.at(-1).count}<small>this hour, peak ${peak}</small></div>
<svg class="spark" viewBox="0 0 560 120" role="img" aria-label="Merges per hour over the last 24 hours, now ${hours.at(-1).count}, peak ${peak}">
<line class="axis" x1="0" x2="560" y1="119" y2="119"/><path class="area" d="${line}L556 120L4 120Z"/>
<path class="line" pathLength="1" d="${line}"/><circle class="dot" cx="${last[0]}" cy="${last[1]}" r="4"/></svg>
<div class="axis-l" aria-hidden="true"><span>23 hours ago</span><span>Now</span></div>${table(hours, true)}`;
  }
  if (days) {
    const max = Math.max(...days.map(b => b.count), 1), average = Math.round(days.reduce((n, b) => n + b.count, 0) / 14);
    daily = `<div class="stat num">${average}<small>PRs merged per day, 14-day average</small></div>
<div class="bars" role="img" aria-label="Pull requests merged per day over 14 days, today ${days.at(-1).count}">${days.map(b => `<i style="--h:${Math.round(b.count / max * 100)}%"></i>`).join('')}</div>
<div class="axis-l" aria-hidden="true"><span>13 days ago</span><span>Today</span></div>${table(days, false)}`;
  }
  return `<div class="grid charts"><section class="card" aria-labelledby="h-mph"><h2 id="h-mph">Merges per hour, last 24 h</h2>${hours ? hourly : unavailable('hourly merges')}</section>
<section class="card" aria-labelledby="h-throughput"><h2 id="h-throughput">Throughput</h2>${days ? daily : unavailable('daily merged PRs')}
<div class="grid metrics"><div><h3>Median time to merge</h3>${metric(stats?.pull_requests?.median_hours_to_merge, true)}</div>
<div><h3>Main CI time</h3>${metric(stats?.ci?.median_minutes, false)}</div></div></section></div>`;
}
