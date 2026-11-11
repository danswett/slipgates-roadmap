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
The private slipgates-fleet repository is not included: a plain exclusion line
replaces its numbers and epics. Only confirmed-public source data is published.
The full epics layout, panels and designed look follow in separate slices.
Cron refreshes every five minutes, best effort; the page shows its Pacific update time.
SRE manages the custom domain. Validate with `pwsh -File quality/run.ps1` (Node, Python and actionlint).
