"""short-swe-verified — the fixed 15-task SWE-bench Verified slice on Harbor.

A thin wrapper over the `harbor` taskset pinned to the `swe-bench/swe-bench-verified`
Harbor Hub dataset, graded in a fresh, network-free verifier sandbox whose bounded
output is parsed by the trusted offline SWE-bench grader. The fixed repository-
stratified slice is the package default, so hosted runs cannot drift from the
published Short SWE identity.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Literal

import verifiers.v1 as vf
from pydantic import Field
from verifiers.v1.tasksets.harbor import HarborConfig, HarborTaskset
from verifiers.v1.tasksets.harbor.taskset import CollectHook, VerifierConfig
from verifiers.v1.utils.artifacts import Artifact

from .secure_harbor import CredentialFreeHarborTask, SecureVerifiedMixin
from .verified_verifier import patch_collect_command

FIXED_TASKS = (
    "astropy__astropy-12907",
    "django__django-16642",
    "django__django-14034",
    "matplotlib__matplotlib-26342",
    "mwaskom__seaborn-3187",
    "pallets__flask-5014",
    "psf__requests-5414",
    "pydata__xarray-6992",
    "pylint-dev__pylint-8898",
    "pytest-dev__pytest-7205",
    "scikit-learn__scikit-learn-14629",
    "sphinx-doc__sphinx-7462",
    "sphinx-doc__sphinx-11445",
    "sympy__sympy-16450",
    "sympy__sympy-22914",
)


class ShortSWEVerifiedTask(SecureVerifiedMixin, CredentialFreeHarborTask):
    pass


class ShortSWEVerifiedConfig(HarborConfig):
    dataset: Literal[
        "swe-bench/swe-bench-verified@sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341"
    ] = "swe-bench/swe-bench-verified@sha256:b934b0cc3dc800fe945eaf9f1623329db97ee3133c706d20644524c7759fb341"
    tasks: list[str] = Field(default_factory=lambda: list(FIXED_TASKS))
    ignore_dockerfile: bool = True


def from_image(task_dir: Path) -> str:
    """The image a task's Dockerfile builds on (`FROM swebench/sweb.eval.*`)."""
    for line in (task_dir / "environment" / "Dockerfile").read_text().splitlines():
        if line.strip().upper().startswith("FROM "):
            return line.split(None, 1)[1].strip()
    raise ValueError(f"{task_dir.name}: no FROM in environment/Dockerfile")


class ShortSWEVerifiedTaskset(HarborTaskset, vf.Taskset[ShortSWEVerifiedTask, ShortSWEVerifiedConfig]):
    def load(self) -> Iterator[ShortSWEVerifiedTask]:
        for task in super().load():
            image = from_image(Path(task.data.task_dir))
            if task.data.artifacts or task.data.collect or task.data.verifier is not None:
                raise ValueError(f"{task.data.name}: unexpected verifier transfer configuration")
            data = task.data.model_copy(
                update={
                    "image": image,
                    "workdir": "/testbed",
                    "artifacts": [Artifact(source="/tmp/prime-agent.patch")],
                    "collect": [CollectHook(command=patch_collect_command(Path(task.data.task_dir)))],
                    "verifier": VerifierConfig(fresh_copy=True, network_allow=[]),
                }
            )
            yield ShortSWEVerifiedTask(data, task.config)
