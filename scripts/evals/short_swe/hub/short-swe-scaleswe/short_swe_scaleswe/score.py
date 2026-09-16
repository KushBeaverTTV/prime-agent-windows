"""Run the merged F2P+P2P pytest ids and emit 1.0 iff every expected id passed.

The scorer is a trusted wrapper: it launches pytest in a subprocess whose environment
does NOT carry `SCALESWE_SCORE_PATH` or `SCALESWE_RESULTS_XML`, so candidate test code
cannot discover, write, or overwrite the controller-side result files. The wrapper
reads the fresh JUnit report after the subprocess exits and writes the score to the
controller-generated path; stdout parsing is never trusted.
"""

import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

SCORE_PATH = os.environ["SCALESWE_SCORE_PATH"]
XML_PATH = Path(os.environ["SCALESWE_RESULTS_XML"])
EXPECTED_PATH = Path(sys.argv[1])
ROOTDIR = Path.cwd()


def normalize(value: str) -> str:
    parts = value.strip().split("::")
    if parts and parts[0].endswith(".py"):
        parts[0] = parts[0][:-3]
    return ".".join(parts).replace("/", ".").strip(".")


def all_passed(xml_content: str, expected: list[str]) -> bool:
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError:
        return False
    exact = set(expected)
    norm = {normalize(t): t for t in expected}
    fp = {re.sub(r"\s+", "", normalize(t)): t for t in expected}
    matched: dict[str, str] = {}
    found: set[str] = set()
    for tc in root.iter("testcase"):
        if tc.find("skipped") is not None:
            continue
        name, classname = tc.get("name", ""), tc.get("classname", "")
        file_attr = tc.get("file", "")
        status = "failed" if tc.find("failure") is not None or tc.find("error") is not None else "passed"
        for candidate in (
            f"{file_attr}::{name}" if file_attr else "",
            normalize(f"{classname}.{name}"),
            re.sub(r"\s+", "", normalize(f"{classname}.{name}")),
            f"{classname.replace('.', '/')}.py::{name}",
        ):
            original = candidate if candidate in exact else norm.get(candidate) or fp.get(candidate)
            if original:
                matched[original] = status
                found.add(original)
                break
    return (
        bool(found)
        and all(status == "passed" for status in matched.values())
        and not [t for t in expected if t not in found]
    )


def main() -> None:
    expected = json.loads(EXPECTED_PATH.read_text())
    if not expected:
        Path(SCORE_PATH).write_text("0.0\n")
        return
    XML_PATH.unlink(missing_ok=True)
    # The subprocess that imports candidate code must not see the result paths.
    child_env = {
        k: v for k, v in os.environ.items() if k not in ("SCALESWE_SCORE_PATH", "SCALESWE_RESULTS_XML")
    }
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-vv",
            f"--junitxml={XML_PATH}",
            "-o",
            "addopts=",
            "--rootdir=.",
            *expected,
        ],
        env=child_env,
        cwd=ROOTDIR,
        capture_output=True,
        timeout=3000,
    )
    # Only the fresh JUnit report can award a pass; skipped and xfailed entries
    # are never counted, and pytest crash codes outside 0/1 fail closed.
    score = 0.0
    if result.returncode in (0, 1):
        try:
            xml_content = XML_PATH.read_text()
        except OSError:
            xml_content = ""
        if xml_content and all_passed(xml_content, expected):
            score = 1.0
    Path(SCORE_PATH).write_text(f"{score}\n")


if __name__ == "__main__":
    main()
