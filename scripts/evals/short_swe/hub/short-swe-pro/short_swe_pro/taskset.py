"""short-swe-pro — the fixed 8-task SWE-bench Pro slice on Harbor.

A thin wrapper over the `harbor` taskset pinned to the `scale-ai/swe-bench-pro`
dataset. Tasks declare no pullable image; the matching prebuilt SWEAP image tag
lives in each task's test config, so `load` resolves it to the public Docker Hub
image. The fixed one-task-per-repository slice is the package default.
"""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Literal

import verifiers.v1 as vf
from pydantic import Field
from verifiers.v1.tasksets.harbor import HarborConfig, HarborTaskset
from verifiers.v1.tasksets.harbor.taskset import CollectHook, VerifierConfig
from verifiers.v1.utils.artifacts import Artifact

from .secure_harbor import CredentialFreeHarborTask, SecureStagingMixin
from .verified_verifier import patch_collect_command

IMAGE_REPO = "jefzda/sweap-images"

FIXED_TASKS = (
    "instance_element-hq__element-web-33e8edb3d508d6eefb354819ca693b7accc695e7",
    "instance_internetarchive__openlibrary-111347e9583372e8ef91c82e0612ea437ae3a9c9-v2d9a6c849c60ed19fd0858ce9e40b7cc8e097e59",
    "instance_qutebrowser__qutebrowser-44e64199ed38003253f0296badd4a447645067b6-v2ef375ac784985212b1805e1d0431dc8f1b3c171",
    "instance_nodebb__nodebb-0f788b8eaa4bba3c142d171fd941d015c53b65fc-v0ec6d6c2baf3cb4797482ce4829bc25cd5716649",
    "instance_ansible__ansible-a6e671db25381ed111bbad0ab3e7d97366395d05-v0f01c69f1e2528b935359cfe578530722bca2c59",
    "instance_gravitational__teleport-0ecf31de0e98b272a6a2610abe1bbedd379a38a3-vce94f93ad1030e3136852817f2423c1b3ac37bc4",
    "instance_navidrome__navidrome-8383527aaba1ae8fa9765e995a71a86c129ef626",
    "instance_tutao__tutanota-09c2776c0fce3db5c6e18da92b5a45dce9f013aa-vbc0d9ba8f0071fbe982809910959a6ff8884dbbf",
)


class ShortSWEProTask(SecureStagingMixin, CredentialFreeHarborTask):
    """Graded in a fresh, network-free verifier box the candidate never touched."""


class ShortSWEProConfig(HarborConfig):
    dataset: Literal[
        "scale-ai/swe-bench-pro@sha256:88411d32ff27e53a4c1a7e29f0c2aeba180c8e5d60f221cab5ed56325f33549d"
    ] = "scale-ai/swe-bench-pro@sha256:88411d32ff27e53a4c1a7e29f0c2aeba180c8e5d60f221cab5ed56325f33549d"
    tasks: list[str] = Field(default_factory=lambda: list(FIXED_TASKS))
    ignore_dockerfile: bool = True


class ShortSWEProTaskset(HarborTaskset, vf.Taskset[ShortSWEProTask, ShortSWEProConfig]):
    def load(self) -> Iterator[ShortSWEProTask]:
        for task in super().load():
            task_dir = Path(task.data.task_dir)
            if task.data.artifacts or task.data.collect or task.data.verifier is not None:
                raise ValueError(f"{task.data.name}: unexpected verifier transfer configuration")
            config = json.loads((task_dir / "tests" / "config.json").read_text())
            image = f"{IMAGE_REPO}:{config['dockerhub_tag']}"
            data = task.data.model_copy(
                update={
                    "image": image,
                    "workdir": "/app",
                    "artifacts": [Artifact(source="/tmp/prime-agent.patch")],
                    "collect": [CollectHook(command=patch_collect_command(task_dir))],
                    "verifier": VerifierConfig(fresh_copy=True, network_allow=[]),
                }
            )
            yield ShortSWEProTask(data, task.config)
