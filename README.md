# slipgates-roadmap
Slipgates roadmap: epic progress, published to roadmap.slipgates.com

`python tools/epic-dashboard/repo_dashboard.py` writes `dashboard.md` and `dashboard-data.json`;
`--write` updates only agent-bridge #755's body, ignoring timestamp-only changes.
Uses public epic labels, sub-issues, linked PRs and #696 order, then priority labels,
through the caller's repository credential in `gh`; no Project access or new secret.
Read errors yield visible `Data unavailable` and JSON `error`, exit 0; write errors fail.
Run `python -m unittest discover -s tools/epic-dashboard -v`; Windows Python needs `tzdata`.

Blockers come from GitHub's blocked-by relation first, then issue-body lines:
```
Blocked by #55, #12: waiting on the roster and reply path
Clears it: Engineering
```
Every reference on a `Blocked by` line is listed; a trailing reason is capped at
80 characters, otherwise the blocker title is used. `Clears it` accepts only
Engineering, Quality, Product, SRE, Creative, Migration or Owner; otherwise Unassigned.
Only agent-bridge blocker titles/reasons are published; other repositories use
`private item` for both (including qualified body references); no private blocker endpoint is queried.
Each epic adds `blocked`, `blockerDetails` and `blockedChildren`; each detail has
`number`, `title`, `reason`, `clearsIt`. Children include `number`, `title`, `blockers`,
`clearsIt`. Existing `blockers` child-number arrays remain compatible. Any blocked
open child blocks the epic; closed children do not. Label-only `blocked` or
`status:blocked` children say `No blocker recorded` and appear in top-level
`needsBlocker` (`epic`, `number`, `title`, `clearsIt`) for source correction.
Only agent-bridge children contribute; cross-repository sub-issues are excluded.
Epic badges name the first recorded cause and expand to every blocked child,
its full blocker reason and clearing role. Label-only blocks say No blocker
recorded and appear in Needs a blocker; private causes have no public issue link.

Pages runs D1 (including D4 statistics) with its read-only token in the separate,
continue-on-error data job; only `roadmap.json` reaches the token-free static build.
The page shows agent-bridge epics and totals with the data's `updatedAt` time.
Missing, invalid or older-than-15-minute data renders Data unavailable; missing
statistics are explicitly unavailable, never zero. No write to #755 is made.
Fleet contributes only `fleet-counts.json` from this public repo's `fleet-counts`
branch, fetched without credentials. A separate private producer owns publication;
the public build never reads private content or holds its publication credential.
The required 45-key schema is `schema: 1`, UTC `generatedAt`, `issuesOpen`,
`issuesResolved`, `commits`, `prsMerged24h`, `prsMerged14d`, `mergeHour00`-`23`
and `mergeDay00`-`13`. Counts are integers 0-100000000; totals must sum their bins.
An optional `prsMergedTotal` uses the same integer bounds. The merged-PR tile sums
it with agent-bridge's public `stats` field `prsMergedTotal` (GitHub's all-time
merged-only count), including both 24-hour counts. Without the fleet total it
explicitly says agent-bridge only; without the public total it says Data unavailable.
Bins are completed UTC hours/days, oldest first. A missing, invalid, future-dated
over one minute or over-two-hour-old file shows Fleet counts unavailable only in
that panel. No private text or rejected payload is rendered or logged.
The branded header, hero, totals and epic cards follow the approved #1897 design.
Epic cards show child progress, open children, blockers, open PRs and 24-hour merges,
in the generator's #696-then-priority order. Invalid epic details show Data unavailable.
Missing live people counts remain explicitly unavailable;
30-day authors and review families are not presented as people at work.
Tokens and self-hosted fonts are the approved agent-bridge brand assets (OFL in
`site/fonts`); the stylesheet follows the Creative board.
Chart cards use the latest 24 hourly merges and 14 Pacific daily merge buckets,
with native tables, a current-hour dot, highlighted today, median merge and main CI times.
Missing or invalid chart fields show Data unavailable independently, never invented zeroes.
Run `node --test --test-concurrency=1 site/designed.browser.mjs` for 390/820/1180/1376px
rendered checks with installed Edge, or set `ROADMAP_BROWSER` to a Chromium binary.
`ROADMAP_SCREENSHOTS` saves the checked states; no browser-test dependency is needed.
Empty epics say No slices planned without a percentage or bar. Missing people
counts share one muted note; diagnostics stay in stderr, not the unavailable page.
The footer distinguishes excluded private epics from the public fleet counts.
Cron refreshes every five minutes, best effort; the page shows its Pacific update time.
SRE manages the custom domain. Validate with `pwsh -File quality/run.ps1` (Node, Python and actionlint).
