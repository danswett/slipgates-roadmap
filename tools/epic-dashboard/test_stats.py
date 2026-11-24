import unittest
import json
from datetime import datetime, timedelta, timezone
from subprocess import CalledProcessError
from stats import collect, summarize


NOW = datetime(2026, 11, 11, 5, 30, tzinfo=timezone.utc)
SHA = "a" * 40


def ago(hours):
    return (NOW - timedelta(hours=hours)).isoformat()


def fixture():
    return {
        "prsMergedTotal": 3,
        "issue_counts": {"total": 10, "open": 4, "resolved": 6},
        "closed_issues": [{"closedAt": ago(1)}, {"closedAt": ago(48)}],
        "pulls": [{
            "createdAt": ago(hours + 24), "mergedAt": ago(hours), "headRefOid": SHA,
            "author": {"login": "bob" if i == 2 else "alice"},
            "timelineItems": {"nodes": [{"createdAt": ago(hours + [2, 4, 12][i]), "label": {"name": "ready"}}]},
            "comments": {"nodes": [{"body": f"independent-review: CLEAN at {SHA}\nReviewer: Public reviewer, model, Claude",
                                     "authorAssociation": "OWNER"}]},
        } for i, hours in enumerate([1, 3, 10])],
        "commits": {"total": 1234, "nodes": [{"committedDate": ago(1)}, {"committedDate": ago(48)}]},
        "runs": [{"name": "CI", "head_branch": "main", "status": "completed",
                  "run_started_at": ago(minutes / 60), "updated_at": ago(0)} for minutes in [10, 20, 90]],
    }


class ThroughputTests(unittest.TestCase):
    def test_generator_preserves_epics_and_adds_statistics_to_both_outputs(self):
        import repo_dashboard
        snapshot = {"epics": [], "priority_body": "", "stats": {"danswett/agent-bridge": summarize(fixture(), NOW)}}
        data, body = repo_dashboard.generate(snapshot, NOW)
        self.assertEqual(set(data), {"epics", "stats", "needsBlocker"})
        self.assertEqual(data["stats"], snapshot["stats"])
        self.assertEqual(data["epics"], [])
        self.assertIn("1234", body)

    def test_fixture_counts_series_and_percentiles(self):
        data = summarize(fixture(), NOW)
        self.assertEqual(data["issues"]["counts"], {"total": 10, "open": 4, "resolved": 6})
        self.assertEqual(len(data["issues"]["resolved_per_day"]), 14)
        self.assertEqual(data["issues"]["resolved_per_day"][-1], {"at": "2026-11-10", "count": 1})
        self.assertEqual(len(data["merges"]["per_hour"]), 48)
        self.assertEqual([data["merges"][key] for key in ["last_hour", "last_24_hours", "last_7_days"]], [1, 3, 3])
        self.assertEqual(data["commits"]["total"], 1234)
        self.assertEqual(data["prsMergedTotal"], 3)
        self.assertEqual(sum(bucket["count"] for bucket in data["commits"]["per_day"]), 2)
        self.assertEqual(len(data["pull_requests"]["opened_per_day"]), 30)
        self.assertEqual(data["pull_requests"]["median_hours_to_merge"], 24)
        self.assertEqual(data["ready_to_merge"], {"median_hours": 4, "p90_hours": 12, "samples": 3})
        self.assertEqual(data["ci"]["median_minutes"], 20)
        self.assertEqual(data["builders"], {"alice": 2, "bob": 1})
        self.assertEqual(data["reviewers"], {"Claude": 3})

    def test_missing_sources_omit_fields_instead_of_zero(self):
        data = summarize({}, NOW)
        self.assertEqual(set(data), {"unavailable"})
        self.assertIn("Data unavailable: issues", "\n".join(data["unavailable"]))
        source = fixture()
        for pr in source["pulls"]:
            pr["timelineItems"]["nodes"] = []
        self.assertNotIn("ready_to_merge", summarize(source, NOW))

    def test_empty_and_out_of_window_events(self):
        source = fixture()
        source["pulls"] = [{"createdAt": ago(800), "mergedAt": ago(800)},
                           {"createdAt": ago(-1), "mergedAt": ago(-1)}]
        data = summarize(source, NOW)
        self.assertEqual(data["merges"]["last_7_days"], 0)
        self.assertEqual(sum(bucket["count"] for bucket in data["pull_requests"]["opened_per_day"]), 0)
        source["pulls"] = []
        self.assertEqual(summarize(source, NOW)["builders"], {})

    def test_receipts_are_exact_head_deduplicated_and_public_safe(self):
        source = fixture()
        pr = source["pulls"][0]
        pr["comments"]["nodes"] *= 2
        pr["comments"]["nodes"].append({"body": f"independent-review-2: CLEAN at {SHA}\nReviewer: Private session, model, OpenAI",
                                       "authorAssociation": "COLLABORATOR"})
        source["pulls"] = [pr, dict(pr, headRefOid="b" * 40)]
        data = summarize(source, NOW)
        self.assertEqual(data["reviewers"], {"Claude": 1, "OpenAI": 1})
        self.assertNotIn("Private session", str(data))

    def test_receipts_count_only_trusted_author_associations(self):
        for association in ("OWNER", "MEMBER", "COLLABORATOR", "NONE",
                            "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR", None, "owner"):
            with self.subTest(authorAssociation=association):
                source = fixture()
                pr = source["pulls"][0]
                pr["comments"]["nodes"] = [
                    {"body": f"independent-review{suffix}: CLEAN at {SHA}\nReviewer: Public reviewer, model, {family}",
                     "authorAssociation": association}
                    for suffix, family in (("", "Claude"), ("-2", "OpenAI"))
                ]
                source["pulls"] = [pr]
                expected = {"Claude": 1, "OpenAI": 1} if association in ("OWNER", "MEMBER", "COLLABORATOR") else {}
                self.assertEqual(summarize(source, NOW)["reviewers"], expected)

    def test_receipt_without_author_association_does_not_count(self):
        source = fixture()
        for pr in source["pulls"]:
            del pr["comments"]["nodes"][0]["authorAssociation"]
        self.assertEqual(summarize(source, NOW)["reviewers"], {})

    def test_incomplete_nested_sources_are_not_zero_counts(self):
        source = fixture()
        source["pulls"][0]["comments"]["pageInfo"] = {"hasNextPage": True}
        source["pulls"][0]["timelineItems"]["pageInfo"] = {"hasNextPage": True}
        data = summarize(source, NOW)
        self.assertNotIn("reviewers", data)
        self.assertNotIn("ready_to_merge", data)
        source["pulls"][0]["headRefOid"] = None
        self.assertNotIn("reviewers", summarize(source, NOW))

    def test_pacific_fall_back_preserves_both_one_am_hours(self):
        now = datetime.fromisoformat("2026-11-01T02:30:00-08:00")
        source = fixture()
        source["pulls"] = [{"createdAt": "2026-10-31T12:00:00Z", "mergedAt": at}
                           for at in ["2026-11-01T08:15:00Z", "2026-11-01T09:15:00Z"]]
        hours = summarize(source, now)["merges"]["per_hour"]
        counts = {b["at"]: b["count"] for b in hours}
        self.assertEqual(counts["2026-11-01T01:00:00-07:00"], 1)
        self.assertEqual(counts["2026-11-01T01:00:00-08:00"], 1)

    def test_paginated_public_collection_and_shared_request_budget(self):
        calls = []

        def run(*args):
            calls.append(args)
            if args[2] != "graphql":
                return json.dumps({"workflow_runs": fixture()["runs"]})
            query = args[-1]
            page = {"hasNextPage": False, "endCursor": None}
            if "open:issues" in query:
                data = {"open": {"totalCount": 4}, "resolved": {"totalCount": 6}}
                pulls = fixture()["pulls"] + [{"createdAt": ago(900), "mergedAt": ago(800)}]
                pulls.extend({"createdAt": ago(2), "mergedAt": None, "state": state}
                             for state in ("CLOSED", "OPEN"))
                if "merged:pullRequests(states:MERGED)" in query:
                    data["merged"] = {"totalCount": sum(bool(p["mergedAt"]) for p in pulls)}
            elif "issues(first" in query:
                second = 'after:"next"' in query
                data = {"issues": {"nodes": [{"closedAt": ago(400 if second else 1), "updatedAt": ago(400 if second else 1)}],
                                   "pageInfo": {"hasNextPage": True, "endCursor": "last" if second else "next"}}}
            elif "states:MERGED,orderBy" in query:
                data = {"pullRequests": {"nodes": [{"createdAt": ago(30), "mergedAt": ago(6)}], "pageInfo": page}}
            elif "search(" in query:
                raise ValueError("search not available in this fixture")  # the old full-history path still works
            elif "pullRequests(first" in query:
                self.assertIn("authorAssociation", query)
                data = {"pullRequests": {"nodes": fixture()["pulls"], "pageInfo": page}}
            elif "history(first:0)" in query:
                data = {"ref": {"target": {"history": {"totalCount": 1234}}}}
            else:
                data = {"ref": {"target": {"history": {"nodes": fixture()["commits"]["nodes"], "pageInfo": page}}}}
            return json.dumps({"data": {"repository": dict(data, isPrivate=True if private else False)}})

        private = False
        data = collect(run, NOW, budget=20)
        self.assertEqual(len(calls), 20)
        self.assertEqual(data["danswett/agent-bridge"]["commits"]["total"], 1234)
        self.assertEqual(data["danswett/agent-bridge"]["prsMergedTotal"], 4)
        self.assertEqual(data["danswett/agent-bridge"]["merges"]["last_24_hours"], 3)
        self.assertEqual(data["danswett/slipgates-fleet"]["issues"]["counts"]["total"], 10)
        calls.clear()
        self.assertIn("unavailable", collect(run, NOW, budget=1)["danswett/slipgates-fleet"])
        self.assertEqual(len(calls), 1)
        private = True
        calls.clear()
        self.assertNotIn("issues", collect(run, NOW)["danswett/agent-bridge"])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(args[2] == "graphql" and "open:issues" not in args[-1] for args in calls))


class CheapReadsFirstAndLastGoodTests(unittest.TestCase):
    def stub(self, fail=(), endless=True):
        calls = []

        def run(*args):
            calls.append(args)
            if args[2] != "graphql":
                if "runs" in fail:
                    raise CalledProcessError(1, "gh")
                return json.dumps({"workflow_runs": fixture()["runs"]})
            query = args[-1]
            repo = {"isPrivate": False}
            if "repository(" in query and "isPrivate" not in query:  # the real API answers nothing the page may trust without it
                return json.dumps({"data": {"repository": {}}})
            if "search(" in query:  # merge counts: one GraphQL request of issueCount aliases, no PR paging
                import re
                known = {"r1": 1, "r24": 5, "r168": 20}
                return json.dumps({"data": {name: {"issueCount": known.get(name, 2 if name[0] == "h" else 3 if name[0] == "m" else 4)}
                                            for name in re.findall(r"(\w+):search\(", query)}})
            if "states:MERGED,orderBy" in query:  # the light sample of the latest merged PRs
                repo["pullRequests"] = {"nodes": [{"createdAt": ago(30), "mergedAt": ago(6)}] * 100,
                                        "pageInfo": {"hasNextPage": True, "endCursor": "x"}}
            elif "open:issues" in query:
                repo.update(open={"totalCount": 4}, resolved={"totalCount": 6}, merged={"totalCount": 3})
            elif "pullRequests(first" in query and endless:  # a long history: every page has another page
                n = sum("pullRequests(first" in c[-1] for c in calls)
                repo["pullRequests"] = {"nodes": [{"createdAt": ago(1), "updatedAt": ago(1), "mergedAt": None}],
                                        "pageInfo": {"hasNextPage": True, "endCursor": f"c{n}"}}
            elif "issues(first" in query:
                repo["issues"] = {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}}
            elif "pullRequests(first" in query:
                repo["pullRequests"] = {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}}
            elif "history(first:0)" in query:
                if "commits" in fail:
                    raise CalledProcessError(1, "gh")
                repo["ref"] = {"target": {"history": {"totalCount": 1234}}}
            elif "history(first:100" in query:
                repo["ref"] = {"target": {"history": {"nodes": fixture()["commits"]["nodes"],
                                                      "pageInfo": {"hasNextPage": False, "endCursor": None}}}}
            return json.dumps({"data": {"repository": repo}})
        return run, calls

    def test_endless_pull_history_cannot_starve_commits_and_ci_of_either_repo(self):
        run, calls = self.stub()
        data = collect(run, NOW)  # the real 60-request budget
        self.assertEqual(len(calls), 60)
        for repo in ("danswett/agent-bridge", "danswett/slipgates-fleet"):
            self.assertEqual(data[repo]["commits"]["total"], 1234, repo)
            self.assertIn("median_minutes", data[repo]["ci"], repo)
            self.assertTrue(any("pulls" in u and "request budget exhausted" in u for u in data[repo]["unavailable"]), repo)
            self.assertIn("resolved_per_day", data[repo]["issues"], repo)  # the other long read still ran in each repo

    def test_every_tile_has_data_within_the_budget_even_with_endless_pull_history(self):
        """Regression (roadmap, 2026-11-23): PR paging starved the merge tiles. Merge counts now come from search counts and a
        light sample, so every tile has data in BOTH repos inside the 60-request budget however long the PR history is."""
        run, calls = self.stub()
        data = collect(run, NOW)
        self.assertLessEqual(len(calls), 60)
        for repo in ("danswett/agent-bridge", "danswett/slipgates-fleet"):
            stats = data[repo]
            self.assertEqual(len(stats["merges"]["per_hour"]), 48, repo)
            self.assertEqual(stats["merges"]["per_hour"][-1]["count"], 2)
            self.assertEqual([stats["merges"][k] for k in ("last_hour", "last_24_hours", "last_7_days")], [1, 5, 20], repo)
            self.assertEqual(len(stats["pull_requests"]["merged_per_day"]), 30, repo)
            self.assertEqual(len(stats["pull_requests"]["opened_per_day"]), 30, repo)
            self.assertEqual(stats["pull_requests"]["merged_per_day"][-1]["count"], 3)
            self.assertEqual(stats["pull_requests"]["median_hours_to_merge"], 24, repo)
            self.assertEqual(stats["commits"]["total"], 1234, repo)
            self.assertIn("median_minutes", stats["ci"], repo)
            self.assertEqual(stats["issues"]["counts"]["total"], 10, repo)
            text = " | ".join(stats["unavailable"])
            self.assertIn("pulls: request budget exhausted", text)  # only the heavy extras are missing
            self.assertNotIn("Data unavailable: pull requests", text)
            self.assertNotIn("builders", stats)

    def test_median_ignores_old_merges_in_the_sample_and_falls_back_to_the_full_history(self):
        source = fixture()
        source["merge_counts"] = {"rolling": {"last_hour": 0, "last_24_hours": 0, "last_7_days": 0}, "per_hour": [],
                                  "merged_per_day": [], "opened_per_day": []}
        source["merged_sample"] = [{"createdAt": ago(1000), "mergedAt": ago(40 * 24)},  # touched this week, merged 40 days ago
                                   {"createdAt": ago(30), "mergedAt": ago(6)}]
        self.assertEqual(summarize(source, NOW)["pull_requests"]["median_hours_to_merge"], 24)
        del source["merged_sample"]  # the sample read failed, but the full history loaded
        self.assertEqual(summarize(source, NOW)["pull_requests"]["median_hours_to_merge"], 24)
        del source["pulls"]
        self.assertIn("Data unavailable: median time to merge", summarize(source, NOW)["unavailable"])

    def test_a_failed_search_read_keeps_the_last_good_merge_tiles_and_says_so(self):
        run, _ = self.stub()
        earlier = collect(run, NOW)

        def broken(*args):
            if "search(" in args[-1]:
                raise CalledProcessError(1, "gh")
            return run(*args)
        data = collect(broken, NOW, previous=earlier, previous_at="2026-11-11T05:00:00+00:00")
        repo = data["danswett/agent-bridge"]
        self.assertEqual(len(repo["merges"]["per_hour"]), 48)
        self.assertEqual(repo["merges"]["stale_since"], "2026-11-11T05:00:00+00:00")
        self.assertEqual(repo["pull_requests"]["stale_since"], "2026-11-11T05:00:00+00:00")
        self.assertIn("Stale: danswett/agent-bridge merge counts", " | ".join(repo["unavailable"]))

    def test_failed_commits_and_ci_reads_keep_the_last_good_value_and_say_so(self):
        run, _ = self.stub()
        earlier = collect(run, NOW)
        run, _ = self.stub(fail=("commits", "runs"))
        data = collect(run, NOW, previous=earlier, previous_at="2026-11-11T05:00:00+00:00")
        repo = data["danswett/agent-bridge"]
        self.assertEqual(repo["commits"]["total"], 1234)
        self.assertEqual(repo["commits"]["stale_since"], "2026-11-11T05:00:00+00:00")
        self.assertEqual(repo["ci"]["stale_since"], "2026-11-11T05:00:00+00:00")
        notes = " | ".join(repo["unavailable"])
        self.assertIn("Stale: danswett/agent-bridge commits shows the last good value from 2026-11-11T05:00:00+00:00", notes)
        self.assertNotIn("Data unavailable: commits", notes)
        again = collect(run, NOW, previous=data, previous_at="2026-11-11T05:05:00+00:00")  # still failing: original time kept
        self.assertEqual(again["danswett/agent-bridge"]["commits"]["stale_since"], "2026-11-11T05:00:00+00:00")
        self.assertIn("last good value from 2026-11-11T05:00:00+00:00", " | ".join(again["danswett/agent-bridge"]["unavailable"]))

    def test_malformed_previous_is_ignored_not_fatal(self):
        run, _ = self.stub(fail=("commits",))
        for bad in ([1], {"danswett/agent-bridge": "x"}, {"danswett/agent-bridge": {"commits": "x", "ci": 3}}):
            data = collect(run, NOW, previous=bad, previous_at="t")
            self.assertNotIn("commits", data["danswett/agent-bridge"])

    def test_no_earlier_value_stays_unavailable_never_zero_and_fresh_read_is_not_marked_stale(self):
        run, _ = self.stub(fail=("commits",))
        data = collect(run, NOW)
        self.assertNotIn("commits", data["danswett/agent-bridge"])
        self.assertIn("Data unavailable: commits", data["danswett/agent-bridge"]["unavailable"])
        run, _ = self.stub()
        fresh = collect(run, NOW, previous=data, previous_at="x")
        self.assertNotIn("stale_since", fresh["danswett/agent-bridge"]["commits"])


class SearchWindowAndBudgetTests(unittest.TestCase):
    """Roadmap #41 (review notes on #40): pin the search windows and fields, run the merge counts before the commit
    paging, and do not spend the budget on a PR read that cannot finish."""

    def search_run(self, counts=None, endless_commits=False):
        """The cheap-reads stub with its search answers replaced: h{i} is i, m{i} is 100 + i, o{i} is 200 + i."""
        import re
        inner, calls = CheapReadsFirstAndLastGoodTests.stub(None)
        searches = []

        def run(*args):
            query = args[-1]
            if "search(" in query:
                searches.append(query)
                def value(name):
                    if counts and name in counts:
                        return counts[name]
                    base = {"h": 0, "m": 100, "o": 200}
                    return base[name[0]] + int(name[1:]) if name[0] in base and name[1:].isdigit() else {"r1": 1, "r24": 5, "r168": 20}.get(name, 4)
                calls.append(args)
                return json.dumps({"data": {name: {"issueCount": value(name)} for name in re.findall(r"(\w+):search\(", query)}})
            if endless_commits and "history(first:100" in query:
                calls.append(args)
                page = {"hasNextPage": True, "endCursor": f"k{len(calls)}"}
                return json.dumps({"data": {"repository": {"isPrivate": False, "ref": {"target": {"history": {
                    "nodes": [{"committedDate": ago(1)}], "pageInfo": page}}}}}})
            return inner(*args)
        return run, calls, searches

    def queries(self, now):
        run, _, searches = self.search_run()
        data = collect(run, now)
        import re
        found = {}
        for text in searches[:2]:  # the first repo's two search requests
            for name, query in re.findall(r'(\w+):search\(query:"([^"]*)"', text):
                found[name] = query
        return data["danswett/agent-bridge"], found

    def test_day_windows_follow_the_pacific_midnights_including_the_25_and_23_hour_days(self):
        _, fall = self.queries(datetime(2026, 11, 2, 20, tzinfo=timezone.utc))
        self.assertIn("is:merged merged:2026-11-01T07:00:00Z..2026-11-02T07:59:59Z", [q.split("is:pr ", 1)[1] for q in fall.values()])
        _, spring = self.queries(datetime(2026, 3, 10, 20, tzinfo=timezone.utc))
        self.assertIn("created:2026-03-08T08:00:00Z..2026-03-09T06:59:59Z", [q.split("is:pr ", 1)[1] for q in spring.values()])

    def test_day_and_hour_buckets_are_contiguous_so_a_boundary_second_is_in_exactly_one(self):
        import re
        _, found = self.queries(NOW)
        for prefix, pattern in (("m", r"merged:(\S+)\.\.(\S+)$"), ("h", r"merged:(\S+)\.\.(\S+)$")):
            spans = [re.search(pattern, found[name]).groups() for name in sorted(n for n in found if n[0] == prefix and n[1:].isdigit())]
            parse = lambda value: datetime.fromisoformat(value.replace("Z", "+00:00"))
            for (_, high), (low, _) in zip(spans, spans[1:]):
                self.assertEqual(parse(high) + timedelta(seconds=1), parse(low), prefix)
        self.assertTrue(found["h47"].endswith("2026-11-11T05:00:00Z..2026-11-11T05:30:00Z"))  # the last hour stops at now
        self.assertTrue(found["m29"].endswith("..2026-11-11T05:30:00Z"))  # today stops at now

    def test_merged_and_opened_use_their_own_fields_and_the_rolling_windows_are_exact(self):
        data, found = self.queries(NOW)
        for name, query in found.items():
            if name[0] == "m" and name[1:].isdigit():
                self.assertIn("is:merged merged:", query)
                self.assertNotIn("created:", query)
            if name[0] == "o":
                self.assertIn(" created:", query)
                self.assertNotIn("is:merged", query)
        self.assertEqual([d["count"] for d in data["pull_requests"]["merged_per_day"]], [100 + i for i in range(30)])
        self.assertEqual([d["count"] for d in data["pull_requests"]["opened_per_day"]], [200 + i for i in range(30)])
        for name, stamp in (("r1", "2026-11-11T04:30:00Z"), ("r24", "2026-11-10T05:30:00Z"), ("r168", "2026-11-04T05:30:00Z")):
            self.assertTrue(found[name].endswith(f"is:merged merged:>={stamp}"), name)

    def test_the_hourly_series_is_oldest_first_and_ends_at_the_current_hour(self):
        data, _ = self.queries(NOW)
        hours = data["merges"]["per_hour"]
        self.assertEqual([h["count"] for h in hours], list(range(48)))
        self.assertEqual(hours[-1]["at"], "2026-11-10T21:00:00-08:00")
        self.assertEqual(hours[0]["at"], "2026-11-08T22:00:00-08:00")

    def test_the_median_comes_from_the_merged_sample_before_the_full_history(self):
        source = fixture()
        source["merge_counts"] = {"rolling": {"last_hour": 0, "last_24_hours": 0, "last_7_days": 0}, "per_hour": [],
                                  "merged_per_day": [], "opened_per_day": []}
        source["merged_sample"] = [{"createdAt": ago(16), "mergedAt": ago(6)}]  # 10 hours
        source["pulls"] = [{"createdAt": ago(106), "mergedAt": ago(6)}]  # 100 hours
        self.assertEqual(summarize(source, NOW)["pull_requests"]["median_hours_to_merge"], 10)

    def test_merge_counts_do_not_depend_on_commit_volume(self):
        run, _, _ = self.search_run(endless_commits=True)
        data = collect(run, NOW, budget=10)  # the commit paging alone would use all of it
        self.assertEqual(len(data["danswett/agent-bridge"]["merges"]["per_hour"]), 48)
        self.assertEqual(len(data["danswett/agent-bridge"]["pull_requests"]["merged_per_day"]), 30)

    def test_a_pull_request_read_that_cannot_finish_is_not_started_and_says_why(self):
        run, calls, _ = self.search_run(counts={"u": 2168})  # 2,168 PRs updated in 30 days: 44 pages of 50
        data = collect(run, NOW)
        self.assertFalse(any("timelineItems" in c[-1] for c in calls), "the heavy read must not start")
        self.assertLess(len(calls), 60)
        for repo in ("danswett/agent-bridge", "danswett/slipgates-fleet"):
            text = " | ".join(data[repo]["unavailable"])
            self.assertIn("pulls: 2168 pull requests updated in 30 days need 44 requests", text, repo)
            self.assertNotIn("request budget exhausted", text, repo)
            self.assertIn("builders, review receipts and ready latency", text, repo)
            self.assertIn("resolved_per_day", data[repo]["issues"], repo)
            self.assertEqual(len(data[repo]["merges"]["per_hour"]), 48, repo)

    def test_a_pull_request_read_that_fits_still_runs(self):
        run, calls, _ = self.search_run(counts={"u": 100})
        collect(run, NOW)
        self.assertTrue(any("timelineItems" in c[-1] for c in calls))


class CommitCapAndPreviousChecksTests(unittest.TestCase):
    """Roadmap #37 (review notes on #36): cap the commit paging per repo, and type-check what --previous supplies."""

    def test_commit_paging_is_capped_per_repo_and_keeps_the_total_and_the_other_tiles(self):
        from stats import COMMIT_PAGES
        run, calls, _ = SearchWindowAndBudgetTests.search_run(None, endless_commits=True)
        data = collect(run, NOW)
        pages = [c for c in calls if "history(first:100" in c[-1]]
        self.assertEqual(len(pages), 2 * COMMIT_PAGES)  # one repo cannot take the other's requests
        self.assertLessEqual(len(calls), 60)
        for repo in ("danswett/agent-bridge", "danswett/slipgates-fleet"):
            self.assertEqual(data[repo]["commits"]["total"], 1234, repo)
            self.assertNotIn("per_day", data[repo]["commits"], repo)  # an incomplete series is never shown as complete
            self.assertIn(f"commit history is longer than {COMMIT_PAGES} pages", " | ".join(data[repo]["unavailable"]), repo)
            self.assertEqual(len(data[repo]["merges"]["per_hour"]), 48, repo)
            self.assertIn("median_minutes", data[repo]["ci"], repo)

    def previous_with(self, **commits):
        run, _ = CheapReadsFirstAndLastGoodTests.stub(None)
        earlier = collect(run, NOW)
        earlier["danswett/agent-bridge"]["commits"].update(commits)
        return earlier

    def failing_commits(self, previous, previous_at="2026-11-11T05:00:00+00:00"):
        run, _ = CheapReadsFirstAndLastGoodTests.stub(None, fail=("commits",))
        return collect(run, NOW, previous=previous, previous_at=previous_at)["danswett/agent-bridge"]

    def test_a_previous_value_that_is_not_plain_finite_json_is_ignored_not_carried(self):
        for bad in (float("nan"), float("inf"), {"x": [float("-inf")]}):
            with self.subTest(bad=bad):
                repo = self.failing_commits(self.previous_with(total=bad))
                self.assertNotIn("commits", repo)
                self.assertIn("Data unavailable: commits", repo["unavailable"])

    def test_stale_since_is_a_timestamp_or_a_fixed_phrase_never_other_text(self):
        for bad in ("<img src=x onerror=alert(1)>", "2026-11-11T05:00:00Z\n# injected", 123, "", "a" * 500):
            with self.subTest(bad=bad):
                repo = self.failing_commits(self.previous_with(stale_since=bad))
                self.assertEqual(repo["commits"]["stale_since"], "2026-11-11T05:00:00+00:00")
                self.assertNotIn("injected", " | ".join(repo["unavailable"]))
        repo = self.failing_commits(self.previous_with(), previous_at="<b>bad</b>")
        self.assertEqual(repo["commits"]["stale_since"], "an earlier run")
        self.assertNotIn("<b>", " | ".join(repo["unavailable"]))
