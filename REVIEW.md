# Review and merge rule

This repo holds the epic dashboard generator and the roadmap page. It has no
secrets and reads only public issue data, so the rule is lighter than
agent-bridge. There is no sensitive-path list.

## Who reviews what

| Change | Independent review |
| --- | --- |
| Generator code, page code, tests, docs (everything not listed below) | One family: a Claude reviewer, who is not the builder |
| The Pages deploy workflow and any other file under `.github/workflows/` | Two families: Claude and OpenAI, both CLEAN |

A change that touches both kinds counts as the deploy workflow case.

## Receipts

- A receipt is a PR comment whose first line is `independent-review: CLEAN at <full sha>`
  (`independent-review-2` for the second family), then `Reviewer: <name>, <model>, <family>`.
- It counts only on the exact head. A new push voids every receipt.
- A NOT CLEAN gets one correction push after all required families have read.

## Merging

- Draft until the receipts are in. Only Quality marks ready and merges.
- Merge with `gh pr merge <n> --squash --match-head-commit <full sha>`.
  Auto-merge is not used here.
- Deploy workflow design points: the build job holds no token, the data job is
  separate with `continue-on-error`, deploys never use `cancel-in-progress`,
  and a keepalive job stops scheduled runs from lapsing after 60 idle days.
- SRE owns the Pages settings and the main ruleset. When a CI job exists, Quality
  asks SRE to add it as a required check.
