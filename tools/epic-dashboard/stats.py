"""Public-only throughput; absent sources never become zero-valued statistics."""
import math
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from statistics import median
from subprocess import CalledProcessError
from zoneinfo import ZoneInfo

PACIFIC = ZoneInfo("America/Los_Angeles")


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def summarize(source, now):
    now = now.astimezone(timezone.utc)
    result = {}
    unavailable = list(source.get("unavailable", []))

    def missing(name):
        unavailable.append(f"Data unavailable: {name}")

    def series(events, size, hourly=False):
        end = now.replace(minute=0, second=0, microsecond=0) if hourly else now.astimezone(PACIFIC).date()
        step = timedelta(hours=1) if hourly else timedelta(days=1)
        key = lambda t: t.astimezone(PACIFIC).isoformat() if hourly else t.isoformat()
        counts = dict.fromkeys((key(end - i * step) for i in reversed(range(size))), 0)
        for value in events:
            if not value:
                continue
            at = timestamp(value)
            if at > now:
                continue
            at = at.replace(minute=0, second=0, microsecond=0) if hourly else at.astimezone(PACIFIC).date()
            if key(at) in counts:
                counts[key(at)] += 1
        return [{"at": at, "count": count} for at, count in counts.items()]

    counted = "merge_counts" in source  # merge tiles from search counts: no PR paging needed
    for name in ("issue_counts", "closed_issues", "commits", "pulls", "runs", "prsMergedTotal"):
        if name not in source and not (name == "pulls" and counted):
            missing({"issue_counts": "issues", "pulls": "pull requests", "runs": "CI"}.get(name, name))
    if counted:
        counts = source["merge_counts"]
        result["merges"] = dict(counts["rolling"], per_hour=counts["per_hour"])
        result["pull_requests"] = {"opened_per_day": counts["opened_per_day"], "merged_per_day": counts["merged_per_day"]}
        window_start = now - timedelta(days=30)  # the sample is the latest updated merged PRs: keep only those merged in the 30 days
        durations = [(timestamp(p["mergedAt"]) - timestamp(p["createdAt"])).total_seconds() / 3600
                     for p in source.get("merged_sample", []) if p.get("mergedAt") and p.get("createdAt")
                     and window_start <= timestamp(p["mergedAt"]) <= now]
        if not durations:  # the sample read failed or is empty: the full history, when it loaded, gives the same median
            durations = [(timestamp(p["mergedAt"]) - timestamp(p["createdAt"])).total_seconds() / 3600
                         for p in source.get("pulls", []) if p.get("mergedAt") and window_start <= timestamp(p["mergedAt"]) <= now]
        if durations:
            result["pull_requests"]["median_hours_to_merge"] = median(durations)
        else:
            missing("median time to merge")
        if "pulls" not in source:
            missing("builders, review receipts and ready latency (full 30-day PR history not read)")
    if "issue_counts" in source:
        result["issues"] = {"counts": source["issue_counts"]}
    if "prsMergedTotal" in source:
        result["prsMergedTotal"] = source["prsMergedTotal"]
    if "closed_issues" in source and "issues" in result:
        result["issues"]["resolved_per_day"] = series((i["closedAt"] for i in source["closed_issues"]), 14)
    if "commits" in source:
        result["commits"] = {"total": source["commits"]["total"]}
        if source["commits"]["nodes"] is not None:
            result["commits"]["per_day"] = series((c["committedDate"] for c in source["commits"]["nodes"]), 14)
    if "pulls" in source:
        start = now.astimezone(PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=29)
        pulls = source["pulls"]
        merged = [p for p in pulls if p.get("mergedAt") and start <= timestamp(p["mergedAt"]) <= now]
        opened = [p for p in pulls if start <= timestamp(p["createdAt"]) <= now]
        if not counted:
            result["merges"] = {key: sum(now - timedelta(hours=hours) <= timestamp(p["mergedAt"]) <= now for p in merged)
                                for key, hours in (("last_hour", 1), ("last_24_hours", 24), ("last_7_days", 168))}
            result["merges"]["per_hour"] = series((p["mergedAt"] for p in merged), 48, True)
            result["pull_requests"] = {"opened_per_day": series((p["createdAt"] for p in pulls), 30),
                                       "merged_per_day": series((p.get("mergedAt") for p in pulls), 30)}
            durations = [(timestamp(p["mergedAt"]) - timestamp(p["createdAt"])).total_seconds() / 3600 for p in merged]
            if durations:
                result["pull_requests"]["median_hours_to_merge"] = median(durations)
        result["builders"] = dict(Counter(p["author"]["login"] for p in opened if p.get("author")))
        ready, families = [], Counter()
        ready_complete = True
        reviews_complete = all(p.get("headRefOid") for p in merged + opened)
        for pr in {id(p): p for p in merged + opened if p.get("headRefOid")}.values():
            comments = pr.get("comments", {})
            reviews_complete &= bool(comments) and not comments.get("pageInfo", {}).get("hasNextPage", False)
            receipts = set()
            for comment in comments.get("nodes", []):
                if comment.get("authorAssociation") not in ("OWNER", "MEMBER", "COLLABORATOR"):
                    continue
                lines = comment["body"].splitlines()
                if lines and re.fullmatch(r"independent-review(?:-2)?: CLEAN at " + re.escape(pr["headRefOid"]), lines[0]):
                    receipts.update(re.findall(r"^Reviewer: [^\n]+, (Claude|OpenAI)\s*$", comment["body"], re.M))
            families.update(receipts)
        for pr in merged:
            events = pr.get("timelineItems", {})
            ready_complete &= bool(events) and not events.get("pageInfo", {}).get("hasNextPage", False)
            labels = [timestamp(e["createdAt"]) for e in events.get("nodes", [])
                      if (e.get("label") or {}).get("name") == "ready"
                      and timestamp(pr["createdAt"]) <= timestamp(e["createdAt"]) <= timestamp(pr["mergedAt"])]
            if labels:
                ready.append((timestamp(pr["mergedAt"]) - min(labels)).total_seconds() / 3600)
        if ready and ready_complete:
            result["ready_to_merge"] = {"median_hours": median(ready), "p90_hours": sorted(ready)[math.ceil(len(ready) * .9) - 1],
                                        "samples": len(ready)}
        else:
            missing("ready-label history")
        if reviews_complete:
            result["reviewers"] = dict(families)
        else:
            missing("review receipts (incomplete comment history)")
    if "runs" in source:
        durations = [(timestamp(r["updated_at"]) - timestamp(r["run_started_at"])).total_seconds() / 60
                     for r in source["runs"] if r["name"] == "CI" and r["head_branch"] == "main"
                     and r["status"] == "completed" and r.get("run_started_at")
                     and timestamp(r["run_started_at"]) <= timestamp(r["updated_at"]) <= now]
        if durations:
            result["ci"] = {"median_minutes": median(durations), "samples": len(durations)}
        else:
            missing("completed main CI runs")
    if unavailable:
        result["unavailable"] = unavailable
    return result


COMMIT_PAGES = 10  # pages of 100 per repo: a long history cannot starve the other repo's reads of the shared request budget
STAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?")


class PageLimit(ValueError):
    pass


def clean_stamp(value):
    """A timestamp as written by this tool, or None: nothing else may reach the page or the markdown."""
    return value if isinstance(value, str) and len(value) <= 40 and STAMP.fullmatch(value) else None


def plain(value):
    """True for plain JSON of finite numbers: what an earlier roadmap.json can carry without breaking JSON.parse on the page."""
    if isinstance(value, dict):
        return all(isinstance(k, str) and plain(v) for k, v in value.items())
    if isinstance(value, list):
        return all(plain(v) for v in value)
    return value is None or isinstance(value, (str, bool, int)) or (isinstance(value, float) and math.isfinite(value))


def keep_last_good(result, repo, source, previous, previous_at):
    """A failed read keeps the earlier good value, labelled stale and never shown as fresh."""
    earlier = previous.get(repo) if isinstance(previous, dict) else None
    earlier = earlier if isinstance(earlier, dict) else {}
    for key, fields, label in (("commits", ("commits",), "commits"), ("ci", ("runs",), "CI"),
                               ("merges", ("merge_counts", "pulls"), "merge counts"),
                               ("pull_requests", ("merge_counts", "pulls"), "pull request counts")):
        if any(f in source for f in fields) or key in result or not isinstance(earlier.get(key), dict) or not plain(earlier[key]):
            continue
        reason = next((u.split(": ", 2)[-1] for u in source["unavailable"] if u.startswith(f"Data unavailable: {repo} {fields[0]}:")), "read failed")
        result[key] = dict(earlier[key], stale_since=clean_stamp(earlier[key].get("stale_since")) or clean_stamp(previous_at) or "an earlier run")
        result["unavailable"] = [u for u in result.get("unavailable", [])
                                 if u not in (f"Data unavailable: {label}", "Data unavailable: pull requests",
                                              f"Data unavailable: {repo} {fields[0]}: {reason}")]
        result["unavailable"].append(f"Stale: {repo} {label} shows the last good value from {result[key]['stale_since']}; this read failed: {reason}")
    if not result.get("unavailable"):
        result.pop("unavailable", None)
    return result


def collect(run, now=None, budget=60, previous=None, previous_at=None):
    """Share one request budget across both repos; leave room for the epic read.

    Cheap reads that feed the tiles (public check, totals, commits, CI runs) go first for BOTH repos; the long
    pull-request and closed-issue pagination goes last, so it can only starve itself. When the commits or CI read
    fails, `previous` (an earlier collect() result) supplies the last good value, labelled with `previous_at`."""
    now = now or datetime.now(timezone.utc)
    remaining, floor = budget, 0
    output = {}
    start = now.astimezone(PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0)

    def request(endpoint, query=None):
        nonlocal remaining
        if remaining <= floor:
            raise ValueError("request budget exhausted")
        remaining -= 1
        args = ("gh", "api", endpoint) + (("-f", "query=" + query) if query else ())
        data = json.loads(run(*args))
        if isinstance(data, dict) and data.get("errors"):
            raise ValueError("GraphQL read rejected")
        return data

    sources, later = {}, []

    def prepare(repo):
        source = {"unavailable": []}

        def graphql(selection):
            query = '{repository(owner:"danswett",name:' + json.dumps(repo.split("/")[1]) + "){" + selection + "}}"
            data = request("graphql", query)["data"]["repository"]
            if not data or data.get("isPrivate") is not False:
                raise ValueError("repository is not confirmed public")
            return data

        try:
            graphql("isPrivate")
        except (CalledProcessError, ValueError, KeyError, TypeError):
            output[repo] = {"unavailable": [f"Data unavailable: {repo} is not publicly readable"]}
            return

        def pages(selection, path, cutoff=None, limit=None):
            cursor, nodes, count = None, [], 0
            while True:
                data = graphql("isPrivate " + selection.replace("CURSOR", json.dumps(cursor)))
                for key in path:
                    data = data[key]
                nodes.extend(data["nodes"])
                count += 1
                if not data["pageInfo"]["hasNextPage"]:
                    return nodes
                if limit and count >= limit:
                    raise PageLimit(f"commit history is longer than {limit} pages")
                if cutoff and data["nodes"] and timestamp(data["nodes"][-1]["updatedAt"]) < cutoff:
                    return nodes
                next_cursor = data["pageInfo"]["endCursor"]
                if not next_cursor or next_cursor == cursor:
                    raise ValueError("pagination did not advance")
                cursor = next_cursor

        def load(field, reader):
            try:
                source[field] = reader()
            except (CalledProcessError, ValueError, KeyError, TypeError) as error:
                reason = str(error) if isinstance(error, ValueError) else "public API read failed or malformed response"
                source["unavailable"].append(f"Data unavailable: {repo} {field}: {reason}")

        def totals():
            data = graphql("isPrivate open:issues(states:OPEN){totalCount} resolved:issues(states:CLOSED){totalCount}"
                           "merged:pullRequests(states:MERGED){totalCount}")
            source["prsMergedTotal"] = data["merged"]["totalCount"]
            opened, resolved = data["open"]["totalCount"], data["resolved"]["totalCount"]
            return {"total": opened + resolved, "open": opened, "resolved": resolved}

        page_info = "pageInfo{hasNextPage endCursor}"
        load("issue_counts", totals)
        def commits():
            prefix = 'ref(qualifiedName:"refs/heads/main"){target{... on Commit{'
            total = graphql("isPrivate " + prefix + "history(first:0){totalCount}}}}")["ref"]["target"]["history"]["totalCount"]
            window = f'since:"{(start - timedelta(days=13)).isoformat()}",until:"{now.isoformat()}"'
            try:
                nodes = pages(prefix + "history(first:100,after:CURSOR," + window + "){nodes{committedDate}" + page_info + "}}}}",
                              ("ref", "target", "history"), limit=COMMIT_PAGES)
            except PageLimit as error:  # the total is still right; the per-day series would be incomplete, so it is left out and said so
                source["unavailable"].append(f"Data unavailable: {repo} commits per day: {error}")
                return {"total": total, "nodes": None}
            return {"total": total, "nodes": nodes}

        def merge_counts():
            """Merged and opened PR counts from search issueCount aliases: two requests however long the PR history is."""
            span = f"repo:{repo} is:pr "
            stamp = lambda when: when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            end = now.replace(minute=0, second=0, microsecond=0)
            alias = lambda name, query: f'{name}:search(query:"{span}{query}",type:ISSUE){{issueCount}}'
            first, second, hour_keys = [], [], []
            for i in range(48):
                at = end - timedelta(hours=47 - i)
                hour_keys.append(at.astimezone(PACIFIC).isoformat())
                last = min(at + timedelta(hours=1) - timedelta(seconds=1), now)
                first.append(alias(f"h{i:02}", f"is:merged merged:{stamp(at)}..{stamp(last)}"))
            for name, hours in (("r1", 1), ("r24", 24), ("r168", 168)):
                first.append(alias(name, f"is:merged merged:>={stamp(now - timedelta(hours=hours))}"))
            today = now.astimezone(PACIFIC).date()
            days = [today - timedelta(days=29 - i) for i in range(30)]
            for i, day in enumerate(days):
                lo = datetime(day.year, day.month, day.day, tzinfo=PACIFIC)
                nxt = day + timedelta(days=1)  # the next Pacific midnight, so DST days are 23 or 25 hours long
                hi = datetime(nxt.year, nxt.month, nxt.day, tzinfo=PACIFIC).astimezone(timezone.utc) - timedelta(seconds=1)
                window = f"{stamp(lo)}..{stamp(min(hi, now))}"
                second.append(alias(f"m{i:02}", f"is:merged merged:{window}"))
                second.append(alias(f"o{i:02}", f"created:{window}"))
            second.append(alias("u", f"updated:>={stamp(start - timedelta(days=29))}"))  # what the heavy PR read would page through

            def read(aliases):
                data = request("graphql", "query{" + " ".join(aliases) + "}")["data"]
                return {name: data[name]["issueCount"] for name in (a.split(":", 1)[0] for a in aliases)}
            one, two = read(first), read(second)
            for value in (*one.values(), *two.values()):
                if type(value) is not int or value < 0:
                    raise ValueError("merge counts malformed")
            return {"rolling": {"last_hour": one["r1"], "last_24_hours": one["r24"], "last_7_days": one["r168"]},
                    "per_hour": [{"at": key, "count": one[f"h{i:02}"]} for i, key in enumerate(hour_keys)],
                    "merged_per_day": [{"at": day.isoformat(), "count": two[f"m{i:02}"]} for i, day in enumerate(days)],
                    "opened_per_day": [{"at": day.isoformat(), "count": two[f"o{i:02}"]} for i, day in enumerate(days)],
                    "pulls_updated": two["u"]}

        load("merge_counts", merge_counts)  # before the commit paging: two requests, whatever the commit volume
        load("commits", commits)
        load("merged_sample", lambda: graphql("isPrivate pullRequests(first:100,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC})"
                                              "{nodes{createdAt mergedAt}}")["pullRequests"]["nodes"])
        load("runs", lambda: request(f"repos/{repo}/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=100")["workflow_runs"])

        def long_reads():
            load("closed_issues", lambda: pages("issues(first:100,after:CURSOR,states:CLOSED,orderBy:{field:UPDATED_AT,direction:DESC})"
                                              "{nodes{closedAt updatedAt}" + page_info + "}", ("issues",), start - timedelta(days=13)))
            updated = (source.get("merge_counts") or {}).get("pulls_updated")
            needed = -(-updated // 50) if type(updated) is int else 0  # pages of 50; unknown (0) means try it
            if needed > remaining - floor:  # it cannot finish: do not spend what it would burn on a read the page cannot show
                source["unavailable"].append(f"Data unavailable: {repo} pulls: {updated} pull requests updated in 30 days need {needed} requests, "
                                             f"more than the {remaining - floor} left")
                return
            load("pulls", lambda: pages("pullRequests(first:50,after:CURSOR,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{"
                                      "createdAt updatedAt mergedAt headRefOid author{login} comments(first:100){nodes{body authorAssociation}pageInfo{hasNextPage}}"
                                      "timelineItems(first:100,itemTypes:[LABELED_EVENT]){nodes{... on LabeledEvent{createdAt label{name}}}"
                                      "pageInfo{hasNextPage}}}" + page_info + "}", ("pullRequests",), start - timedelta(days=29)))

        sources[repo] = source
        later.append(long_reads)

    repos = ("danswett/agent-bridge", "danswett/slipgates-fleet")
    for repo in repos:
        prepare(repo)
    left = remaining  # the long reads share what is left evenly, so one repo cannot starve the other
    for index, long_reads in enumerate(later):
        floor = left - left * (index + 1) // len(later) if index < len(later) - 1 else 0
        long_reads()
    return {repo: output[repo] if repo in output else keep_last_good(summarize(sources[repo], now), repo, sources[repo],
                                                                      previous, previous_at) for repo in repos}
