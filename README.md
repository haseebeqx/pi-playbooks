# Pi Playbooks

Pi Playbooks is a [Pi](https://pi.dev) extension for running repeatable work as **versioned, governed workflows**.

A playbook can be a simple checklist or a multi-stage procedure with scripts, references, output requirements, approval gates, and optional [Agent Skills](https://agentskills.io/). Pi Playbooks pins every run to an immutable snapshot, records what happened, and lets Pi prepare improvements in an isolated workspace. Nothing is activated until you explicitly approve it.

```text
Run work → review the result → close the run → automatic learning → approve or reject a verified update
```

> [!IMPORTANT]
> Pi Playbooks is governance around Pi tools, not an OS sandbox. Extensions run with your normal system permissions. Review this extension and every playbook you install.

## Contents

- [Requirements and installation](#requirements-and-installation)
- [Quick start](#quick-start)
- [How the lifecycle works](#how-the-lifecycle-works)
- [Command reference](#command-reference)
- [Create a playbook](#create-a-playbook)
- [Playbook contract](#playbook-contract)
- [Approval and review behavior](#approval-and-review-behavior)
- [Automatic and project playbooks](#automatic-and-project-playbooks)
- [Storage and trust](#storage-and-trust)
- [Safety model and limitations](#safety-model-and-limitations)
- [Development](#development)

## Requirements and installation

- Node.js **22.19.0 or newer**
- A current Pi installation (developed and tested against Pi `0.84.2`)

Install directly from this repository:

```sh
git clone https://github.com/haseebeqx/pi-playbooks.git
pi install ./pi-playbooks
```

You can also install an existing checkout or the Git repository directly:

```sh
pi install /absolute/path/to/pi-playbooks
pi install git:github.com/haseebeqx/pi-playbooks
```

When the package is available from npm:

```sh
pi install npm:pi-playbooks@0.0.1
```

Restart Pi after installation if it is already running. For a one-off local test without installing, run this from the repository root:

```sh
pi -e ./extensions/playbooks.ts
```

Useful Pi package commands:

```sh
pi list
pi update --extensions
pi remove npm:pi-playbooks
```

Local and Git source identifiers should be passed to `remove` in the same form in which they were installed.

## Quick start

### Start without writing a playbook

In Pi, run:

```text
/playbook
```

Pi asks for:

1. the work you want done;
2. a lowercase, hyphenated playbook name such as `release-check`.

Or provide both directly:

```text
/playbook run release-check Check whether this repository is ready for release
```

If `release-check` is already approved, that version is used. An approved playbook whose procedure fully defines its work can run without an additional request:

```text
/playbook run release-check
```

An optional request can refine the run. A matching local candidate under `.pi/playbooks/candidates/` also runs without a request: Pi seals its current contents and pins the run to that immutable snapshot without promoting it. If neither an approved release nor a local candidate matches the name, Pi explains that the run can become a reproducible workflow, then asks what you want it to do in interactive modes (or requires the request inline in non-interactive modes). It creates a protected ad hoc workflow under that name, and you can continue giving instructions and feedback until you review and close the run. An ad hoc workflow is governed and recorded, but is **not** automatically reusable or approved.

Only one playbook run can be attached to a Pi session at a time. `/playbook` shows the current run instead of starting another when one is active.

### Review and close the result

When Pi calls `playbook_finish`, the run enters `review` rather than closing. You can ask questions or request changes normally; the same pinned playbook and policy remain active.

When satisfied:

```text
/playbook close
```

Closing starts the learning workflow automatically. Pi analyzes the minimized evidence, edits an isolated candidate only when a material improvement is supported, seals it, and runs deterministic release checks. If the candidate passes, you receive one meaningful decision: approve it for future runs or reject it. You do not need to manage candidate directories, run IDs, proposal IDs, or digests.

### Turn the run into a reusable playbook

For an ad hoc run, the same automatic learning flow extracts a reusable procedure when the evidence supports one. For an approved playbook, it proposes the smallest supported revision. If there is no safe material improvement, Pi records that outcome and removes the temporary workspace without interrupting you.

The lower-level `draft`, `propose`, `promote`, and `reject` commands remain available as advanced recovery and externally prepared-candidate controls; they are not the normal user journey.

## How the lifecycle works

### 1. Seal

`seal` validates a source directory and copies it into immutable, content-addressed storage. The resulting SHA-256 digest identifies the exact file set. Symlinks and files outside the bundle are rejected.

### 2. Promote

The first release of a playbook can be bootstrapped directly from its sealed digest. Later updates to an already approved name must come through a proposal with the current release as its base.

### 3. Run

A run stores its playbook digest, working directory, original request, session, required-tool fingerprints, and a unique run/assignment ID. The digest remains fixed even if a newer version is promoted while the run is in progress.

### 4. Checkpoint and gate

The model-facing `playbook_checkpoint` tool records a stage, summary, optional output hashes, and an optional workflow approval gate. A gate pauses later tool effects until the user approves or requests revisions.

### 5. Finish and review

`playbook_finish` evaluates deterministic success predicates. A successful result is rejected if any predicate fails. A valid outcome enters `review`, where follow-up work remains governed.

### 6. Close and learn automatically

Only the user closes a reviewed run. Closure automatically copies the pinned snapshot into an isolated learning workspace and gives Pi a minimized run trajectory. When the Pi session trace is available, learning also receives a run-bounded summary of bash commands and outcomes. Pi must explicitly choose either `no_change` or an evidence-supported candidate; speculative automation is prohibited.

### 7. Evaluate and approve

A candidate is sealed and checked for artifact integrity, terminal evidence, exact base lineage, stable playbook identity, an updated source version, a retained non-empty procedure, and a material content change. A stale or failing candidate is blocked. A passing candidate produces a single human approval dialog showing its summary and changed files. Approval changes the personal release pointer for **future** runs; rejection changes nothing. Active runs remain pinned. Manual proposal commands remain available for recovery and externally prepared candidates.

## Command reference

Run `/playbook <unknown-command>` to display in-Pi usage for every command.

| Command | Purpose |
|---|---|
| `/playbook` | Start interactively, or show the attached run. |
| `/playbook run <name> [request]` | Run an approved playbook or local project candidate as written, optionally refining it with a request. For an unknown name, Pi explains how the run can become a reproducible, improving workflow, asks for the first instructions interactively, and creates a named ad hoc run. |
| `/playbook status` | Show run ID, status, stage, digest, and pending gate. |
| `/playbook list` | List approved personal/project playbooks, local candidate workspaces, and proposals. |
| `/playbook approve` | Approve the currently pending workflow gate. |
| `/playbook close` | Close a reviewed run and start automatic evidence-based learning. |
| `/playbook abort [reason]` | Immediately mark the attached run abandoned. |
| `/playbook resume <run-id>` | Attach a `running`, `paused`, or `review` run to this session. |
| `/playbook seal <source-directory>` | Validate and save an immutable playbook snapshot. |
| `/playbook verify [digest]` | Re-hash a sealed artifact, or verify the attached run's artifact. |
| `/playbook draft <run-id> [destination]` | Advanced: manually create an editable candidate from a closed run. |
| `/playbook propose <candidate>` | Advanced: seal and submit a manually or externally prepared candidate. |
| `/playbook promote <proposal-id\|digest>` | Advanced: promote a pending proposal, or bootstrap a new name from a sealed digest. |
| `/playbook reject <proposal-id> [reason]` | Advanced: reject a pending proposal without changing the approved release. |
| `/playbook rollback <playbook-name>` | Restore the previous personal release for future runs. |

Names must contain lowercase letters, numbers, and single hyphens only—for example, `weekly-review` or `deploy-v2`.

For scripted or externally prepared candidates, `propose` also accepts this advanced form:

```text
/playbook propose <source-directory> <base-digest|new> <run-id|none> [rationale]
```

Use the ordinary name-only form for drafts created by Pi Playbooks; it recovers base and evidence provenance from the candidate metadata and reduces the chance of proposing the wrong lineage.

### Gate responses

At a workflow gate, either run:

```text
/playbook approve
```

or send exactly:

```text
Approved
```

Any other ordinary message is treated as a revision request: the gate is cleared, the run returns to `running`, and Pi may revise the gated stage. The gate is not considered approved.

### Moving between sessions or branches

Use the run ID shown by `/playbook status`:

```text
/playbook resume 00000000-0000-0000-0000-000000000000
```

Navigating the Pi session tree to a branch that predates the assignment detaches the run to prevent the assignment from silently following an unrelated branch. Resume it explicitly where appropriate.

## Try the included example

Start Pi from this repository so the relative example path resolves:

```sh
cd /absolute/path/to/pi-playbooks
pi
```

Seal and bootstrap the example:

```text
/playbook seal examples/research-playbook
/playbook promote <digest-printed-by-seal>
```

Then run it:

```text
/playbook run staged-research Research recurring invoicing problems for freelancers
```

The example writes `results/research-plan.md`, pauses for plan approval, performs the research, and writes `results/report.md`. It cannot report success until the report exists and is non-empty.

## Create a playbook

A skill-less playbook needs only two files:

```text
weekly-project-review/
├── PLAYBOOK.md
└── playbook.json
```

Optional scripts, references, templates, and sealed skill dependencies can live beside them:

```text
weekly-project-review/
├── PLAYBOOK.md
├── playbook.json
├── scripts/
├── references/
├── templates/
└── skills/
    ├── project-analysis/
    │   └── SKILL.md
    └── report-writing/
        └── SKILL.md
```

### `PLAYBOOK.md`

This is the model-facing procedure. It is ordinary Markdown and does not need Agent Skill frontmatter.

```markdown
# Weekly Project Review

1. Read the project documentation and recent changes.
2. Identify completed work, risks, and blocked tasks.
3. Write `results/weekly-report.md`.
4. Record a `report` checkpoint with that artifact.
5. Submit the run for review with `playbook_finish`.
```

Keep paths and stage names explicit. References and scripts are resolved under the immutable playbook root, while declared run outputs are written relative to the working directory in which the run started.

For compatibility, a root `SKILL.md` can be the procedure. If `procedure` is omitted, sealing chooses `PLAYBOOK.md` first and then `SKILL.md`.

### `playbook.json`

```json
{
  "schemaVersion": 1,
  "name": "weekly-project-review",
  "version": "0.1.0",
  "description": "Create a weekly project status report",
  "invocation": "explicit",
  "procedure": "PLAYBOOK.md",
  "requiredCapabilities": [
    "read",
    "write",
    "playbook_checkpoint",
    "playbook_finish"
  ],
  "allowedEffectClasses": [
    "filesystem.read",
    "filesystem.write",
    "governance"
  ],
  "artifacts": [
    {
      "name": "report",
      "path": "results/weekly-report.md",
      "stage": "report",
      "required": true
    }
  ],
  "successPredicates": [
    {
      "type": "artifact_nonempty",
      "path": "results/weekly-report.md"
    }
  ]
}
```

Activate the first version:

```text
/playbook seal path/to/weekly-project-review
/playbook promote <digest-printed-by-seal>
/playbook run weekly-project-review Review this week's project progress
```

Once a name already has an approved release, do not promote a newly sealed digest directly. Run the approved version and close the reviewed run; automatic learning will evaluate any supported revision and ask for one approval. Use the manual draft/proposal flow only for recovery or externally prepared changes.

## Playbook contract

`playbook.json` is schema version 1. Required fields are:

| Field | Meaning |
|---|---|
| `schemaVersion` | Must be `1`. |
| `name` | Lowercase identifier containing letters, numbers, and single hyphens. |
| `version` | Human-managed source version. Artifact identity comes from the content digest, not this label. |
| `description` | Human-readable purpose shown in listings. |
| `invocation` | `explicit` or `auto`. |
| `requiredCapabilities` | Tool names that must exist when the run starts. Their definitions are fingerprinted and checked before effects. |
| `allowedEffectClasses` | Effect classes the run may request. Undeclared effects are blocked. |

Optional fields:

| Field | Meaning |
|---|---|
| `procedure` | Bundle-relative Markdown procedure. Defaults to `PLAYBOOK.md`, then root `SKILL.md`. |
| `skillDependencies` | Bundle-relative directories, each containing `SKILL.md`. |
| `applicability` | `cwdGlobs`, `requiredFiles`, and `forbiddenFiles` used for automatic selection. |
| `artifacts` | Named output declarations with `path`, optional `stage`, and optional `required` metadata. |
| `successPredicates` | Deterministic `artifact_exists` or `artifact_nonempty` checks. |
| `evidencePolicy` | Evidence metadata (`retainArgumentValues`, `promotionLevels`). Ledger arguments are stored as hashes and every promotion still requires explicit human approval. |
| `runtime` | Runtime metadata such as `minPiVersion`. In 0.0.1 this is validated as metadata but not used for version enforcement. |

All procedure, skill, artifact, applicability-file, and predicate paths must be relative and cannot contain `..`. Declaring an artifact as `required` documents intent; use a `successPredicate` when success must be mechanically blocked unless that output exists.

### Effect classes

Supported declarations are:

- `filesystem.read`
- `filesystem.write`
- `process.exec`
- `network`
- `governance`
- `tool:<tool-name>`
- `*`

Built-in reads map to `filesystem.read`; `write` and `edit` map to `filesystem.write`; `bash` maps to `process.exec`; `playbook_*` tools map to `governance`; other tools map to `tool:<name>`. Prefer explicit classes over `*`. Declaring `*` allows effect classes but does not bypass high-risk action approval.

### Optional skills

Skills are copied into the sealed snapshot; installed or source skills are never modified.

```json
{
  "skillDependencies": [
    "skills/project-analysis",
    "skills/report-writing"
  ]
}
```

Each listed directory must remain inside the bundle and contain a regular `SKILL.md`. Pi exposes the sealed paths to the model and asks it to read a skill only when needed. A candidate may add, update, or remove these copies without touching the original installed skills.

### Checkpoint example

The procedure can direct Pi to call:

```json
{
  "stage": "plan",
  "summary": "Plan is ready for review",
  "artifactPaths": ["results/plan.md"],
  "gate": {
    "id": "approve-plan",
    "prompt": "Approve this plan before implementation"
  }
}
```

Checkpoint artifact paths must identify existing regular files inside the run working directory. Their SHA-256 hashes and sizes are recorded with the stage.

For the complete field reference, see [`docs/PLAYBOOK_FORMAT.md`](docs/PLAYBOOK_FORMAT.md).

## Approval and review behavior

Pi Playbooks has two different approval mechanisms:

1. **Workflow gates** pause the whole procedure between stages. They are created by `playbook_checkpoint` and resumed with `/playbook approve` or revised by an ordinary response.
2. **One-action approvals** are interactive confirmations for a single high-risk tool call. Approval is bound to that tool call's hashed arguments and does not approve the rest of the stage or run.

Selected high-risk writes and shell operations—such as edits to `.env`, `.git`, `.ssh`, or `package-lock.json`, destructive commands, publishing, pushes, and common infrastructure/deployment commands—require one-action approval even when their effect class is declared. In non-UI modes, an action that requires confirmation is blocked.

A run can have these statuses:

```text
running → paused → running → review → completed | failed | abandoned
```

`paused` means a workflow gate is pending. `review` means Pi has proposed an outcome, but the run is still active. `completed`, `failed`, and `abandoned` are terminal and feed the automatic learning workflow. `/playbook abort` moves directly to `abandoned`; it does not enter review. Manual drafting remains available as an advanced fallback.

## Automatic and project playbooks

### Automatic invocation

Set `invocation` to `auto` and constrain where the playbook applies:

```json
{
  "invocation": "auto",
  "applicability": {
    "cwdGlobs": ["**/my-project"],
    "requiredFiles": ["package.json"],
    "forbiddenFiles": [".production-only"]
  }
}
```

When no run is active, Pi Playbooks evaluates approved automatic releases before a normal agent turn:

1. matching personal releases have priority over project/team releases;
2. exactly one match at the selected priority is required;
3. multiple matches produce a conflict and no playbook is silently chosen.

Applicability controls automatic selection. An explicit `/playbook run <name> ...` selects the named approved release directly.

### Project/team registry

For trusted projects, Pi Playbooks also reads:

```text
.pi/playbooks/registry.json
```

This is a read-only project/team release registry from the extension's perspective. Personal releases take precedence over entries with the same name. Version `0.0.1` does not provide team publishing, artifact synchronization, signatures, or team-wide trials, so a shared registry is useful only when its referenced artifacts are already available in each user's playbook store.

Project-local candidate discovery and `/playbook propose <name>` also require the project to be trusted.

## Storage and trust

By default, durable state is stored under:

```text
~/.pi/agent/playbooks/
├── artifacts/       # immutable content-addressed snapshots
├── runs/            # run records
├── proposals/       # proposal records
├── registry.json    # approved personal release pointers
└── facts.jsonl      # append-only, fsync-backed minimized ledger
```

Override the root before starting Pi:

```sh
export PI_PLAYBOOKS_HOME=/absolute/path/to/playbook-state
```

Editable drafts default to the current project rather than the protected store:

```text
.pi/playbooks/candidates/<playbook-name>-<run-id-prefix>/
```

The candidate includes a hidden provenance file, `.pi-playbook-candidate.json`. It links the base digest and evidence run locally and is excluded when the candidate is sealed.

Pi Playbooks does not edit the original workflow directory or installed skill directories. Sealing reads them and writes a separate snapshot. Drafting writes a separate candidate. Promotion changes only a registry pointer.

The ledger records run and assignment IDs, artifact digests, stages, approvals, policy decisions, result facts, and hashes of tool arguments. It does not store raw tool argument values in version `0.0.1`. Pi's own session transcript remains separate and may contain the original conversation and tool content.

During automatic learning or manual drafting, Pi Playbooks can read that Pi-owned trace and extract bash command/outcome evidence from the run's timestamp window. It omits command output and other tool arguments, redacts likely inline credentials, groups repeated commands, and sends at most 50 summaries within a 20,000-character command-text budget to the drafting model. This evidence is not appended to `facts.jsonl`; a candidate records a deterministic command or helper only after the model finds concrete execution support and you still review it before promotion.

## Safety model and limitations

Pi Playbooks can:

- pin a run to a verified content digest;
- reject tampered snapshots and symlink escapes;
- attest required tool definitions and fail closed if they disappear or change;
- block undeclared effect classes;
- request confirmation for selected high-risk actions;
- pause at explicit workflow gates;
- hash checkpoint artifacts;
- prevent a successful finish when deterministic predicates fail;
- retain an auditable fact ledger and proposal lineage.

It cannot:

- sandbox the operating system or constrain arbitrary code in another co-resident extension;
- guarantee that every external side effect is visible to the extension;
- make built-in Pi tools transactional;
- prove that a workflow improvement caused a better result;
- safely auto-promote model-authored changes;
- provide hosted distribution, remote signatures, or team trials in `0.0.1`.

The two governance tools are guarded by the extension. Built-in Pi tools and user `!` shell commands are observed/intercepted through Pi's public extension hooks, not executed in a security sandbox. Commands launched by arbitrary co-resident extension code may be unmediated.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for implementation details and trust boundaries.

## Current release

Version `0.0.1` implements the local personal workflow:

- immutable sealing and verification;
- explicit, ad hoc, and automatic runs;
- long-lived checkpoints, gates, review, closure, and resume;
- deterministic output predicates;
- personal promotion and rollback;
- automatic evidence-based learning after run closure;
- deterministic candidate evaluation and one-step human approval;
- editable candidates with evidence provenance;
- advanced manual proposal, stale-lineage rejection, rejection, and promotion controls;
- optional sealed Agent Skill dependencies.

Unattended activation, hosted storage, cryptographic remote distribution, statistical promotion, and full team publishing/trials are intentionally not included.

## Troubleshooting

- **`Required tool is unavailable`** — add the tool to Pi or remove it from `requiredCapabilities` if the procedure does not need it.
- **`<effect> is not declared by the playbook`** — add the narrow effect class required by the tool; do not default to `*` without reviewing the workflow.
- **`Success predicates failed`** — create or repair the declared output, then call `playbook_finish` again.
- **`Revision directory already exists`** — choose a different destination: `/playbook draft <run-id> <new-directory>`.
- **`Multiple local candidates are named ...`** — choose one of the candidate directory names included in the error. `/playbook list` also prints an unambiguous `propose` command for every workspace.
- **`Proposal base is stale`** — the approved version changed after the draft was created; create or rebase a candidate from the current release.
- **No project candidates are listed** — trust the project and confirm they are under `.pi/playbooks/candidates/`.
- **A run disappeared after `/tree` navigation** — it was detached from a branch that no longer contains its assignment; use `/playbook resume <run-id>`.

## Development

```sh
npm install
npm run check
npm test
```

`npm run check` runs TypeScript type-checking. `npm test` runs the Node test suite through `tsx`. Both run automatically before publishing.

## License

[MIT](LICENSE)
