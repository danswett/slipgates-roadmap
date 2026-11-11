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
FIELDS = ("number title state body repository{nameWithOwner} labels(first:100){pageInfo{hasNextPage} nodes{name}} "
          "blockedBy(first:100){pageInfo{hasNextPage} nodes{number title repository{nameWithOwner}}}")
PAGE = "pageInfo{hasNextPage endCursor} nodes"
ROOT = 'repository(owner:"danswett",name:"agent-bridge")'
REFERENCE = re.compile(r"(?:(?:https://github\.com/)?([\w.-]+/[\w.-]+)(?:/issues/|#)|#)(\d+)")
ROLES = {"Engineering", "Quality", "Product", "SRE", "Creative", "Migration", "Owner"}


def body_blockers(issue):
    result = {}
    for line in re.findall(r"(?im)^\s*Blocked by[ \t]+(.+)$", issue.get("body") or ""):
        refs = list(REFERENCE.finditer(line))
        reason = line[refs[-1].end():].strip(" \t\r:;,.-")[:80] if refs else ""
        for ref in refs:
            result.setdefault((ref[1] or R, int(ref[2])), reason)
    return result


def owner_role(issue):
    match = re.search(r"(?im)^\s*Clears it:[ \t]*([^\r\n]+)", issue.get("body") or "")
    role = match[1].strip() if match else ""
    return role if role in ROLES else "Unassigned"


def public_epics(epics):
    return [dict(epic, children=[c for c in epic["children"]
                                if c.get("repository", {}).get("nameWithOwner", R) == R])
            for epic in epics]


def blocker_details(issue, titles, labels):
    if issue["state"] != "OPEN":
        return []
    relation = issue.get("blockedBy", {"nodes": []})
    if relation.get("pageInfo", {}).get("hasNextPage"):
        raise ValueError("Incomplete blocker relations")
    declared = body_blockers(issue)
    sources = [(b["repository"]["nameWithOwner"], b["number"], b["title"]) for b in relation["nodes"]]
    if not sources:
        sources = [(repo, number, titles[str(number)] if repo == R else "private item")
                   for repo, number in declared]
    result = []
    for repo, number, title in sources:
        public = repo == R
        result.append(dict(number=number, title=title if public else "private item",
                           reason=(declared.get((repo, number)) or title)[:80] if public else "private item",
                           clearsIt=owner_role(issue)))
    if not result and labels & {"blocked", "status:blocked"}:
        result.append(dict(number=None, title="No blocker recorded", reason="No blocker recorded",
                           clearsIt=owner_role(issue)))
    return result


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
    epics = public_epics(epics)
    issues = [issue for epic in epics for issue in [epic, *epic["children"]]]
    titles = {str(issue["number"]): issue["title"] for issue in issues
              if issue.get("repository", {}).get("nameWithOwner", R) == R and "title" in issue}
    for issue in issues:
        if issue["state"] == "OPEN" and not issue["blockedBy"]["nodes"]:
            for repo, number in body_blockers(issue):
                if repo == R and str(number) not in titles:
                    titles[str(number)] = json.loads(run("gh", "api", f"repos/{R}/issues/{number}"))["title"]
    return {"epics": epics, "priority_body": priority, "blocker_titles": titles, "stats": collect(run)}


def generate(snapshot, now=None):
    epics = public_epics(snapshot["epics"])
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
    rows, needs_blocker = [], []
    for index, epic in enumerate(sorted(epics, key=priority), 1):
        children, prs, buckets = epic["children"], {}, [0] * 24
        details = blocker_details(epic, snapshot.get("blocker_titles", {}), labels(epic))
        blocked_children = []
        for child in children:
            blockers = blocker_details(child, snapshot.get("blocker_titles", {}), labels(child))
            if blockers:
                item = dict(number=child["number"], title=child.get("title", ""),
                            blockers=blockers, clearsIt=owner_role(child))
                blocked_children.append(item)
                details.extend(b for b in blockers if b not in details)
                if blockers[0]["number"] is None:
                    needs_blocker.append(dict(epic=epic["number"], number=item["number"],
                                              title=item["title"], clearsIt=item["clearsIt"]))
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
                         blockers=[c["number"] for c in blocked_children], blocked=bool(details),
                         blockerDetails=details, blockedChildren=blocked_children))
    data = {"epics": rows, "needsBlocker": needs_blocker}
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
