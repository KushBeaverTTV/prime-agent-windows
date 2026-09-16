"""Run the merged F2P+P2P pytest ids and emit 1.0 iff every expected id passed.

Run inside the task's repo (cwd) by the testbed python (which has pytest + the project
installed). argv[1] is the path to a JSON file of pytest node ids; the JUnit XML path
arrives in ``SCALESWE_RESULTS_XML`` (a controller-generated unique path, so no stale or
planted report can be parsed). The previous report is deleted before pytest runs and a
pytest crash fail-closes to 0.0.
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest


def emit(score: float) -> None:
    print(f"<score>{score}</score>")
    sys.stdout.flush()


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
    expected = json.load(open(sys.argv[1]))
    if not expected:
        emit(0.0)
        return
    xml_path = Path(os.environ["SCALESWE_RESULTS_XML"])
    xml_path.unlink(missing_ok=True)
    code = pytest.main(["-vv", f"--junitxml={xml_path}", "-o", "addopts=", "--rootdir=.", *expected])
    # Skipped, xfailed, or never-run expected tests exit 0 but are not passes; only the
    # fresh JUnit report itself can award 1.0.
    if code not in (0, 1):
        emit(0.0)
        return
    try:
        xml_content = xml_path.read_text()
    except OSError:
        emit(0.0)
        return
    emit(1.0 if all_passed(xml_content, expected) else 0.0)


if __name__ == "__main__":
    main()
