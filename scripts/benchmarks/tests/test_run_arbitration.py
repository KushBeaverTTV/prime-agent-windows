from __future__ import annotations

import unittest
from unittest.mock import patch

from test_benchmarks import HEAD, FakeGitHub, fixture

from cli import require_success
from github import TITLE
from report import MARKER, render

SURVIVOR = 34740826172
CANCELED = 34740826540


class ArbitrationGitHub(FakeGitHub):
    def __init__(self):
        super().__init__()
        self.attempts = {}
        self.runs = [
            {
                "id": CANCELED,
                "run_number": 514,
                "run_attempt": 1,
                "display_title": f"{TITLE}42",
                "status": "completed",
                "conclusion": "cancelled",
            },
            {
                "id": SURVIVOR,
                "run_number": 507,
                "run_attempt": 1,
                "display_title": f"{TITLE}42",
                "status": "in_progress",
                "conclusion": None,
            },
        ]

    def request(self, method, path, body=None):
        if method == "GET" and path.startswith("actions/runs/"):
            parts = path.split("/")
            run_id = int(parts[2])
            if len(parts) == 5:
                return self.attempts[run_id, int(parts[4])]
            return next(run for run in self.runs if run["id"] == run_id)
        return super().request(method, path, body)


def report_for(run_id, status="running"):
    report = fixture()
    report.run_id = run_id
    report.status = status
    return report


class RunArbitrationTests(unittest.TestCase):
    def test_canceled_duplicate_does_not_supersede_surviving_run(self):
        github = ArbitrationGitHub()
        self.assertTrue(github.fresh(report_for(SURVIVOR)))

    def test_survivor_replaces_canceled_duplicate_comment(self):
        github = ArbitrationGitHub()
        github.comments = [
            {
                "id": 2,
                "user": {"login": "github-actions[bot]"},
                "body": render(report_for(CANCELED, "canceled")),
            }
        ]
        self.assertTrue(github.publish(report_for(SURVIVOR)))
        self.assertIn(f"run:{SURVIVOR}:1", github.writes[-1][2]["body"])

    def test_late_cancellation_cannot_replace_survivor_comment(self):
        github = ArbitrationGitHub()
        for status in ("running", "completed", "partial", "failed"):
            with self.subTest(status=status):
                github.comments = [
                    {
                        "id": 2,
                        "user": {"login": "github-actions[bot]"},
                        "body": render(report_for(SURVIVOR, status)),
                    }
                ]
                self.assertFalse(github.publish(report_for(CANCELED, "canceled")))
        self.assertEqual(github.writes, [])

    def test_single_canceled_run_can_still_publish_its_own_notice(self):
        github = ArbitrationGitHub()
        github.runs = github.runs[:1]
        github.comments = [
            {"id": 2, "user": {"login": "github-actions[bot]"}, "body": render(report_for(CANCELED))}
        ]
        self.assertTrue(github.publish(report_for(CANCELED, "canceled")))

    def test_canceled_workflow_cannot_replace_survivor_with_preserved_artifact_status(self):
        for artifact_status in ("failed", "partial", "completed"):
            for survivor_status in ("running", "completed", "partial", "failed"):
                with self.subTest(artifact=artifact_status, survivor=survivor_status):
                    github = ArbitrationGitHub()
                    github.comments = [
                        {
                            "id": 2,
                            "user": {"login": "github-actions[bot]"},
                            "body": render(report_for(SURVIVOR, survivor_status)),
                        }
                    ]
                    self.assertFalse(github.publish(report_for(CANCELED, artifact_status)))
                    self.assertEqual(github.writes, [])

    def test_uncanceled_newer_workflow_can_publish_failure_over_survivor(self):
        for status in ("failed", "partial"):
            with self.subTest(status=status):
                github = ArbitrationGitHub()
                github.runs[0].update(conclusion="failure")
                github.comments = [
                    {
                        "id": 2,
                        "user": {"login": "github-actions[bot]"},
                        "body": render(report_for(SURVIVOR, "completed")),
                    }
                ]
                self.assertTrue(github.publish(report_for(CANCELED, status)))
                self.assertIn(f"run:{CANCELED}:1", github.writes[-1][2]["body"])

    def test_active_or_failed_newer_run_still_supersedes(self):
        for status, conclusion in (
            ("queued", None),
            ("in_progress", None),
            ("completed", "failure"),
            ("completed", "success"),
        ):
            with self.subTest(status=status, conclusion=conclusion):
                github = ArbitrationGitHub()
                github.runs[0].update(status=status, conclusion=conclusion)
                self.assertFalse(github.fresh(report_for(SURVIVOR)))

    def test_comment_order_uses_run_number_even_when_ids_are_reversed(self):
        github = ArbitrationGitHub()
        github.runs[0].update(run_number=506, conclusion="success")
        github.comments = [
            {
                "id": 2,
                "user": {"login": "github-actions[bot]"},
                "body": render(report_for(CANCELED, "completed")),
            }
        ]
        self.assertTrue(github.publish(report_for(SURVIVOR)))

    def test_newer_comment_is_protected_during_list_visibility_lag(self):
        github = ArbitrationGitHub()
        github.runs[0].update(conclusion="success")
        github.comments = [
            {
                "id": 2,
                "user": {"login": "github-actions[bot]"},
                "body": f"{MARKER}\n<!-- run:{CANCELED}:1 head:{HEAD} -->",
            }
        ]
        with patch.object(
            github,
            "pages",
            side_effect=lambda path, key=None: iter([github.runs[1:] if key else github.comments]),
        ):
            self.assertFalse(github.publish(report_for(SURVIVOR)))
        self.assertEqual(github.writes, [])

    def test_incomplete_and_canceled_reports_still_fail_the_command(self):
        for status in ("canceled", "failed", "partial", "completed"):
            with self.subTest(status=status), self.assertRaises(SystemExit):
                require_success(report_for(SURVIVOR, status))

    def test_retry_of_latest_canceled_run_can_replace_its_previous_attempt(self):
        github = ArbitrationGitHub()
        github.runs[0].update(run_attempt=2, status="in_progress", conclusion=None)
        github.runs[1].update(status="completed", conclusion="failure")
        github.comments = [
            {
                "id": 2,
                "user": {"login": "github-actions[bot]"},
                "body": render(report_for(CANCELED, "canceled")),
            }
        ]
        report = report_for(CANCELED)
        report.attempt = 2
        self.assertTrue(github.fresh(report))
        self.assertTrue(github.publish(report))
        self.assertIn(f"run:{CANCELED}:2", github.writes[-1][2]["body"])
        self.assertFalse(github.publish(report_for(CANCELED, "canceled")))

    def test_canceled_rerun_does_not_erase_previous_attempt_comment_protection(self):
        github = ArbitrationGitHub()
        github.attempts[CANCELED, 1] = github.runs[0] | {"conclusion": "success"}
        github.runs[0].update(run_attempt=2)
        github.comments = [
            {
                "id": 2,
                "user": {"login": "github-actions[bot]"},
                "body": render(report_for(CANCELED, "completed")),
            }
        ]
        self.assertFalse(github.publish(report_for(SURVIVOR)))

    def test_active_rerun_is_protected_even_when_list_only_shows_the_survivor(self):
        github = ArbitrationGitHub()
        github.attempts[CANCELED, 1] = github.runs[0].copy()
        github.runs[0].update(run_attempt=2, status="in_progress", conclusion=None)
        github.comments = [
            {
                "id": 2,
                "user": {"login": "github-actions[bot]"},
                "body": render(report_for(CANCELED, "canceled")),
            }
        ]
        with patch.object(
            github,
            "pages",
            side_effect=lambda path, key=None: iter([github.runs[1:] if key else github.comments]),
        ):
            self.assertFalse(github.publish(report_for(SURVIVOR)))


if __name__ == "__main__":
    unittest.main()
