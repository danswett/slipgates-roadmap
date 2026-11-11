# Dashboard statistics

`stats.collect(run)` reads confirmed-public repos only, with one shared 60-request cap.
Missing, private or incomplete sources omit fields with `Data unavailable`; they never become zeros.
Daily buckets use Pacific dates; 48 hourly buckets include this hour, with explicit DST offsets.
PRs/builders/receipt families cover 30 calendar days. Receipts match each PR's exact head.
Ready latency uses the earliest `ready` label, median and nearest-rank p90, with sample count.
CI latency is run-start to update for the latest 100 completed main `ci.yml` runs named `CI`.
