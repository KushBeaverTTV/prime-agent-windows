"""short-swe-pro — the fixed 8-task SWE-bench Pro slice"""

from .prime_agent_candidate import PrimeAgentCandidateHarness
from .secure_harbor import ShortSWEEnv
from .taskset import ShortSWEProTaskset


class ShortSWEProEnv(ShortSWEEnv):
    """Pro tasks grade in a fresh, network-free verifier box like Verified ones."""

    ISOLATED_VERIFIER = True
    SCORING_SECONDS = 3600.0
    FINALIZE_SECONDS = 3600.0


__all__ = ["ShortSWEProTaskset", "ShortSWEProEnv", "PrimeAgentCandidateHarness"]
