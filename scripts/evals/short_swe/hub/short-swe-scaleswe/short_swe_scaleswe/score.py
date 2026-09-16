"""Run the merged F2P+P2P pytest ids and emit 1.0 iff every expected id passed.

The scorer is a trusted wrapper running under `python -I`. It runs pytest in-process
with a plugin that records each test's outcome in the wrapper's own memory; no result
file path, environment variable, or command-line argument ever reveals a writable
result channel to candidate code. `atexit` handlers cannot modify the in-memory list,
and `os._exit` prevents the wrapper from writing any result, which the controller
treats as unresolved. The wrapper writes its score to the controller-generated path
only after every expected test has a recorded outcome.
"""

import json
import os
import sys
from pathlib import Path

import pytest

SCORE_PATH = Path(os.environ["SCALESWE_SCORE_PATH"])
EXPECTED_PATH = Path(sys.argv[1])
ROOTDIR = Path.cwd()


class _ResultCollector:
    """Pytest plugin recording every test outcome in the wrapper's memory."""

    def __init__(self) -> None:
        self.outcomes: dict[str, str] = {}

    @pytest.hookimpl(hookwrapper=True)
    def pytest_runtest_logreport(self, report) -> None:
        outcome = next(iter(()), None)
        if report.when == "call":
            if report.passed:
                outcome = "passed"
            elif report.failed:
                outcome = "failed"
            elif report.skipped:
                outcome = "skipped"
        elif report.when == "setup" and report.outcome != "passed":
            outcome = "error" if report.failed else "skipped"
        elif report.when == "teardown" and report.failed:
            outcome = "error"
        if outcome is not None:
            self.outcomes[report.nodeid] = outcome
        yield


def normalize(value: str) -> str:
    parts = value.strip().split("::")
    if parts and parts[0].endswith(".py"):
        parts[0] = parts[0][:-3]
    return ".".join(parts).replace("/", ".").strip(".")


def all_passed(outcomes: dict[str, str], expected: list[str]) -> bool:
    """1.0 only when every expected id ran and passed; skipped is not a pass."""
    matched: dict[str, str] = {}
    for node_id, outcome in outcomes.items():
        for candidate in (
            node_id,
            normalize(node_id),
            node_id.replace("::", ".").replace("/", "."),
        ):
            if candidate in expected:
                matched[candidate] = outcome
                break
    found = set(matched)
    return (
        bool(found)
        and all(status == "passed" for status in matched.values())
        and not [t for t in expected if t not in found]
    )


def main() -> None:
    expected = json.loads(EXPECTED_PATH.read_text())
    if not expected:
        SCORE_PATH.write_text("0.0\n")
        return
    collector = _ResultCollector()
    code = pytest.main(
        ["-vv", "-o", "addopts=", "--rootdir=.", *expected],
        plugins=[collector],
    )
    # Crash codes outside 0/1 mean pytest itself failed; in-memory results are
    # authoritative — a forged or missing file cannot award a pass.
    score = 0.0
    if code in (0, 1) and all_passed(collector.outcomes, expected):
        score = 1.0
    SCORE_PATH.write_text(f"{score}\n")
    # The trusted wrapper terminates immediately: no atexit handler registered by
    # candidate code can run after the score is written.
    os._exit(0)


if __name__ == "__main__":
    main()
