import unittest
import json
from datetime import datetime, timedelta, timezone
from stats import collect, summarize


NOW = datetime(2026, 11, 11, 5, 30, tzinfo=timezone.utc)
SHA = "a" * 40


def ago(hours):
    return (NOW - timedelta(hours=hours)).isoformat()


def fixture():
    return {
        "issue_counts": {"total": 10, "open": 4, "resolved": 6},
        "closed_issues": [{"closedAt": ago(1)}, {"closedAt": ago(48)}],
        "pulls": [{
            "createdAt": ago(hours + 24), "mergedAt": ago(hours), "headRefOid": SHA,
            "author": {"login": "bob" if i == 2 else "alice"},
            "timelineItems": {"nodes": [{"createdAt": ago(hours + [2, 4, 12][i]), "label": {"name": "ready"}}]},
            "comments": {"nodes": [{"body": f"independent-review: CLEAN at {SHA}\nReviewer: Public reviewer, model, Claude"}]},
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
        self.assertEqual(set(data), {"epics", "stats"})
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
        pr["comments"]["nodes"].append({"body": f"independent-review-2: CLEAN at {SHA}\nReviewer: Private session, model, OpenAI"})
        source["pulls"] = [pr, dict(pr, headRefOid="b" * 40)]
        data = summarize(source, NOW)
        self.assertEqual(data["reviewers"], {"Claude": 1, "OpenAI": 1})
        self.assertNotIn("Private session", str(data))

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
            elif "issues(first" in query:
                second = 'after:"next"' in query
                data = {"issues": {"nodes": [{"closedAt": ago(400 if second else 1), "updatedAt": ago(400 if second else 1)}],
                                   "pageInfo": {"hasNextPage": True, "endCursor": "last" if second else "next"}}}
            elif "pullRequests(first" in query:
                data = {"pullRequests": {"nodes": fixture()["pulls"], "pageInfo": page}}
            elif "history(first:0)" in query:
                data = {"ref": {"target": {"history": {"totalCount": 1234}}}}
            else:
                data = {"ref": {"target": {"history": {"nodes": fixture()["commits"]["nodes"], "pageInfo": page}}}}
            return json.dumps({"data": {"repository": dict(data, isPrivate=True if private else False)}})

        private = False
        data = collect(run, NOW, budget=16)
        self.assertEqual(len(calls), 16)
        self.assertEqual(data["danswett/agent-bridge"]["commits"]["total"], 1234)
        self.assertEqual(data["danswett/slipgates-fleet"]["issues"]["counts"]["total"], 10)
        calls.clear()
        self.assertIn("unavailable", collect(run, NOW, budget=1)["danswett/slipgates-fleet"])
        self.assertEqual(len(calls), 1)
        private = True
        calls.clear()
        self.assertNotIn("issues", collect(run, NOW)["danswett/agent-bridge"])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(args[2] == "graphql" and "open:issues" not in args[-1] for args in calls))
