"""Pure security checks shared by the Short SWE candidate harness and tests."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import zipfile
from pathlib import Path

import httpx

VERSION = "0.0.0-benchmark"
TARBALLS = tuple(
    f"{name}-{VERSION}.tgz"
    for name in ("prime-agent", "prime-agent-ai", "prime-agent-core", "prime-agent-tui")
)
CREDENTIAL_ENV = (
    "PRIME_API_KEY",
    "PRIME_SANDBOX_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "HF_TOKEN",
    "CANDIDATE_TOKEN",
)
SHA256_RE = re.compile(r"[0-9a-f]{64}")
MAX_CANDIDATE_ZIP_BYTES = 256 * 1024 * 1024


def process_env(env: dict[str, str]) -> dict[str, str]:
    """Override inherited host credential names before a candidate-controlled process starts."""
    return {**env, **dict.fromkeys(CREDENTIAL_ENV, "")}


def require_non_autonomous(value: bool) -> bool:
    if value:
        raise ValueError("candidate harness requires autonomous=false")
    return value


def validate_checksums(value: dict[str, str] | None) -> dict[str, str] | None:
    if value is None:
        return None
    if set(value) != set(TARBALLS) or any(SHA256_RE.fullmatch(digest) is None for digest in value.values()):
        raise ValueError("checksums must name the four tarballs with lowercase SHA256 values")
    return value


def load_artifacts(root: Path, expected: dict[str, str] | None) -> tuple[dict[str, bytes], dict[str, str]]:
    if not root.is_dir():
        raise ValueError(f"artifact_dir is not a directory: {root}")
    names = {path.name for path in root.glob("*.tgz")}
    if names != set(TARBALLS) or any(not (root / name).is_file() for name in TARBALLS):
        raise ValueError("artifact_dir must contain exactly the four candidate tarballs")
    blobs = {name: (root / name).read_bytes() for name in TARBALLS}
    computed = {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()}
    if expected is not None and computed != expected:
        raise ValueError("candidate tarball checksum mismatch")
    return blobs, expected or computed


def fetch_artifacts(
    url: str, expected: dict[str, str], token: str | None
) -> tuple[dict[str, bytes], dict[str, str]]:
    """Download the candidate tarball zip from the controller-supplied URL and verify it.

    Only the trusted eval controller runs this; the tarballs never carry credentials into
    a candidate-controlled runtime, and a checksum mismatch fails closed.
    """
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.Client(follow_redirects=True, timeout=600.0) as client:
        response = client.get(url, headers=headers)
        response.raise_for_status()
        body = response.content
    if len(body) > MAX_CANDIDATE_ZIP_BYTES:
        raise ValueError("candidate tarball download exceeds its size limit")
    blobs: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        for member in archive.infolist():
            name = Path(member.filename).name
            if name in TARBALLS and name not in blobs:
                blobs[name] = archive.read(member)
    if set(blobs) != set(TARBALLS):
        raise ValueError("candidate tarball download did not contain the four tarballs")
    computed = {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()}
    if computed != expected:
        raise ValueError("candidate tarball checksum mismatch")
    return blobs, computed


def env_checksums() -> dict[str, str] | None:
    raw = os.environ.get("CANDIDATE_CHECKSUMS")
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("CANDIDATE_CHECKSUMS must be a JSON object") from None
    if not isinstance(value, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()
    ):
        raise ValueError("CANDIDATE_CHECKSUMS must map tarball names to SHA256 strings")
    return value
