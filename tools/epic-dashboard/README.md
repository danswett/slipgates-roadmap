`stats.collect(run)` reads confirmed-public repos only, with one shared 60-request cap. Cheap reads (totals, commits, CI runs) go first for
both repos; pull-request and closed-issue pagination goes last, so it can only starve itself. `--previous roadmap.json` supplies the last good
commits and CI values when a read fails; they carry `stale_since` and the page text says `Stale: ... last good value from <time>`.
Missing, private or incomplete sources omit fields with `Data unavailable`; they never become zeros.
Daily buckets use Pacific dates; 48 hourly buckets include this hour, with explicit DST offsets.
PRs/builders/receipt families cover 30 calendar days. Receipts match each PR's exact head.
Only receipts with authorAssociation OWNER, MEMBER or COLLABORATOR count; missing or other values do not.
Ready latency uses the earliest `ready` label, median and nearest-rank p90, with sample count.
CI latency is run-start to update for the latest 100 completed main `ci.yml` runs named `CI`.
Merge tiles (per hour, per day, rolling 1 h/24 h/7 d, opened per day) come from GraphQL search `issueCount` aliases, two requests per repo however
long the PR history is; median time to merge is from one light page of the latest 100 merged PRs (a sample, not all 30 days). Builders, review
receipts and ready latency still need the full 30-day PR history, read last with what budget is left; if it is cut short only those are
`Data unavailable`, never the merge tiles. A failed merge-count read keeps the last good value (`--previous`), labelled stale.
