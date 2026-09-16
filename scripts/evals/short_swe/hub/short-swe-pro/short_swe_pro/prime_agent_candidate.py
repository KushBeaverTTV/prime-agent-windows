"""Trusted Verifiers harness for testing local Prime Agent npm artifacts."""

from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

from pydantic import Field, field_validator
from verifiers.v1.acp import ACPHarness
from verifiers.v1.configs.harness import HarnessConfig
from verifiers.v1.harnesses.node import ensure_node
from verifiers.v1.harnesses.prime_agent import PrimeAgentHarness
from verifiers.v1.harnesses.prime_agent.harness import PRIME_AGENT_DIR, SKILLS_DIR
from verifiers.v1.harnesses.utils.install import ensure_installed
from verifiers.v1.interception import server as interception_server
from verifiers.v1.runtimes import Runtime
from verifiers.v1.trace import Trace

from .candidate_contract import (
    TARBALLS,
    VERSION,
    env_checksums,
    fetch_artifacts,
    load_artifacts,
    process_env,
    require_non_autonomous,
    validate_checksums,
)

__all__ = ["PrimeAgentCandidateHarness"]

MAX_MODEL_REQUEST_BYTES = 16_000_000
interception_server.MAX_REQUEST_BODY = MAX_MODEL_REQUEST_BYTES


INSTALL = r"""
set -e
export PATH="/var/tmp/vf-node/bin:$PATH"
prefix="$VF_PRIME_AGENT_DIR/$PRIME_AGENT_COMMIT"
source_dir="$VF_PRIME_AGENT_ARTIFACT_DIR"
trap 'rm -rf "$source_dir"' EXIT
[ -x "$prefix/bin/prime-agent" ] && [ -f "$HOME/.prime/agent/kernel-venv/.bootstrap-version" ] && exit 0
export NPM_CONFIG_PREFIX="$prefix"
export PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=1
agent_tarball="prime-agent-$PRIME_AGENT_RELEASE_VERSION.tgz"
ai_tarball="prime-agent-ai-$PRIME_AGENT_RELEASE_VERSION.tgz"
core_tarball="prime-agent-core-$PRIME_AGENT_RELEASE_VERSION.tgz"
tui_tarball="prime-agent-tui-$PRIME_AGENT_RELEASE_VERSION.tgz"
printf '%s\n' "$VF_PRIME_AGENT_SHA256SUMS" > "$source_dir/SHA256SUMS"
(cd "$source_dir" && sha256sum -c SHA256SUMS)
check_archive() {
    entries=$(tar -tzf "$1" | wc -l)
    [ "$entries" -le 20000 ] || { echo "archive has too many entries: $1"; exit 1; }
    total=$(tar -tvzf "$1" | awk '{ s += $3 } END { printf "%d", s + 0 }')
    [ "$total" -le 2147483648 ] || { echo "archive expands past its quota: $1"; exit 1; }
}
for tarball in "$agent_tarball" "$ai_tarball" "$core_tarball" "$tui_tarball"; do
    check_archive "$source_dir/$tarball"
done
mkdir "$source_dir/core-root" "$source_dir/repacked-core"
tar -xzf "$source_dir/$core_tarball" -C "$source_dir/core-root"
node - \
    "$source_dir/core-root/package/package.json" \
    "$source_dir/$ai_tarball" <<'NODE'
const fs = require("node:fs");
const [manifestPath, ai] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dependencies["@earendil-works/pi-ai"] = `file:${ai}`;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
repacked_core="$(npm pack "$source_dir/core-root/package" \
    --pack-destination "$source_dir/repacked-core" --silent)"

mkdir "$source_dir/package-root"
tar -xzf "$source_dir/$agent_tarball" -C "$source_dir/package-root"
node - \
    "$source_dir/package-root/package/package.json" \
    "$source_dir/$ai_tarball" \
    "$source_dir/repacked-core/$repacked_core" \
    "$source_dir/$tui_tarball" <<'NODE'
const fs = require("node:fs");
const [manifestPath, ai, core, tui] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const [name, file] of [
    ["@earendil-works/pi-ai", ai],
    ["@earendil-works/pi-agent-core", core],
    ["@earendil-works/pi-tui", tui],
]) {
    manifest.dependencies[name] = `file:${file}`;
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
mkdir "$source_dir/repacked"
repacked="$(npm pack "$source_dir/package-root/package" \
    --pack-destination "$source_dir/repacked" --silent)"
PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=1 npm install -g \
    --no-fund --no-audit --loglevel=error --progress=false \
    "$source_dir/repacked/$repacked"
[ -x "$prefix/bin/prime-agent" ]
[ -f "$HOME/.prime/agent/kernel-venv/.bootstrap-version" ]
"""


class PrimeAgentCandidateHarnessConfig(HarnessConfig):
    """The candidate under test, from a trusted local directory or a controller URL.

    Hosted runs resolve the candidate at load time through `CANDIDATE_TARBALLS_URL`,
    `CANDIDATE_COMMIT`, and `CANDIDATE_CHECKSUMS` (with optional `CANDIDATE_TOKEN`);
    those never reach a candidate-controlled runtime.
    """

    artifact_dir: Path | None = None
    commit: str | None = Field(default=None, pattern=r"^[0-9a-f]{40}$")
    checksums: dict[str, str] | None = None
    tarballs_url: str | None = None
    autonomous: bool = False

    @field_validator("autonomous")
    @classmethod
    def reject_autonomous(cls, value: bool) -> bool:
        return require_non_autonomous(value)

    @field_validator("checksums")
    @classmethod
    def check_checksums(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return validate_checksums(value)

    def resolve_candidate(self) -> None:
        """Fill the candidate source, from config fields or the controller environment."""
        if self.artifact_dir is not None:
            if not self.commit:
                raise ValueError("local artifact_dir runs must pin the candidate commit")
            return
        if self.tarballs_url is None:
            self.tarballs_url = os.environ.get("CANDIDATE_TARBALLS_URL")
        if self.commit is None:
            self.commit = os.environ.get("CANDIDATE_COMMIT")
        if self.checksums is None:
            self.checksums = env_checksums()
        if not self.tarballs_url or not self.commit or not self.checksums:
            raise ValueError(
                "hosted candidate needs CANDIDATE_TARBALLS_URL, CANDIDATE_COMMIT, and CANDIDATE_CHECKSUMS"
            )


class PrimeAgentCandidateHarness(PrimeAgentHarness, ACPHarness[PrimeAgentCandidateHarnessConfig]):
    """Prime Agent harness that installs only controller-supplied npm tarballs."""

    config: PrimeAgentCandidateHarnessConfig

    def _load_artifacts(self) -> tuple[dict[str, bytes], dict[str, str]]:
        self.config.resolve_candidate()
        if self.config.artifact_dir is not None:
            return load_artifacts(self.config.artifact_dir, self.config.checksums)
        assert self.config.tarballs_url and self.config.checksums
        return fetch_artifacts(
            self.config.tarballs_url, self.config.checksums, os.environ.get("CANDIDATE_TOKEN")
        )

    async def setup(self, runtime: Runtime) -> None:
        blobs, checksums = self._load_artifacts()
        await self.install_skills(runtime, SKILLS_DIR)
        await ensure_node(runtime)
        upload_dir = f"/tmp/vf-prime-agent-candidate-{uuid4().hex}"
        for name, data in blobs.items():
            await runtime.write(f"{upload_dir}/{name}", data)
        sums = "\n".join(f"{checksums[name]}  {name}" for name in TARBALLS)
        install_env = process_env(self.config.resolved_env)
        await ensure_installed(
            runtime,
            directory=PRIME_AGENT_DIR,
            install=INSTALL,
            env={
                **install_env,
                "VF_PRIME_AGENT_DIR": PRIME_AGENT_DIR,
                "VF_PRIME_AGENT_ARTIFACT_DIR": upload_dir,
                "VF_PRIME_AGENT_SHA256SUMS": sums,
                "PRIME_AGENT_COMMIT": self.config.commit,
                "PRIME_AGENT_RELEASE_VERSION": VERSION,
            },
            label="prime-agent candidate",
        )
        await ACPHarness.setup(self, runtime)

    def _env(self, trace: Trace, secret: str) -> dict[str, str]:
        return process_env(super()._env(trace, secret))
