# Paired benchmark accuracy plan

This is the remaining measurement work, separate from the implemented cancellation and retry fixes.
Those lifecycle fixes do not make the existing two-sandbox comparisons causal measurements.

## Evidence from the September 13 reports

[PR #2194 run 34741185979](https://github.com/PrimeIntellect-ai/prime-agent/actions/runs/34741185979)
and [PR #2250 run 34741186152](https://github.com/PrimeIntellect-ai/prime-agent/actions/runs/34741186152)
both completed all measurements using main and harness `878410b3981f20c6d685faa210ad0e43426cf483`
with identical configuration. Their PR heads were `8edf23ef7b10b19b99029f27f1ef30c748f15057` and
`012bc3e9f359880e5469c28ec79a9da5f7861c45`. The entire `prime-agent-runtime` tree has the same Git
object ID, `a5a821686cb4d4f3f8e8464e206024f96df20976`, in all three source revisions.

The baseline medians themselves differ substantially between runs:

| Metric | Main in #2194 run | Main in #2250 run | Difference |
| --- | ---: | ---: | ---: |
| Cold input readiness | 1.241 s | 1.723 s | +38.89% |
| Warm input readiness | 0.749 s | 1.027 s | +37.06% |
| Python kernel startup | 112.588 ms | 158.589 ms | +40.86% |
| Python cell round trip | 0.492 ms | 0.706 ms | +43.53% |
| Empty bash | 10.151 ms | 15.120 ms | +48.96% |
| Bash git status | 14.914 ms | 23.868 ms | +60.04% |

These are descriptive cross-run differences for identical source, not estimates of a code effect.
The #2194 PR-side medians are often closer to the #2250 baseline than to their own baseline.
Persistent environment differences are plausible, but host scheduling, CPU characteristics, build
variation, installation differences, and timing order were not independently controlled. CPU is
reported as `unknown`. All four sides report Python 3.11.16 and compiled installations, but the saved
npm inventories contain ENOENT errors for the absent npm installation directory, and do not establish
installed Python dependency or content identity. Identical source trees are insufficient to prove
identical installed environments. Even the identical main native archives differ by 7,485 bytes.

The current controller permanently assigns one revision to each sandbox. Alternating trial order
controls some time drift, but cannot distinguish a persistent sandbox effect from a revision effect.
Ten trials in one sandbox are not ten independent environments. Increasing the 20% threshold would
hide some symptoms without fixing that confounding. Preserve the observed differences and uncertainty.

## One consolidated follow-up

Integrate the preserved paired implementation onto the current harness in this benchmark branch;
do not overwrite the current controller or worker with the older branch wholesale. Preserve compiled
release selection, input/render/erase readiness, bounded terminal writes, incomplete-result failures,
per-phase failure limits, session cleanup handling, unique logs, and separate operational warnings.

1. Put both exact revisions in each of six independently allocated environments, with isolated users,
   build directories, installations, caches, and ports. Counterbalance build/lane assignment between
   environments and alternate adjacent measurement order. Stop owned processes between cold trials;
   retain only the intended same-lane daemon for warm trials. Do not run competing timed lanes together.
2. Record environment, lane, revision, phase, trial, and order for every observation. Match each trial
   with its counterpart inside its environment. Give environments equal weight; do not pool 60 trial
   pairs as independent hosts. Report paired effect estimates, between-environment variation, and
   uncertainty using the environment as the resampling unit. Missing pairs remain incomplete.
3. Freeze source, harness, configuration, and build inputs. Hash actual native and npm artifacts and
   installed runtime contents, capture Python package inventories, and verify that the selected compiled
   executable belongs to the intended revision. Keep artifact/build variation visible separately from
   runtime variation; make no attribution based only on equal version strings or equal archive sizes.
4. Adapt the already tested bounded diagnostic collector, preserving current per-trial diagnostics and
   warnings. Record collection limits explicitly rather than silently applying the inherited 1,000-file
   cap. Reserve the full sandbox TTL before allocation and bound transfers, retries, and teardown. At
   the current configured rates, six 30-minute reservations total $0.90 within the $1 estimate; validate
   this against the actual configuration before admitting work.
5. Locally test the integrated lifecycle, protocol readiness, paired indexing, incomplete lanes,
   counterbalancing, installed-content mismatch, diagnostic limits, and cost admission. Include synthetic
   fixtures with large per-environment speed differences and zero revision effect, plus injected revision
   slowdowns and missing measurements. Keep the existing retry and cancellation regressions.
6. Obtain independent review of the full combined diff before publication. Any separately authorized
   live validation should pin the final harness and configuration, start with A/A, then compare an
   unchanged-source control. Predeclare the number of environments, repetitions, budget, and decision
   criteria; do not retry until a desired classification appears. One A/A comparison does not establish
   a reliable small-effect noise floor. Historical validations of the older harness do not validate this
   integration. No new live validation is authorized or performed by this plan.

Keep this work in one benchmark PR where practical. Until the paired integration and calibration are
complete, the current report's regression labels remain screening signals requiring investigation,
not proof that these refactors slowed the unchanged Python runtime.
