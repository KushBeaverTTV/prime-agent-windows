"""short-swe-scaleswe — the fixed 5-task Scale-SWE slice"""

import verifiers.v1 as vf

from .prime_agent_candidate import PrimeAgentCandidateHarness
from .secure_harbor import pin_agent_identity
from .taskset import ShortSWEScalesweTaskset


class ShortSWEScalesweEnv(vf.SingleAgentEnv):
    """Scale-SWE tasks are plain tasks, not Harbor tasks; they run and score inside
    the agent's own task runtime, so the env is a single-agent env that pins the
    shared Short SWE evaluation identity (limits, rollout deadline, network-free
    runtime)."""

    def __init__(self, config) -> None:
        super().__init__(pin_agent_identity(config))


__all__ = ["ShortSWEScalesweTaskset", "ShortSWEScalesweEnv", "PrimeAgentCandidateHarness"]
