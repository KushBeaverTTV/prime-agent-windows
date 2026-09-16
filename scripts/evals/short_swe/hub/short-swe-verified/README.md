# short-swe-verified

the fixed 15-task SWE-bench Verified slice graded in a fresh network-free verifier

Private Short SWE behavioral environment. The fixed repository-stratified slice,
the pinned datasets, and the evaluation limits are package defaults, so hosted runs
cannot drift from the published identity.

The candidate Prime Agent npm tarballs are supplied by the trusted controller at
eval time through `CANDIDATE_TARBALLS_URL`, `CANDIDATE_COMMIT`, and
`CANDIDATE_CHECKSUMS` (with optional `CANDIDATE_TOKEN`); none of these ever reach a
candidate-controlled runtime.
Verified tasks are graded in a separate network-free verifier VM by the offline
SWE-bench grader; verifier output crosses the runtime controller channel only.
