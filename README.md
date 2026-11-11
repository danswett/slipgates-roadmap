# slipgates-roadmap
Slipgates roadmap: epic progress, published to roadmap.slipgates.com

`python tools/repo_dashboard.py` writes `dashboard.md` and `dashboard-data.json`;
`--write` updates only agent-bridge #755's body, ignoring timestamp-only changes.
Uses public epic labels, sub-issues, linked PRs and #696 order, then priority labels,
through the caller's repository credential in `gh`; no Project access or new secret.
Read errors yield visible `Data unavailable` and JSON `error`, exit 0; write errors fail.
Run `python -m unittest discover -s tools -v`; Windows Python needs `tzdata`.
