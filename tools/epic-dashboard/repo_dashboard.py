"""Generate #755 and shared JSON from public repository issues, never Project data."""
import argparse
import html
import json
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from stats import collect

R = "danswett/agent-bridge"
PACIFIC = ZoneInfo("America/Los_Angeles")
FIELDS = "number title state labels(first:100){pageInfo{hasNextPage} nodes{name}}"
PAGE = "pageInfo{hasNextPage endCursor} nodes"
ROOT = 'repository(owner:"danswett",name:"agent-bridge")'


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", check=True).stdout


def nodes(query, path):
    pages = json.loads(run("gh", "api", "graphql", "--paginate", "--slurp", "-f", f"query={query}"))
    result = []
    for page in pages:
        if page.get("errors"):
            raise ValueError("GitHub query failed")
        connection = page["data"]
        for key in path:
            connection = connection[key]
        result.extend(connection["nodes"])
    return result


def read():
    epics = nodes(f'query($endCursor:String){{{ROOT}{{issues(first:100,after:$endCursor,'
                  f'labels:["epic"],states:[OPEN,CLOSED]){{{PAGE}{{{FIELDS}}}}}}}}}',
                  ("repository", "issues"))
    for epic in epics:
        epic["children"] = nodes(
            f'query($endCursor:String){{{ROOT}{{issue(number:{epic["number"]}){{'
            f'subIssues(first:100,after:$endCursor){{{PAGE}{{{FIELDS} '
            'closedByPullRequestsReferences(first:100,includeClosedPrs:true){'
            'pageInfo{hasNextPage} nodes{number state mergedAt repository{nameWithOwner}}}}}}}}',
            ("repository", "issue", "subIssues"))
    priority = json.loads(run("gh", "api", f"repos/{R}/issues/696"))["body"]
    return {"epics": epics, "priority_body": priority, "stats": collect(run)}


def generate(snapshot, now=None):
    now = now or datetime.now(PACIFIC)
    order = list(dict.fromkeys(int(n) for row in snapshot["priority_body"].splitlines()
                              if row.startswith("|") for n in re.findall(r"#(\d+)", row.split("|")[2])[:1]))
    def labels(issue):
        if issue["labels"].get("pageInfo", {}).get("hasNextPage"):
            raise ValueError("Incomplete issue labels")
        return {label["name"] for label in issue["labels"]["nodes"]}
    def priority(epic):
        rank = order.index(epic["number"]) if epic["number"] in order else len(order)
        level = min((int(s[-1]) for s in labels(epic) if re.fullmatch(r"priority:P[0-3]", s)), default=4)
        return rank, level, epic["number"]
    rows = []
    for index, epic in enumerate(sorted(snapshot["epics"], key=priority), 1):
        children, prs, buckets = epic["children"], {}, [0] * 24
        for child in children:
            linked = child["closedByPullRequestsReferences"]
            if linked["pageInfo"]["hasNextPage"]:
                raise ValueError("Incomplete linked pull requests")
            for pr in linked["nodes"]:
                if pr.get("repository", {}).get("nameWithOwner", R) == R:
                    prs[pr["number"]] = pr
        for pr in prs.values():
            if pr["mergedAt"]:
                age = (now - datetime.fromisoformat(pr["mergedAt"].replace("Z", "+00:00"))).total_seconds()
                if 0 <= age < timedelta(days=1).total_seconds():
                    buckets[23 - int(age // 3600)] += 1
        closed = sum(child["state"] == "CLOSED" for child in children)
        rows.append(dict(number=epic["number"], title=epic["title"], state=epic["state"],
                         closed=closed, open=len(children) - closed, priority_order=index,
                         open_prs=sum(pr["state"] == "OPEN" for pr in prs.values()),
                         merged_last_24h=sum(buckets), merges_per_hour=buckets,
                         blockers=[c["number"] for c in children
                                   if c["state"] == "OPEN" and "status:blocked" in labels(c)]))
    data = {"epics": rows}
    body = ["# Slipgates: epic dashboard", "",
            f"_Updated {now.astimezone(PACIFIC):%Y-%m-%d %H:%M} PT, generated from epic labels, sub-issues and #696._",
            "", "| Epic | Closed/total | Open PRs | Merged (24 h) | Blockers |", "|---|---|---|---|---|"]
    for row in rows:
        title = re.sub(r"([\\|[\]`*_])", r"\\\1", html.escape(row["title"])).replace("\n", " ")
        blocked = ", ".join(f"#{n}" for n in row["blockers"]) or "-"
        body.append(f'| [{title}](https://github.com/{R}/issues/{row["number"]}) | '
                    f'{row["closed"]}/{row["closed"] + row["open"]} | {row["open_prs"]} | '
                    f'{row["merged_last_24h"]} | {blocked} |')
    if "stats" in snapshot:
        data["stats"] = snapshot["stats"]
        body.extend(["", "## Statistics"])
        for name, stats in data["stats"].items():
            counts = stats.get("issues", {}).get("counts", {})
            body.append(f"**{name}**: {counts.get('resolved', '?')}/{counts.get('total', '?')} issues resolved; "
                        f"{stats.get('merges', {}).get('last_24_hours', '?')} merges (24 h); "
                        f"{stats.get('commits', {}).get('total', '?')} commits on main.")
            body.extend(stats.get("unavailable", []))
    return data, "\n".join(body) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json-output", type=Path, default=Path("dashboard-data.json"))
    parser.add_argument("--body-output", type=Path, default=Path("dashboard.md"))
    parser.add_argument("--write", action="store_true", help="Update only issue #755's body")
    args = parser.parse_args()
    try:
        data, body = generate(read())
    except (subprocess.CalledProcessError, OSError, ValueError, KeyError, TypeError) as error:
        reason = str(error) if isinstance(error, ValueError) else f"Repository read failed ({type(error).__name__})"
        data, body = {"error": reason, "epics": []}, f"# Slipgates: epic dashboard\n\nData unavailable: {reason}\n"
    args.json_output.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    args.body_output.write_text(body, encoding="utf-8")
    if args.write:
        current = json.loads(run("gh", "api", f"repos/{R}/issues/755"))["body"] or ""
        stamp = r"^_Updated [^\n]*$"
        if re.sub(stamp, "", current, flags=re.MULTILINE).strip() != re.sub(stamp, "", body, flags=re.MULTILINE).strip():
            run("gh", "api", "--method", "PATCH", f"repos/{R}/issues/755", "-f", f"body={body}")
    print(f'Data unavailable: {data["error"]}' if "error" in data else f'Generated {len(data["epics"])} epics.')


if __name__ == "__main__":
    main()
