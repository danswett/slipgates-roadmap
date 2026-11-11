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

    for name in ("issue_counts", "closed_issues", "commits", "pulls", "runs"):
        if name not in source:
            missing({"issue_counts": "issues", "pulls": "pull requests", "runs": "CI"}.get(name, name))
    if "issue_counts" in source:
        result["issues"] = {"counts": source["issue_counts"]}
    if "closed_issues" in source and "issues" in result:
        result["issues"]["resolved_per_day"] = series((i["closedAt"] for i in source["closed_issues"]), 14)
    if "commits" in source:
        result["commits"] = {"total": source["commits"]["total"],
                             "per_day": series((c["committedDate"] for c in source["commits"]["nodes"]), 14)}
    if "pulls" in source:
        start = now.astimezone(PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=29)
        pulls = source["pulls"]
        merged = [p for p in pulls if p.get("mergedAt") and start <= timestamp(p["mergedAt"]) <= now]
        opened = [p for p in pulls if start <= timestamp(p["createdAt"]) <= now]
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


def collect(run, now=None, budget=60):
    """Share one request budget across both repos; leave room for the epic read."""
    now = now or datetime.now(timezone.utc)
    remaining = budget
    output = {}
    start = now.astimezone(PACIFIC).replace(hour=0, minute=0, second=0, microsecond=0)

    def request(endpoint, query=None):
        nonlocal remaining
        if remaining <= 0:
            raise ValueError("request budget exhausted")
        remaining -= 1
        args = ("gh", "api", endpoint) + (("-f", "query=" + query) if query else ())
        data = json.loads(run(*args))
        if isinstance(data, dict) and data.get("errors"):
            raise ValueError("GraphQL read rejected")
        return data

    for repo in ("danswett/agent-bridge", "danswett/slipgates-fleet"):
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
            continue

        def pages(selection, path, cutoff=None):
            cursor, nodes = None, []
            while True:
                data = graphql("isPrivate " + selection.replace("CURSOR", json.dumps(cursor)))
                for key in path:
                    data = data[key]
                nodes.extend(data["nodes"])
                if not data["pageInfo"]["hasNextPage"]:
                    return nodes
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
            data = graphql("isPrivate open:issues(states:OPEN){totalCount} resolved:issues(states:CLOSED){totalCount}")
            opened, resolved = data["open"]["totalCount"], data["resolved"]["totalCount"]
            return {"total": opened + resolved, "open": opened, "resolved": resolved}

        page_info = "pageInfo{hasNextPage endCursor}"
        load("issue_counts", totals)
        load("closed_issues", lambda: pages("issues(first:100,after:CURSOR,states:CLOSED,orderBy:{field:UPDATED_AT,direction:DESC})"
                                          "{nodes{closedAt updatedAt}" + page_info + "}", ("issues",), start - timedelta(days=13)))
        load("pulls", lambda: pages("pullRequests(first:50,after:CURSOR,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{"
                                  "createdAt updatedAt mergedAt headRefOid author{login} comments(first:100){nodes{body}pageInfo{hasNextPage}}"
                                  "timelineItems(first:100,itemTypes:[LABELED_EVENT]){nodes{... on LabeledEvent{createdAt label{name}}}"
                                  "pageInfo{hasNextPage}}}" + page_info + "}", ("pullRequests",), start - timedelta(days=29)))

        def commits():
            prefix = 'ref(qualifiedName:"refs/heads/main"){target{... on Commit{'
            total = graphql("isPrivate " + prefix + "history(first:0){totalCount}}}}")["ref"]["target"]["history"]["totalCount"]
            window = f'since:"{(start - timedelta(days=13)).isoformat()}",until:"{now.isoformat()}"'
            nodes = pages(prefix + "history(first:100,after:CURSOR," + window + "){nodes{committedDate}" + page_info + "}}}}",
                          ("ref", "target", "history"))
            return {"total": total, "nodes": nodes}

        load("commits", commits)
        load("runs", lambda: request(f"repos/{repo}/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=100")["workflow_runs"])
        output[repo] = summarize(source, now)
    return output
