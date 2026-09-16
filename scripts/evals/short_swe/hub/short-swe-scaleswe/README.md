# short-swe-scaleswe

the fixed 5-task Scale-SWE slice

Private Short SWE behavioral environment. The fixed repository-stratified slice,
the pinned datasets, and the evaluation limits are package defaults, so hosted runs
cannot drift from the published identity.

The candidate Prime Agent npm tarballs are supplied by the trusted controller at
eval time through `CANDIDATE_TARBALLS_URL`, `CANDIDATE_COMMIT`, and
`CANDIDATE_CHECKSUMS` (with optional `CANDIDATE_TOKEN`); none of these ever reach a
candidate-controlled runtime.
