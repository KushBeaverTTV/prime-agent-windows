"""Static contract tests: the hosted Short SWE packages pin the published identity."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from scripts.evals.short_swe import prepare  # noqa: E402

EVAL_ROOT = prepare.ROOT
HUB = EVAL_ROOT / "hub"
PACKAGES = {
    "short-swe-verified": ("swebench-verified", "ShortSWEVerifiedTaskset", "ShortSWEVerifiedEnv"),
    "short-swe-pro": ("swebench-pro", "ShortSWEProTaskset", "ShortSWEProEnv"),
    "short-swe-scaleswe": ("scaleswe", "ShortSWEScalesweTaskset", "ShortSWEScalesweEnv"),
}


def module_dir(package: str) -> Path:
    return HUB / package / package.replace("-", "_")


def fixed_tasks(package: str) -> tuple[str, ...]:
    source = (module_dir(package) / "taskset.py").read_text()
    match = re.search(r"FIXED_TASKS = \(([^)]*)\)", source)
    assert match, f"{package}: FIXED_TASKS not found"
    names = re.findall(r'"([^"]+)"', match.group(1))
    return tuple(names)


def test_package_slices_match_the_manifest() -> None:
    manifest = json.loads((EVAL_ROOT / "short-swe.json").read_text())
    by_id = {item["id"]: item["tasks"] for item in manifest["tasksets"]}
    for package, (taskset_id, _, _) in PACKAGES.items():
        assert fixed_tasks(package) == tuple(by_id[taskset_id]), package


def test_scaleswe_filter_selects_the_slice_and_keeps_all_images() -> None:
    source = (module_dir("short-swe-scaleswe") / "taskset.py").read_text()
    match = re.search(r"FIXED_FILTER = (.+)", source)
    assert match, "FIXED_FILTER not found"
    expression = eval(  # noqa: S307 - the package's own filter expression
        compile(
            match.group(1).replace("FIXED_TASKS", repr(fixed_tasks("short-swe-scaleswe"))),
            "<FIXED_FILTER>",
            "eval",
        )
    )
    fn = eval(expression)  # noqa: S307 - the package's own filter expression
    for task in fixed_tasks("short-swe-scaleswe"):
        assert fn({"instance_id": task})
    assert not fn({"instance_id": "unselected"})
    assert "filter_unavailable_images: bool = False" in source


def test_each_package_exports_one_taskset_env_and_harness() -> None:
    for package, (_, taskset_name, env_name) in PACKAGES.items():
        source = (module_dir(package) / "__init__.py").read_text()
        assert f'__all__ = ["{taskset_name}", "{env_name}", "PrimeAgentCandidateHarness"]' in source


def test_packages_pin_the_manifest_limits_and_datasets() -> None:
    common = (module_dir("short-swe-verified") / "secure_harbor.py").read_text()
    assert '"max_turns": 128' in common
    assert '"max_output_tokens": 100_000' in common
    assert '"max_total_tokens": 5_000_000' in common
    assert "ROLLOUT_SECONDS = 3_600.0" in common
    for package in PACKAGES:
        pyproject = (HUB / package / "pyproject.toml").read_text()
        # The platform's verifiers v1 runner installs its own Verifiers runtime, so the
        # hosted packages accept the platform version instead of pinning a git commit.
        assert '"verifiers[harbor]>=0.3.1",' in pyproject, package


def test_verified_package_pins_the_isolated_verifier() -> None:
    source = (module_dir("short-swe-verified") / "__init__.py").read_text()
    assert "ISOLATED_VERIFIER = True" in source
    assert "SCORING_SECONDS = 3600.0" in source
    assert "FINALIZE_SECONDS = 3600.0" in source


def test_candidate_source_never_reaches_candidate_runtimes() -> None:
    for package in PACKAGES:
        contract = (module_dir(package) / "candidate_contract.py").read_text()
        assert '"CANDIDATE_TOKEN"' in contract
        assert "CREDENTIAL_ENV" in contract
        harness = (module_dir(package) / "prime_agent_candidate.py").read_text()
        assert "process_env(" in harness
        harbor = (module_dir(package) / "secure_harbor.py").read_text()
        assert '"CANDIDATE_TOKEN"' in harbor


def test_hosted_candidate_requires_every_secret() -> None:
    harness = (module_dir("short-swe-verified") / "prime_agent_candidate.py").read_text()
    for name in ("CANDIDATE_TARBALLS_URL", "CANDIDATE_COMMIT", "CANDIDATE_CHECKSUMS"):
        assert name in harness


def test_packages_build(tmp_path: Path) -> None:
    for package in PACKAGES:
        result = subprocess.run(
            ["uv", "build", "--out-dir", str(tmp_path / package)],
            cwd=HUB / package,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, f"{package}: {result.stderr[-500:]}"


def test_packages_target_the_platform_hook_signatures() -> None:
    """The platform runtime invokes hooks by name: setup takes only runtime, while
    verifier staging receives (trace, runtime)."""
    harbor = (module_dir("short-swe-verified") / "secure_harbor.py").read_text()
    assert "async def setup(self, runtime: Runtime) -> None:" in harbor
    assert "async def stage_verifier(self, trace: vf.Trace, runtime: Runtime) -> None:" in harbor
    assert "async def run_verifier(self, runtime: Runtime, trace: vf.Trace) -> float:" in harbor
    scaleswe = (module_dir("short-swe-scaleswe") / "taskset.py").read_text()
    assert "async def setup(self, runtime: vf.Runtime) -> None:" in scaleswe
    assert "async def finalize(self, trace: vf.Trace, runtime: vf.Runtime) -> None:" in scaleswe
