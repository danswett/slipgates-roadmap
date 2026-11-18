import json
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
        self.snapshot = {"epics": [self.epic], "priority_body": "",
                         "blocker_titles": {"55": "Roster", "12": "Reply"},
                         "blocker_states": {"55": "OPEN", "12": "OPEN"}}

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
        relation = {"number": 55, "title": "Roster", "state": "OPEN",
                    "repository": {"nameWithOwner": repo.R}}
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

    def test_closed_relation_blockers_do_not_block_children_or_epics(self):
        self.child["labels"]["nodes"] = []
        for issue in (self.child, self.epic):
            for state in ("CLOSED", "MERGED"):
                with self.subTest(issue=issue["number"], state=state):
                    issue["blockedBy"]["nodes"] = [
                        dict(number=55, title="Roster", state=state,
                             repository={"nameWithOwner": repo.R})]
                    epic = self.generate()["epics"][0]
                    self.assertFalse(epic["blocked"])
                    self.assertEqual([], epic["blockerDetails"])
                    self.assertEqual([], epic["blockedChildren"])

    def test_body_blockers_keep_only_open_references_and_their_reasons(self):
        self.child["body"] = "Blocked by #55: finished roster\nBlocked by #12: waiting on reply"
        for state in ("CLOSED", "MERGED"):
            with self.subTest(state=state):
                self.snapshot["blocker_states"]["55"] = state
                epic = self.generate()["epics"][0]
                expected = [dict(number=12, title="Reply", reason="waiting on reply", clearsIt="Unassigned")]
                self.assertEqual(expected, epic["blockerDetails"])
                self.assertEqual(expected, epic["blockedChildren"][0]["blockers"])
                self.assertEqual([209], epic["blockers"])

    def test_mixed_relation_blockers_preserve_open_reasons(self):
        self.child["body"] = "Blocked by #55: finished roster\nBlocked by #12: waiting on reply"
        self.child["blockedBy"]["nodes"] = [
            dict(number=55, title="Roster", state="CLOSED", repository={"nameWithOwner": repo.R}),
            dict(number=12, title="Reply", state="OPEN", repository={"nameWithOwner": repo.R})]
        self.assertEqual([dict(number=12, title="Reply", reason="waiting on reply", clearsIt="Unassigned")],
                         self.generate()["epics"][0]["blockerDetails"])

    def test_all_closed_blockers_preserve_only_explicit_blocked_label(self):
        self.child["body"] = "Blocked by #55"
        self.snapshot["blocker_states"]["55"] = "CLOSED"
        for relation in ([], [dict(number=55, title="Roster", state="CLOSED",
                                  repository={"nameWithOwner": repo.R})]):
            self.child["blockedBy"]["nodes"] = relation
            for label in (None, "blocked", "status:blocked"):
                with self.subTest(relation=bool(relation), label=label):
                    self.child["labels"]["nodes"] = [{"name": label}] if label else []
                    data = self.generate()
                    epic = data["epics"][0]
                    self.assertEqual(bool(label), epic["blocked"])
                    self.assertEqual([209] if label else [], epic["blockers"])
                    self.assertEqual([None] if label else [],
                                     [b["number"] for b in epic["blockerDetails"]])
                    self.assertEqual(1 if label else 0, len(data["needsBlocker"]))
                    if label:
                        self.assertEqual("No blocker recorded", epic["blockerDetails"][0]["title"])

    def test_closed_relations_do_not_fall_back_to_open_body_references(self):
        self.child["labels"]["nodes"] = []
        self.child["body"] = "Blocked by #12"
        self.child["blockedBy"]["nodes"] = [
            dict(number=55, title="Roster", state="CLOSED", repository={"nameWithOwner": repo.R})]
        self.assertFalse(self.generate()["epics"][0]["blocked"])

    def test_unknown_blocker_states_fail_visibly(self):
        self.child["body"] = "Blocked by #55"
        for state in ("UNKNOWN", None):
            self.snapshot["blocker_states"]["55"] = state
            for relation in ([], [dict(number=55, title="Roster", state=state,
                                      repository={"nameWithOwner": repo.R})]):
                with self.subTest(state=state, relation=bool(relation)):
                    self.child["blockedBy"]["nodes"] = relation
                    with self.assertRaisesRegex(ValueError, "Unknown blocker state"):
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
        with patch.object(repo, "nodes", side_effect=[[epic], [self.child]]) as nodes, \
             patch.object(repo, "run", side_effect=[json.dumps({"body": ""}),
                                                    json.dumps({"title": "Roster", "state": "closed"})]) as run, \
             patch.object(repo, "collect", return_value={}):
            data = repo.read()
        queries = " ".join(call.args[0] for call in nodes.call_args_list)
        self.assertIn("body", queries)
        self.assertIn("nodes{number title state repository", queries)
        self.assertEqual(["repos/danswett/agent-bridge/issues/696", "repos/danswett/agent-bridge/issues/55"],
                         [call.args[2] for call in run.call_args_list])
        self.assertEqual("Roster", data["blocker_titles"]["55"])
        self.assertEqual("CLOSED", data["blocker_states"]["55"])
        self.child["labels"]["nodes"] = []
        self.child["body"] = "Blocked by #55"
        self.assertFalse(repo.generate(data)[0]["epics"][0]["blocked"])

    def test_read_reuses_known_states_and_fetches_body_reference_once(self):
        self.epic["body"] = "Blocked by #209, #55"
        self.child["body"] = "Blocked by #55"
        self.child["labels"]["nodes"] = []
        self.child["state"] = "CLOSED"
        other = dict(self.child, number=210, title="Another slice", state="OPEN")
        epic = {k: v for k, v in self.epic.items() if k != "children"}
        with patch.object(repo, "nodes", side_effect=[[epic], [self.child, other]]), \
             patch.object(repo, "run", side_effect=[json.dumps({"body": ""}),
                                                    json.dumps({"title": "Roster", "state": "open"})]) as run, \
             patch.object(repo, "collect", return_value={}):
            data = repo.read()
        self.assertEqual(2, run.call_count)
        self.assertEqual({"750": "OPEN", "209": "CLOSED", "210": "OPEN", "55": "OPEN"},
                         data["blocker_states"])
        self.assertEqual([55], [b["number"] for b in repo.generate(data)[0]["epics"][0]["blockerDetails"]])
