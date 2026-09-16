"""short-swe-scaleswe — the fixed 5-task Scale-SWE slice"""

from .prime_agent_candidate import PrimeAgentCandidateHarness
from .secure_harbor import ShortSWEEnv
from .taskset import ShortSWEScalesweTaskset


class ShortSWEScalesweEnv(ShortSWEEnv):
    """Scale-SWE tasks run and score inside the agent's own task runtime."""


__all__ = ["ShortSWEScalesweTaskset", "ShortSWEScalesweEnv", "PrimeAgentCandidateHarness"]
