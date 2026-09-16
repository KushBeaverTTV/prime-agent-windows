"""short-swe-pro — the fixed 8-task SWE-bench Pro slice"""

from .prime_agent_candidate import PrimeAgentCandidateHarness
from .secure_harbor import ShortSWEEnv
from .taskset import ShortSWEProTaskset


class ShortSWEProEnv(ShortSWEEnv):
    """Pro tasks are graded by Harbor's own trusted in-task verifier."""


__all__ = ["ShortSWEProTaskset", "ShortSWEProEnv", "PrimeAgentCandidateHarness"]
