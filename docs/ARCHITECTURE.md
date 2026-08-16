# Architecture and implementation status

The package retains the original three-plane design.

## Execution / control plane

Implemented in `0.0.1`:

- fixed artifact assignment for a long-lived playbook run;
- approved named playbooks started as self-contained workflows with `/playbook run <name>`, with an optional request to refine their scope;
- trusted project candidates resolved by contract or directory name, sealed into immutable snapshots, and run without promotion or an additional request;
- ad hoc governed runs created interactively with `/playbook` or explicitly with `/playbook run <name> <request>`, without a pre-existing procedure or skill;
- a mandatory user-selected name collected before assignment, with no hidden or temporary playbook records;
- personal-over-team deterministic resolution;
- no implicit applicability conflict winner;
- content verification before prompt injection and tool authorization, including re-derivation of contract and procedure metadata from hashed content;
- run-artifact containment checks that reject symbolic-link escapes from the assigned working directory;
- required-tool fingerprint attestation;
- declared effect classes;
- one-action approval for selected high-risk operations;
- workflow approval gates;
- a non-terminal review state that keeps the pinned playbook and policy active for follow-up questions and changes until explicit user closure;
- PROPOSED, AUTHORIZED, BLOCKED, USER_REJECTED, SUCCEEDED, and FAILED facts;
- explicit scope statement for observed and unmediated effects.

The extension's guarded governance tools record their own STARTED facts. Pi's public event sequence does not expose a post-all-handlers/pre-built-in-effect hook, so built-in tool calls are truthfully classified as observed rather than guarded.

## Learning / evidence plane

Implemented foundations:

- append-only, fsync-backed JSONL fact ledger separate from Pi's raw trace;
- run, assignment, branch-entry, action, artifact, argument-hash, policy-version, and enforcement provenance;
- negative-path facts;
- deterministic artifact hashes and completion predicates;
- agent-assisted revision workspaces derived from completed runs;
- extraction of specifically named reusable candidates from ad hoc trajectories when evidence supports reuse;
- draft-time extraction of run-bounded bash command/outcome summaries from Pi-owned session traces, with outputs omitted and likely inline credentials redacted;
- evidence-gated identification of either a consolidated deterministic command or a maintainable helper-script opportunity, without generating speculative automation;
- optional skill dependencies that may be introduced in later candidates without mutating installed skills;
- candidate proposals carrying an exact base digest, evidence run IDs, and evidence watermark;
- equivalent-proposal suppression and stale-lineage classification;
- no causal claims from ordinary executions.

Candidate extraction is intentionally agent-assisted in `0.0.1`: `/playbook draft` supplies a minimized run trajectory and an editable copy of the sealed base. It also transiently summarizes bash commands observed during the run, grouped with success/failure counts. Raw command output and non-command arguments are excluded, likely inline credentials are redacted, and raw commands are not added to the fact ledger. The drafting instructions may preserve a consolidated command or add a helper script only when this execution evidence supports the optimization; a successful observation is not treated as a causal or universal claim.

The workspace stores local base/run provenance so `/playbook propose <candidate-directory>` does not require internal digests or run identifiers; a unique playbook name is also accepted. That provenance is excluded from the sealed artifact. The resulting proposal record has no trial, activation, or promotion authority.

## Release / governance plane

Implemented personal/local path:

- schema validation;
- immutable content-addressed sealing;
- artifact re-hashing;
- stable registry pointer;
- manual bootstrap promotion;
- proposal-required updates after bootstrap;
- stale-base rejection before promotion;
- manual proposal rejection and promotion;
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
