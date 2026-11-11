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
