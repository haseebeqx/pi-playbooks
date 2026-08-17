# Architecture and implementation status

The package retains the original three-plane design.

## Execution / control plane

Implemented in `0.0.1`:

- fixed artifact assignment for a long-lived runbook run;
- approved named runbooks started as self-contained workflows with `/runbook run <name>`, with an optional request to refine their scope;
- trusted project candidates resolved by contract or directory name, sealed into immutable snapshots, and run without promotion or an additional request;
- ad hoc governed runs created interactively with `/runbook` or `/runbook run <name>`, which prompts for a missing request, or explicitly with `/runbook run <name> <request>`, without a pre-existing procedure or skill;
- a mandatory user-selected name collected before assignment, with no hidden or temporary runbook records;
- personal-over-team deterministic resolution;
- no implicit applicability conflict winner;
- content verification before prompt injection and tool authorization, including re-derivation of contract and procedure metadata from hashed content;
- run-artifact containment checks that reject symbolic-link escapes from the assigned working directory;
- required-tool fingerprint attestation;
- declared effect classes;
- one-action approval for selected high-risk operations;
- workflow approval gates;
- a non-terminal review state that keeps the pinned runbook and policy active for follow-up questions and changes until explicit user closure;
- PROPOSED, AUTHORIZED, BLOCKED, USER_REJECTED, SUCCEEDED, and FAILED facts;
- explicit scope statement for observed and unmediated effects.

The extension's guarded governance tools record their own STARTED facts. Pi's public event sequence does not expose a post-all-handlers/pre-built-in-effect hook, so built-in tool calls are truthfully classified as observed rather than guarded.

## Learning / evidence plane

Implemented foundations:

- append-only, fsync-backed JSONL fact ledger separate from Pi's raw trace;
- run, assignment, branch-entry, action, artifact, argument-hash, policy-version, and enforcement provenance;
- negative-path facts;
- deterministic artifact hashes and completion predicates;
- automatic agent-assisted learning after the user closes a reviewed run;
- isolated revision workspaces derived from completed runs without requiring users to manage directories or identifiers;
- an explicit `propose` or `no_change` learning verdict;
- extraction of specifically named reusable candidates from ad hoc trajectories when evidence supports reuse;
- draft-time extraction of run-bounded bash command/outcome summaries from Pi-owned session traces, with outputs omitted and likely inline credentials redacted;
- evidence-gated identification of either a consolidated deterministic command or a maintainable helper-script opportunity, without generating speculative automation;
- optional skill dependencies that may be introduced in later candidates without mutating installed skills;
- candidate proposals carrying an exact base digest, evidence run IDs, and evidence watermark;
- equivalent-proposal suppression and stale-lineage classification;
- automatic handoff of supported candidates to deterministic release evaluation;
- no causal claims from ordinary executions.

Candidate extraction is intentionally agent-assisted: closing a reviewed run automatically supplies a minimized trajectory and an editable copy of the sealed base to the learning turn. Manual `/runbook draft` remains available as an advanced fallback. Learning also transiently summarizes bash commands observed during the run, grouped with success/failure counts. Raw command output and non-command arguments are excluded, likely inline credentials are redacted, and raw commands are not added to the fact ledger. The learning instructions may preserve a consolidated command or add a helper script only when this execution evidence supports the optimization; a successful observation is not treated as a causal or universal claim.

The workspace stores local base/run provenance and whether the workflow is automatic or manual. This metadata is excluded from the sealed artifact. Automatic learning submits its candidate through `runbook_complete_learning`; manual `/runbook propose` remains available without requiring users to supply internal digests. A proposal has no activation authority: deterministic checks and explicit human approval occur before the personal release pointer changes.

## Release / governance plane

Implemented personal/local path:

- schema validation;
- immutable content-addressed sealing;
- artifact re-hashing;
- deterministic candidate checks for terminal evidence, exact base lineage, stable identity, an updated source version, a retained procedure, and material content changes;
- automatic proposal creation from the learning plane;
- a single human-reviewed approval dialog showing the candidate summary and changed files;
- stable registry pointer;
- automatic personal promotion only after that explicit approval;
- manual bootstrap, draft, proposal, rejection, and promotion commands retained as advanced controls;
- stale-base rejection immediately before promotion;
- rollback for future runs without changing active assignments;
- base digest retained on every run.

Planned without changing plane ownership:

- deterministic fixture evaluator;
- candidate quarantine and suppression;
- signed manifests for artifacts crossing a real trust boundary;
- release-owned candidate/baseline exposure allocation;
- emergency allocation stop;
- personal trial reports;
- team minimization, privacy review, trial, and promotion.

## Trust boundary

The Pi session tree and raw conversation remain Pi-owned. The package owns sealed artifacts, release pointers, run records, and minimized facts. Plugin-only enforcement does not constrain arbitrary code in co-resident extensions with equal OS privileges.
