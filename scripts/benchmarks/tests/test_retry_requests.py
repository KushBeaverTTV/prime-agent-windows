from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_benchmarks import SHA, FakeGitHub, fixture

from cli import completed_report, main, prepare_request, validate_completion
from github import TITLE
from schema import load_report, write_json


class RetryRequestTests(unittest.TestCase):
    def test_first_execution_preserves_the_resolved_comparison(self):
        github = FakeGitHub()
        github.main_sha = "c" * 40
        source = fixture()
        report, author = prepare_request(github, source, 100, 1, 1, SHA)
        self.assertEqual(report, source)
        self.assertEqual(author, "kevin")
        self.assertEqual(github.writes, [])

    def test_child_only_retry_resolves_a_new_request_with_the_same_trusted_harness(self):
        github = FakeGitHub()
        github.attempt = 3
        github.main_sha, github.head = "c" * 40, "d" * 40
        source = fixture()
        report, _ = prepare_request(github, source, 100, 3, 1, SHA)
        self.assertEqual((report.run_id, report.attempt), (100, 3))
        self.assertEqual((report.base_sha, report.head_sha), (github.main_sha, github.head))
        self.assertEqual(report.harness_sha, source.harness_sha)
        self.assertEqual(report.config, source.config)
        self.assertNotEqual(report.started_at, source.started_at)
        self.assertEqual(source, fixture())
        self.assertEqual(github.writes, [])

    def test_invalid_source_identity_is_rejected_before_resolution(self):
        for field, value in (
            ("repository", "other/repo"),
            ("run_id", 101),
            ("attempt", 2),
            ("harness_sha", "c" * 40),
            ("status", "pending-trust"),
            ("status", "completed"),
        ):
            with self.subTest(field=field, value=value):
                github = FakeGitHub()
                source = fixture().model_copy(update={field: value})
                with patch.object(github, "resolve") as resolve, self.assertRaises(ValueError):
                    prepare_request(github, source, 100, 3, 1, SHA)
                resolve.assert_not_called()
        with self.assertRaises(ValueError):
            prepare_request(FakeGitHub(), fixture(), 100, 0, 1, SHA)

    def test_closed_stale_and_superseded_attempts_cannot_start_compute(self):
        for case in ("closed", "head", "attempt", "newer-run"):
            with self.subTest(case=case):
                github = FakeGitHub()
                if case == "closed":
                    github.state = "closed"
                elif case == "head":
                    github.head = "c" * 40
                elif case == "attempt":
                    github.attempt = 2
                else:
                    github.runs.append({"run_number": 11, "run_attempt": 1, "display_title": f"{TITLE}42"})
                with self.assertRaises(ValueError):
                    prepare_request(github, fixture(), 100, 1, 1, SHA)

    def test_prepare_cli_and_finalizer_use_the_execution_attempt_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, execution = root / "source.json", root / "execution"
            event, output = root / "event.json", root / "output.txt"
            write_json(source, fixture())
            event.write_text(json.dumps({"pull_request": {"number": 42}}))
            github = FakeGitHub()
            github.attempt = 2
            with (
                patch("cli.GitHub", return_value=github),
                patch("cli.Controller") as controller,
                patch.object(
                    sys,
                    "argv",
                    ["cli.py", "prepare", "--request", str(source), "--results", str(execution)],
                ),
                patch.dict(
                    os.environ,
                    {
                        "GITHUB_REPOSITORY": github.repository,
                        "GITHUB_EVENT_PATH": str(event),
                        "GITHUB_OUTPUT": str(output),
                        "GITHUB_RUN_ID": "100",
                        "GITHUB_RUN_ATTEMPT": "2",
                        "BENCHMARK_REQUEST_ATTEMPT": "1",
                        "BENCHMARK_HARNESS_SHA": SHA,
                    },
                ),
            ):
                main()
                controller.assert_not_called()
            report = load_report(execution / "report.json")
            self.assertEqual(report.attempt, 2)
            self.assertEqual(output.read_text(), "author=kevin\n")
            run = {"id": 100, "run_attempt": 2, "display_title": f"{TITLE}42", "conclusion": "failure"}
            validate_completion(report, report, run)
            with self.assertRaises(ValueError):
                validate_completion(report, fixture(), run)
            final = completed_report(root / "missing.json", execution / "report.json", run)
            self.assertEqual((final.attempt, final.status), (2, "failed"))
            self.assertEqual(github.writes, [])


if __name__ == "__main__":
    unittest.main()
