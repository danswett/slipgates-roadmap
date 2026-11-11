# slipgates-roadmap
Slipgates roadmap: epic progress, published to roadmap.slipgates.com

`python tools/epic-dashboard/repo_dashboard.py` writes `dashboard.md` and `dashboard-data.json`;
`--write` updates only agent-bridge #755's body, ignoring timestamp-only changes.
Uses public epic labels, sub-issues, linked PRs and #696 order, then priority labels,
through the caller's repository credential in `gh`; no Project access or new secret.
Read errors yield visible `Data unavailable` and JSON `error`, exit 0; write errors fail.
Run `python -m unittest discover -s tools/epic-dashboard -v`; Windows Python needs `tzdata`.

R1 publishes a static Data unavailable scaffold; generator hookup and panels follow.
Cron refreshes every five minutes, best effort; the page shows its Pacific update time.
The custom domain and CNAME file wait for DNS. Validate with `pwsh -File quality/run.ps1` (Node, Python and actionlint).
