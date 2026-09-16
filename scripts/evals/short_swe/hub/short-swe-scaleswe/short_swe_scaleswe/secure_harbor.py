"""Harbor environment that preserves specialized tasks in a separate verifier."""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import ClassVar

import verifiers.v1 as vf
from verifiers.v1.runtimes import Runtime
from verifiers.v1.runtimes.prime import PrimeConfig
from verifiers.v1.tasksets.harbor import HarborEnv, HarborEnvConfig, HarborTask
from verifiers.v1.tasksets.harbor.taskset import resolve_env, verifier_box_data

from .offline_swebench_grader import grade
from .verified_verifier import rewrite_test_script, trusted_base_commit

logger = logging.getLogger(__name__)

STRIPPED_RUNTIME_ENV = (
    "PRIME_API_KEY",
    "PRIME_SANDBOX_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "HF_TOKEN",
    "CANDIDATE_TOKEN",
)

PINNED_LIMITS = {
    "max_turns": 128,
    "max_output_tokens": 100_000,
    "max_total_tokens": 5_000_000,
}
ROLLOUT_SECONDS = 3_600.0


class CredentialFreeHarborTask(HarborTask):
    """Harbor task whose runtime environment never receives controller credentials."""

    def runtime_env(self) -> dict[str, str]:
        env = resolve_env(self.data.env)
        for name in STRIPPED_RUNTIME_ENV:
            env.pop(name, None)
        return env


class SecureVerifiedMixin:
    async def setup(self, runtime: Runtime) -> None:
        await super().setup(runtime)
        if not self.data.name.endswith(" (verifier)"):
            return
        base = trusted_base_commit(Path(self.data.task_dir))
        result = await runtime.run(
            ["sh", "-c", f"git reset --hard {base} && git clean -fd"],
            {},
        )
        if result.exit_code:
            detail = (result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeError(f"could not reset SWE-bench verifier to its trusted base: {detail}")

    async def stage_verifier(self, trace: vf.Trace, runtime: Runtime) -> None:
        await super().stage_verifier(trace, runtime)
        result = await runtime.run(
            ["sh", "-c", "test ! -s /tmp/prime-agent.patch || git apply --binary /tmp/prime-agent.patch"],
            {},
        )
        if result.exit_code:
            detail = (result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeError(f"candidate patch did not apply in verifier: {detail}")

    async def run_verifier(self, runtime: Runtime, trace: vf.Trace) -> float:
        script = rewrite_test_script((await runtime.read("/tests/test.sh", max_bytes=2_000_000)).decode())
        await runtime.write("/tests/test.sh", script.encode())
        removed = await runtime.run(
            ["rm", "-f", "/tests/config.json", "/tmp/tests.tgz"],
            {},
        )
        if removed.exit_code:
            raise RuntimeError("could not remove verifier-only metadata before tests")
        result = await runtime.run(
            [
                "bash",
                "-c",
                "set -o pipefail; bash /tests/test.sh 2>&1 | head -c 16000001",
            ],
            {"PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_INDEX": "1"},
        )
        log = result.stdout
        try:
            if len(log.encode()) > 16_000_000:
                raise ValueError("verifier output exceeds its size limit")
            config = json.loads((Path(self.data.task_dir) / "tests" / "config.json").read_text())
            instance = config["instance_id"]
            record = grade(config, log)[instance]
            resolved = record["resolved"]
            if not isinstance(resolved, bool) or result.exit_code not in (0, 1):
                raise ValueError("inconsistent verifier result")
        except (KeyError, OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as exc:
            detail = (log or result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeError(f"SWE-bench verifier failed closed: {detail}") from exc
        trace.info["swebench_verifier"] = record
        trace.info["swebench_verifier_log_tail"] = log[-100_000:]
        return float(resolved)


class SecureHarborConfig(HarborEnvConfig):
    pass


class SecureHarbor(HarborEnv):
    async def finalize(self, task: vf.Task, episode: vf.Episode) -> None:
        if not isinstance(task, HarborTask) or task.data.verifier is None:
            return
        solution = episode.traces[0]
        if not solution.ok:
            return
        artifacts = solution.state.artifacts
        expected = {"/logs/artifacts", "/tmp/prime-agent.patch"}
        if set(artifacts) != expected or artifacts["/logs/artifacts"] is not None:
            raise RuntimeError("solver produced undeclared verifier artifacts")
        grader = type(task)(verifier_box_data(task.data), task.config)
        started = time.monotonic()
        scores, solution = await self.grade(
            self.verifier_config(task),
            grader,
            solution,
            scoring_timeout_covers_attempt=True,
        )
        solution.info["isolated_verifier_seconds"] = time.monotonic() - started
        items = scores.items() if isinstance(scores, dict) else [("solved", scores)]
        for name, value in items:
            solution.record_reward(name, value)
        episode.traces[0] = solution


class ShortSWEEnv(SecureHarbor):
    """Secure Harbor with the pinned Short SWE evaluation identity.

    Hosted runs build configs without the release TOML, so any limit the caller leaves
    unset is pinned to the published identity; explicit values stay for trusted local
    controls, and every trace records the resolved identity for gate validation.
    """

    ISOLATED_VERIFIER: ClassVar[bool] = False
    SCORING_SECONDS: ClassVar[float | None] = None
    FINALIZE_SECONDS: ClassVar[float | None] = None

    def __init__(self, config: SecureHarborConfig) -> None:
        super().__init__(self._pin(config))

    def _labels(self, role: str) -> list[str]:
        evaluation = os.environ.get("EVALUATION_ID") or "local"
        return ["prime-agent-behavioral-v1", f"evaluation:{evaluation}", f"role:{role}"]

    def _pin_runtime(self, runtime, role: str):
        if not isinstance(runtime, PrimeConfig):
            raise ValueError(f"short-swe {role} runtime must be a prime sandbox")
        if runtime.allow == ["*"] or runtime.allow is None:
            # The AgentConfig default grants egress; the published identity is network-free.
            return PrimeConfig(allow=[], vm=True, labels=runtime.labels or self._labels(role))
        if runtime.allow != []:
            raise ValueError(f"short-swe {role} runtime must be network-free (allow=[])")
        return runtime.model_copy(update={"vm": True})

    def _pin(self, config: SecureHarborConfig) -> SecureHarborConfig:
        agent = config.agent
        updates: dict = {}
        for field, value in PINNED_LIMITS.items():
            current = getattr(agent, field)
            if current is None:
                updates[field] = value
            elif current != value:
                logger.warning("short-swe: agent %s=%s differs from the pinned identity", field, current)
        timeout_updates: dict = {}
        if agent.timeout.rollout is None:
            timeout_updates["rollout"] = ROLLOUT_SECONDS
        elif agent.timeout.rollout != ROLLOUT_SECONDS:
            logger.warning(
                "short-swe: rollout timeout %s differs from the pinned identity",
                agent.timeout.rollout,
            )
        if self.SCORING_SECONDS is not None and agent.timeout.scoring is None:
            timeout_updates["scoring"] = self.SCORING_SECONDS
        if timeout_updates:
            updates["timeout"] = agent.timeout.model_copy(update=timeout_updates)
        updates["runtime"] = self._pin_runtime(agent.runtime, "task")
        agent = agent.model_copy(update=updates)

        env_updates: dict = {"agent": agent}
        if self.FINALIZE_SECONDS is not None and config.timeout.finalize is None:
            env_updates["timeout"] = config.timeout.model_copy(update={"finalize": self.FINALIZE_SECONDS})
        if self.ISOLATED_VERIFIER:
            verifier = config.verifier
            if verifier.retries not in (0, 2):
                raise ValueError("short-swe verifier retries must be 0")
            if verifier.runtime is None:
                runtime = PrimeConfig(allow=[], vm=True, labels=self._labels("verifier"))
            else:
                runtime = self._pin_runtime(verifier.runtime, "verifier")
            env_updates["verifier"] = verifier.model_copy(update={"retries": 0, "runtime": runtime})
        return config.model_copy(update=env_updates)
