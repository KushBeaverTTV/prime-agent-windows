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
    # The filter is a direct ID membership check, not an evaluated expression.
    assert 'row["instance_id"] in fixed_ids' in source
    assert "filter_unavailable_images: bool = False" in source


def test_verified_and_pro_tasks_grade_in_fresh_verifiers() -> None:
    for package in ("short-swe-verified", "short-swe-pro"):
        marker = '"verifier": VerifierConfig(fresh_copy=True, network_allow=[])'
        source = (module_dir(package) / "taskset.py").read_text()
        assert marker in source, package
        assert 'Artifact(source="/tmp/prime-agent.patch")' in source, package
        assert "patch_collect_command(" in source, package


def test_scaleswe_filters_by_ids_without_eval() -> None:
    taskset = (module_dir("short-swe-scaleswe") / "taskset.py").read_text()
    assert "filter_fn" not in taskset
    assert "_resolve_filter_fn" not in taskset
    assert "eval(" not in taskset
    assert "fixed_ids" in taskset
    assert 'row["instance_id"] in fixed_ids' in taskset


def test_scaleswe_paths_include_symlinks_and_absolute_tools() -> None:
    taskset = (module_dir("short-swe-scaleswe") / "taskset.py").read_text()
    assert "/usr/bin/find" in taskset
    assert "\( -type f -o -type l \)" in taskset
    assert "/bin/rm" in taskset
    assert '"/bin/sh", "-c", self.TEST_PATHS' in taskset


def test_scaleswe_env_is_a_pinned_single_agent_env() -> None:
    source = (module_dir("short-swe-scaleswe") / "__init__.py").read_text()
    assert "vf.SingleAgentEnv" in source
    assert "pin_agent_identity" in source
    assert "ShortSWEEnv" not in source


def test_pro_tasks_do_not_use_the_swebench_parser() -> None:
    source = (module_dir("short-swe-pro") / "taskset.py").read_text()
    assert "SecureStagingMixin" in source
    assert "run_verifier" not in source


def test_scaleswe_scorer_fails_closed() -> None:
    scorer = (module_dir("short-swe-scaleswe") / "score.py").read_text()
    assert "unlink(missing_ok=True)" in scorer
    assert "SCALESWE_RESULTS_XML" in scorer
    taskset = (module_dir("short-swe-scaleswe") / "taskset.py").read_text()
    assert '"python", "-I"' in taskset
    assert "uuid4" in taskset


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


def test_scaleswe_scorer_awards_only_through_the_fresh_report() -> None:
    scorer = (module_dir("short-swe-scaleswe") / "score.py").read_text()
    assert "if code == 0:" not in scorer
    assert "if code not in (0, 1):" in scorer
    # The only award path parses the fresh JUnit report; skipped and xfailed
    # expected tests are never counted as passes by all_passed.
    assert scorer.count("emit(1.0 if all_passed(xml_content, expected) else 0.0)") == 1
    assert 'if tc.find("skipped") is not None:' in scorer


def test_pro_env_pins_the_isolated_verifier() -> None:
    source = (module_dir("short-swe-pro") / "__init__.py").read_text()
    assert "ISOLATED_VERIFIER = True" in source
    assert "SCORING_SECONDS = 3600.0" in source
    assert "FINALIZE_SECONDS = 3600.0" in source


def test_install_enforces_archive_quotas() -> None:
    harness = (module_dir("short-swe-verified") / "prime_agent_candidate.py").read_text()
    assert "check_archive()" in harness
    assert "-le 20000" in harness
    assert "-le 2147483648" in harness


def test_scaleswe_restore_fails_closed_without_blast_radius() -> None:
    taskset = (module_dir("short-swe-scaleswe") / "taskset.py").read_text()
    # The pre-agent snapshot lives in controller memory; the agent cannot forge it.
    assert "self._pristine[path] = await runtime.read(path)" in taskset
    assert "if pristine is None:" in taskset
    assert "pristine test snapshot missing" in taskset
    # Anything enumerated after the agent but not in the snapshot is planted —
    # including gitignored files the git sweep cannot see — and is deleted.
    assert "if path not in pristine:" in taskset
    assert 'await runtime.run(["/bin/rm", "-f", "--", path], {})' in taskset
    # The restore is proven by hashing the tree back to the snapshot; every failure
    # path scores zero without raising, so tampering cannot award or break the run.
    assert "test verification failed closed" in taskset
    assert "test restoration failed closed" in taskset
    assert '"GIT_NO_REPLACE_OBJECTS": "1"' in taskset
    assert taskset.count("return 0.0") >= 3
    assert "scaleswe setup failed (" in taskset
