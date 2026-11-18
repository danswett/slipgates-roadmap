import json
import re
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import repo_dashboard as repo


class RepositoryDashboardTests(unittest.TestCase):
    def setUp(self):
        self.fixture = json.loads(Path(__file__).with_name("repository_fixture.json").read_text())

    def test_epics_children_and_unique_merges_feed_the_table_and_json(self):
        data, body = repo.generate(self.fixture, datetime.fromisoformat("2026-11-10T13:00:00+00:00"))
        empty, trust = data["epics"]
        self.assertEqual((750, 0, 0), (empty["number"], empty["closed"], empty["open"]))
        self.assertEqual((749, 2, 1, 1, 1, [209]),
                         (trust["number"], trust["closed"], trust["open"], trust["open_prs"],
                          trust["merged_last_24h"], trust["blockers"]))
        self.assertEqual([0] * 23 + [1], trust["merges_per_hour"])
        self.assertIn("Trust \\| safety", body)
        self.assertIn("| 2/3 | 1 | 1 | #209 |", body)
        self.fixture["priority_body"] = ""
        self.fixture["epics"][1]["labels"]["nodes"] = [{"name": "priority:P0"}]
        self.assertEqual(750, repo.generate(self.fixture)[0]["epics"][0]["number"])

    def test_unreadable_data_writes_visible_outputs_and_returns_normally(self):
        with tempfile.TemporaryDirectory() as directory:
            output, body = Path(directory) / "data.json", Path(directory) / "body.md"
            with patch.object(repo, "read", side_effect=ValueError("incomplete sub-issues")), \
                 patch("sys.argv", ["repo_dashboard", "--json-output", str(output), "--body-output", str(body)]):
                repo.main()
            self.assertIn("Data unavailable: incomplete sub-issues", body.read_text())
            self.assertEqual("incomplete sub-issues", json.loads(output.read_text())["error"])

    def test_paginated_reads_reject_graphql_errors(self):
        pages = [{"data":{"repository":{"issues":{"nodes":[{"number":749}]}}}},
                 {"data":{"repository":{"issues":{"nodes":[{"number":750}]}}}}]
        with patch.object(repo, "run", return_value=json.dumps(pages)) as run:
            self.assertEqual([749, 750], [i["number"] for i in repo.nodes("query", ("repository", "issues"))])
            self.assertIn("--paginate", run.call_args.args)
        with patch.object(repo, "run", return_value='[{"errors":[{"message":"denied"}]}]'):
            with self.assertRaisesRegex(ValueError, "GitHub query failed"):
                repo.nodes("query", ("repository", "issues"))

    def test_write_only_changes_the_body_when_material_data_changes(self):
        _, body = repo.generate(self.fixture)
        with tempfile.TemporaryDirectory() as directory:
            argv = ["repo", "--write", "--json-output", str(Path(directory) / "data.json"),
                    "--body-output", str(Path(directory) / "body.md")]
            for current, calls in [(body, 1), ("old body", 2)]:
                with patch("sys.argv", argv), patch.object(repo, "read", return_value=self.fixture), \
                     patch.object(repo, "run", return_value=json.dumps({"body": current})) as run:
                    repo.main()
                self.assertEqual(calls, run.call_count)
                if calls == 2:
                    self.assertIn("PATCH", run.call_args.args)

    def test_partial_nested_reads_are_not_published_as_complete_counts(self):
        self.fixture["epics"][0]["children"][0]["closedByPullRequestsReferences"]["pageInfo"]["hasNextPage"] = True
        with self.assertRaisesRegex(ValueError, "Incomplete linked pull requests"):
            repo.generate(self.fixture)


class BlockerTests(unittest.TestCase):
    def setUp(self):
        self.child = dict(number=209, title="Blocked slice", state="OPEN", body="",
                          labels={"nodes": [{"name": "blocked"}]},
                          blockedBy={"nodes": [], "pageInfo": {"hasNextPage": False}},
                          closedByPullRequestsReferences={"nodes": [], "pageInfo": {"hasNextPage": False}})
        self.epic = dict(number=750, title="Reliability", state="OPEN", body="",
                         labels={"nodes": []}, children=[self.child],
                         blockedBy={"nodes": [], "pageInfo": {"hasNextPage": False}})
        self.snapshot = {"epics": [self.epic], "priority_body": "", "blocker_titles": {"55": "Roster", "12": "Reply"}}

    def generate(self):
        return repo.generate(self.snapshot)[0]

    def test_body_blocker_reason_role_and_epic_rollup(self):
        self.child["labels"]["nodes"] = []
        self.child["body"] = "Blocked by #55: waiting on roster\nClears it: Engineering"
        data = self.generate()
        epic = data["epics"][0]
        blocker = {"number": 55, "title": "Roster", "reason": "waiting on roster", "clearsIt": "Engineering"}
        self.assertTrue(epic["blocked"])
        self.assertEqual([209], epic["blockers"])
        self.assertEqual([blocker], epic["blockerDetails"])
        self.assertEqual([dict(number=209, title="Blocked slice", blockers=[blocker], clearsIt="Engineering")],
                         epic["blockedChildren"])
        self.assertEqual([], data["needsBlocker"])

    def test_unstated_blocker_is_explicit_and_needs_source_fix(self):
        data = self.generate()
        epic = data["epics"][0]
        self.assertTrue(epic["blocked"])
        self.assertEqual([dict(number=None, title="No blocker recorded", reason="No blocker recorded",
                               clearsIt="Unassigned")], epic["blockedChildren"][0]["blockers"])
        self.assertEqual([dict(epic=750, number=209, title="Blocked slice", clearsIt="Unassigned")],
                         data["needsBlocker"])

    def test_multiple_body_references_are_unique_and_reasons_bounded(self):
        self.child["body"] = "Blocked by #55, #12 and #55: " + "x" * 100
        blockers = self.generate()["epics"][0]["blockerDetails"]
        self.assertEqual([55, 12], [b["number"] for b in blockers])
        self.assertEqual(["x" * 80] * 2, [b["reason"] for b in blockers])
        self.child["body"] = "Blocked by #55"
        self.assertEqual("Roster", self.generate()["epics"][0]["blockerDetails"][0]["reason"])

    def test_relation_beats_body_and_private_content_never_leaves_generator(self):
        self.child["body"] = "Blocked by #12: PRIVATE reason\nClears it: Quality"
        relation = {"number": 55, "title": "Roster", "repository": {"nameWithOwner": repo.R}}
        self.child["blockedBy"]["nodes"] = [relation]
        self.assertEqual([dict(number=55, title="Roster", reason="Roster", clearsIt="Quality")],
                         self.generate()["epics"][0]["blockerDetails"])
        self.child["body"] = "Blocked by #55: waiting on roster\nClears it: Quality"
        self.assertEqual("waiting on roster", self.generate()["epics"][0]["blockerDetails"][0]["reason"])
        relation.update(title="PRIVATE title", repository={"nameWithOwner": "danswett/slipgates-fleet"})
        data, body = repo.generate(self.snapshot)
        self.assertNotIn("PRIVATE", json.dumps(data) + body)
        self.assertEqual(dict(number=55, title="private item", reason="private item", clearsIt="Quality"),
                         data["epics"][0]["blockerDetails"][0])

    def test_private_body_reference_is_redacted_and_unknown_role_is_unassigned(self):
        for reference in ("danswett/slipgates-fleet#313",
                          "https://github.com/danswett/slipgates-fleet/issues/313"):
            self.child["body"] = f"Blocked by {reference}: PRIVATE reason\nClears it: PRIVATE person"
            data, body = repo.generate(self.snapshot)
            self.assertNotIn("PRIVATE", json.dumps(data) + body)
            self.assertEqual(dict(number=313, title="private item", reason="private item", clearsIt="Unassigned"),
                             data["epics"][0]["blockerDetails"][0])

    def test_closed_children_do_not_block_but_epic_own_blockers_do(self):
        self.child["state"] = "CLOSED"
        epic = self.generate()["epics"][0]
        self.assertFalse(epic["blocked"])
        self.assertEqual([], epic["blockedChildren"])
        self.epic["body"] = "Blocked by #12\nClears it: Product"
        epic = self.generate()["epics"][0]
        self.assertTrue(epic["blocked"])
        self.assertEqual("Reply", epic["blockerDetails"][0]["reason"])
        self.assertEqual("Product", epic["blockerDetails"][0]["clearsIt"])

    def test_partial_blocker_relations_fail_visibly(self):
        self.child["blockedBy"]["pageInfo"]["hasNextPage"] = True
        with self.assertRaisesRegex(ValueError, "Incomplete blocker relations"):
            self.generate()

    def test_private_sub_issue_cannot_publish_its_title_or_body(self):
        self.child.update(title="PRIVATE child", body="Blocked by #55: PRIVATE reason",
                          repository={"nameWithOwner": "danswett/slipgates-fleet"})
        data = self.generate()
        self.assertNotIn("PRIVATE", json.dumps(data))
        self.assertNotIn("209", json.dumps(data))
        self.assertFalse(data["epics"][0]["blocked"])
        self.assertEqual(0, data["epics"][0]["open"])
        self.assertEqual([], data["needsBlocker"])

    def test_read_fetches_bodies_relations_and_only_public_fallback_titles(self):
        self.child["body"] = "Blocked by #55 and danswett/slipgates-fleet#313"
        epic = {k: v for k, v in self.epic.items() if k != "children"}
        with patch.object(repo, "nodes", side_effect=[[epic], [self.child], []]) as nodes, \
             patch.object(repo, "run", side_effect=[json.dumps({"body": ""}),
                                                    json.dumps({"title": "Roster"})]) as run, \
             patch.object(repo, "collect", return_value={}):
            data = repo.read()
        queries = " ".join(call.args[0] for call in nodes.call_args_list)
        self.assertIn("body", queries)
        self.assertIn("blockedBy", queries)
        self.assertEqual(["repos/danswett/agent-bridge/issues/696", "repos/danswett/agent-bridge/issues/55"],
                         [call.args[2] for call in run.call_args_list])
        self.assertEqual("Roster", data["blocker_titles"]["55"])


class DescendantRollupTests(unittest.TestCase):
    def issue(self, number, state="OPEN", **fields):
        return dict(number=number, title=f"Slice {number}", state=state, body="",
                    repository={"nameWithOwner": repo.R},
                    labels={"nodes": [], "pageInfo": {"hasNextPage": False}},
                    blockedBy={"nodes": [], "pageInfo": {"hasNextPage": False}},
                    closedByPullRequestsReferences={"nodes": [], "pageInfo": {"hasNextPage": False}},
                    **fields)

    def setUp(self):
        self.epics = [self.issue(750)]
        self.child, self.grandchild = self.issue(209), self.issue(220, "CLOSED")
        self.graph = {750: [self.child], 209: [self.grandchild]}
        self.pages, self.incomplete, self.queries = {}, set(), []

    def read(self):
        def run(*args):
            if args[2] != "graphql":
                return json.dumps({"body": "", "title": "Roster"})
            self.assertIn("--paginate", args)
            self.assertIn("--slurp", args)
            query = args[-1]
            if 'labels:["epic"]' in query:
                return json.dumps([{"data": {"repository": {"issues": {
                    "nodes": self.epics, "pageInfo": {"hasNextPage": False}}}}}])
            number = int(re.search(r"issue\(number:(\d+)\)", query)[1])
            self.queries.append(number)
            pages = self.pages.get(number, [self.graph.get(number, [])])
            return json.dumps([{"data": {"repository": {"issue": {"subIssues": {
                "nodes": items, "pageInfo": {"hasNextPage": index < len(pages) - 1 or
                                           number in self.incomplete, "endCursor": str(index)}}}}}}
                for index, items in enumerate(pages)])
        with patch.object(repo, "run", side_effect=run), patch.object(repo, "collect", return_value={}):
            return repo.read()

    def generate(self):
        return repo.generate(self.read(), datetime.fromisoformat("2026-11-10T13:00:00+00:00"))[0]

    def test_grandchild_closed_and_open_totals_roll_up(self):
        for state, counts in [("CLOSED", (1, 1)), ("OPEN", (0, 2))]:
            with self.subTest(state=state):
                self.grandchild["state"] = state
                epic = self.generate()["epics"][0]
                self.assertEqual(counts, (epic["closed"], epic["open"]))

    def test_grandchild_prs_and_hourly_merges_roll_up_once(self):
        linked = [{"number": 300, "state": "OPEN", "mergedAt": None},
                  {"number": 301, "state": "MERGED", "mergedAt": "2026-11-10T12:15:00Z"}]
        self.grandchild["closedByPullRequestsReferences"]["nodes"] = linked
        self.child["closedByPullRequestsReferences"]["nodes"] = linked[:1]
        epic = self.generate()["epics"][0]
        self.assertEqual((1, 1), (epic["open_prs"], epic["merged_last_24h"]))
        self.assertEqual([0] * 23 + [1], epic["merges_per_hour"])

    def test_only_open_grandchildren_roll_up_blockers_and_fallback_titles(self):
        self.grandchild["body"] = "Blocked by #55: waiting on roster\nClears it: Engineering"
        for state in ("OPEN", "CLOSED"):
            with self.subTest(state=state):
                self.grandchild["state"] = state
                epic = self.generate()["epics"][0]
                self.assertEqual([220] if state == "OPEN" else [], epic["blockers"])
                if state == "OPEN":
                    self.assertEqual("Roster", epic["blockerDetails"][0]["title"])
                    self.assertEqual("Engineering", epic["blockedChildren"][0]["clearsIt"])

    def test_cycles_and_shared_descendants_are_counted_once(self):
        sibling = self.issue(210)
        self.graph[750].append(sibling)
        self.graph[210] = [self.grandchild]
        self.graph[220] = [self.epics[0], self.child]
        snapshot = self.read()
        self.assertEqual([209, 220, 210], [c["number"] for c in snapshot["epics"][0]["children"]])
        self.assertEqual(len(set(self.queries)), len(self.queries))
        epic = repo.generate(snapshot)[0]["epics"][0]
        self.assertEqual((1, 2), (epic["closed"], epic["open"]))

    def test_paginated_grandchildren_are_all_counted(self):
        self.pages[209] = [[self.grandchild], [self.issue(221)]]
        epic = self.generate()["epics"][0]
        self.assertEqual((1, 2), (epic["closed"], epic["open"]))

    def test_truncated_grandchild_page_fails_visibly(self):
        self.incomplete.add(209)
        with self.assertRaisesRegex(ValueError, "Incomplete.*sub-issues"):
            self.read()

    def test_nested_epic_keeps_its_row_and_shared_descendants(self):
        self.epics.append(self.child)
        epics = {epic["number"]: epic for epic in self.generate()["epics"]}
        self.assertEqual((1, 1), (epics[750]["closed"], epics[750]["open"]))
        self.assertEqual((1, 0), (epics[209]["closed"], epics[209]["open"]))
        self.assertEqual(1, self.queries.count(209))

    def test_private_descendants_are_not_counted_or_traversed(self):
        private = self.issue(220)
        private.update(title="PRIVATE descendant", repository={"nameWithOwner": "example/private"})
        sibling = dict(private, number=210)
        self.graph[209] = [private, sibling, self.grandchild]
        self.graph[210] = [self.issue(221)]
        snapshot = self.read()
        data, body = repo.generate(snapshot)
        self.assertNotIn("PRIVATE", json.dumps(snapshot) + json.dumps(data) + body)
        self.assertNotIn(210, self.queries)
        self.assertEqual((1, 1), (data["epics"][0]["closed"], data["epics"][0]["open"]))

    def test_three_levels_roll_up_but_deeper_reads_fail_visibly(self):
        self.graph[220] = [self.issue(221)]
        epic = self.generate()["epics"][0]
        self.assertEqual((1, 2), (epic["closed"], epic["open"]))
        self.graph[221] = [self.issue(222)]
        with self.assertRaisesRegex(ValueError, "Incomplete.*sub-issues.*depth"):
            self.read()

    def test_partial_grandchild_metadata_fails_visibly(self):
        for field, message in [("labels", "Incomplete issue labels"),
                               ("blockedBy", "Incomplete blocker relations"),
                               ("closedByPullRequestsReferences", "Incomplete linked pull requests")]:
            with self.subTest(field=field):
                self.grandchild["state"] = "OPEN"
                self.grandchild[field]["pageInfo"]["hasNextPage"] = True
                with self.assertRaisesRegex(ValueError, message):
                    self.generate()
                self.grandchild[field]["pageInfo"]["hasNextPage"] = False
