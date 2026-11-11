# slipgates-roadmap
Slipgates roadmap: epic progress, published to roadmap.slipgates.com

`python tools/epic-dashboard/repo_dashboard.py` writes `dashboard.md` and `dashboard-data.json`;
`--write` updates only agent-bridge #755's body, ignoring timestamp-only changes.
Uses public epic labels, sub-issues, linked PRs and #696 order, then priority labels,
through the caller's repository credential in `gh`; no Project access or new secret.
Read errors yield visible `Data unavailable` and JSON `error`, exit 0; write errors fail.
Run `python -m unittest discover -s tools/epic-dashboard -v`; Windows Python needs `tzdata`.

Pages runs D1 (including D4 statistics) with its read-only token in the separate,
continue-on-error data job; only `roadmap.json` reaches the token-free static build.
The page shows agent-bridge epics and totals with the data's `updatedAt` time.
Missing, invalid or older-than-15-minute data renders Data unavailable; missing
statistics are explicitly unavailable, never zero. No write to #755 is made.
Fleet contributes only `fleet-counts.json` from this public repo's `fleet-counts`
branch, fetched without credentials. A separate private producer owns publication;
the public build never reads private content or holds its publication credential.
The exact 45-key schema is `schema: 1`, UTC `generatedAt`, `issuesOpen`,
`issuesResolved`, `commits`, `prsMerged24h`, `prsMerged14d`, `mergeHour00`-`23`
and `mergeDay00`-`13`. Counts are integers 0-100000000; totals must sum their bins.
Bins are completed UTC hours/days, oldest first. A missing, invalid, future-dated
over one minute or over-two-hour-old file shows Fleet counts unavailable only in
that panel. No private text or rejected payload is rendered or logged.
The branded header, hero, totals and epic cards follow the approved #1897 design.
Epic cards show child progress, open children, blockers, open PRs and 24-hour merges,
in the generator's #696-then-priority order. Invalid epic details show Data unavailable.
Missing all-time merged-PR and live people counts remain explicitly unavailable;
30-day authors and review families are not presented as people at work.
Tokens and self-hosted fonts are the approved agent-bridge brand assets (OFL in
`site/fonts`); the D6a stylesheet is the chart-free subset of the Creative board.
Run `node --test --test-concurrency=1 site/designed.browser.mjs` for 390/1180px
rendered checks with installed Edge, or set `ROADMAP_BROWSER` to a Chromium binary.
`ROADMAP_SCREENSHOTS` saves the checked states; no browser-test dependency is needed.
Cron refreshes every five minutes, best effort; the page shows its Pacific update time.
SRE manages the custom domain. Validate with `pwsh -File quality/run.ps1` (Node, Python and actionlint).
