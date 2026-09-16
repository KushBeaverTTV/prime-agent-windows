"""Launch hosted Prime Evals runs for the Short SWE suite and collect their episodes.

The workflow builds the candidate tarballs, uploads them as GitHub Actions
artifacts, and uses this script to launch one hosted evaluation per side and
taskset with the artifact delivered through `custom_secrets`. Each hosted run
executes the private `short-swe-*` Environments Hub packages; their episodes are
pulled back into local `traces.jsonl` files and validated by the same
`evaluate.read_taskset` gates used by the local paired evaluation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent.parent))

HOSTED_ENVIRONMENTS = {
    "swebench-verified": "primeintellect/short-swe-verified",
    "swebench-pro": "primeintellect/short-swe-pro",
    "scaleswe": "primeintellect/short-swe-scaleswe",
}
EVAL_ID_RE = re.compile(r"Evaluation ID: (\S+)")
TERMINAL_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"}


def run(command: list[str], *, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
    )
    if result.returncode:
        raise RuntimeError(f"{command[0]} failed: {result.stdout}\n{result.stderr}")
    return result.stdout


def launch(args: argparse.Namespace) -> None:
    request = json.loads(Path(args.request).read_text())
    manifest = json.loads((ROOT / "short-swe.json").read_text())
    model = args.model or manifest["model"]
    if model not in {manifest["model"], manifest["backup_model"]}:
        raise ValueError(f"model {model!r} is not pinned by the Short SWE manifest")
    sizes = {item["id"]: len(item["tasks"]) for item in manifest["tasksets"]}
    sources = json.loads(Path(args.sources).read_text())
    runs: dict[str, dict] = {}
    logs = Path(args.output) / "launch-logs"
    logs.mkdir(parents=True, exist_ok=True)
    for side in ("base", "head"):
        for taskset_id, environment in HOSTED_ENVIRONMENTS.items():
            source = sources[side]
            secrets = {
                "CANDIDATE_TARBALLS_URL": source["tarballs_url"],
                "CANDIDATE_COMMIT": source["commit"],
                "CANDIDATE_CHECKSUMS": json.dumps(source["checksums"]),
                "CANDIDATE_TOKEN": source.get("token", ""),
            }
            name = f"{request['pr']}-{side}-{taskset_id}-{request['head_sha'][:9]}"
            command = [
                "prime",
                "eval",
                "run",
                environment,
                "--hosted",
                "-m",
                model,
                "-n",
                str(sizes[taskset_id]),
                "-r",
                str(manifest["num_rollouts"]),
                "--max-concurrent",
                str(manifest["max_concurrent"]),
                "--timeout-minutes",
                "1440",
                "--eval-name",
                name,
                "--custom-secrets",
                json.dumps(secrets),
            ]
            log_path = logs / f"{side}-{taskset_id}.log"
            log = log_path.open("w")
            subprocess.Popen(
                command,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
            )
            runs[f"{side}/{taskset_id}"] = {
                "environment": environment,
                "name": name,
                "log": str(log_path),
                "num_examples": sizes[taskset_id],
            }
    (Path(args.output) / "hosted-runs.json").write_text(json.dumps(runs, indent=2))
    # Each launch exits right after the platform assigns an evaluation id.
    deadline = time.time() + 300
    assigned: dict[str, str] = {}
    while len(assigned) < len(runs) and time.time() < deadline:
        for key, record in runs.items():
            if key in assigned:
                continue
            text = Path(record["log"]).read_text(errors="replace")
            match = EVAL_ID_RE.search(text)
            if match:
                assigned[key] = match.group(1)
        time.sleep(5)
    missing = [key for key in runs if key not in assigned]
    if missing:
        for key in missing:
            print(Path(runs[key]["log"]).read_text(errors="replace")[-2000:], file=sys.stderr)
        raise RuntimeError(f"hosted evaluations did not start: {missing}")
    for key, evaluation_id in assigned.items():
        runs[key]["evaluation_id"] = evaluation_id
    (Path(args.output) / "hosted-runs.json").write_text(json.dumps(runs, indent=2))
    print(json.dumps({key: value["evaluation_id"] for key, value in runs.items()}, indent=2))


def wait(args: argparse.Namespace) -> None:
    runs = json.loads((Path(args.output) / "hosted-runs.json").read_text())
    deadline = time.time() + 24 * 3600
    failures = []
    for key, record in runs.items():
        while True:
            if time.time() > deadline:
                raise RuntimeError(f"{key}: hosted evaluation did not finish in 24 hours")
            detail = json.loads(run(["prime", "eval", "get", record["evaluation_id"], "--output", "json"]))
            status = detail.get("status") or detail.get("evaluation", {}).get("status")
            if status in TERMINAL_STATUSES:
                break
            time.sleep(30)
        if status != "COMPLETED":
            failures.append(f"{key}: {status} {detail.get('error_message', '')}")
    if failures:
        raise RuntimeError("; ".join(failures))


def collect(args: argparse.Namespace) -> None:
    runs = json.loads((Path(args.output) / "hosted-runs.json").read_text())
    for key, record in runs.items():
        side, taskset_id = key.split("/", 1)
        target = Path(args.output) / "raw-eval" / side / taskset_id
        target.mkdir(parents=True, exist_ok=True)
        payload = json.loads(run(["prime", "eval", "samples", record["evaluation_id"], "--output", "json"]))
        samples = payload.get("samples") or []
        expected = record.get("num_examples")
        if expected is not None and len(samples) != expected:
            raise RuntimeError(f"{key}: expected {expected} samples, found {len(samples)}")
        episodes = []
        for sample in samples:
            info = sample.get("info") or {}
            native = info.get("native_wrapper")
            if not native:
                raise RuntimeError(f"{key}: sample without a native episode record")
            episodes.append(json.dumps(native))
        (target / "traces.jsonl").write_text("\n".join(episodes) + "\n")
        print(f"{key}: collected {len(episodes)} episodes -> {target}")


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    launch_parser = sub.add_parser("launch")
    launch_parser.add_argument("--request", required=True)
    launch_parser.add_argument("--sources", required=True)
    launch_parser.add_argument("--output", required=True)
    launch_parser.add_argument(
        "--model",
        default=None,
        help="Override the pinned model with its backup when the primary is saturated.",
    )
    launch_parser.set_defaults(func=launch)
    wait_parser = sub.add_parser("wait")
    wait_parser.add_argument("--output", required=True)
    wait_parser.set_defaults(func=wait)
    collect_parser = sub.add_parser("collect")
    collect_parser.add_argument("--output", required=True)
    collect_parser.set_defaults(func=collect)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
