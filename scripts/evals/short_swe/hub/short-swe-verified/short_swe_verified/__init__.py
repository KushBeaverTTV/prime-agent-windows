"""short-swe-verified — the fixed 15-task SWE-bench Verified slice graded in a fresh network-free verifier"""

from .prime_agent_candidate import PrimeAgentCandidateHarness
from .secure_harbor import ShortSWEEnv
from .taskset import ShortSWEVerifiedTaskset


class ShortSWEVerifiedEnv(ShortSWEEnv):
    ISOLATED_VERIFIER = True
    SCORING_SECONDS = 3600.0
    FINALIZE_SECONDS = 3600.0


__all__ = ["ShortSWEVerifiedTaskset", "ShortSWEVerifiedEnv", "PrimeAgentCandidateHarness"]
