# Pi Runbooks

[![npm version](https://img.shields.io/npm/v/%40haseebeqx%2Fpi-runbooks)](https://www.npmjs.com/package/@haseebeqx/pi-runbooks)
[![npm downloads](https://img.shields.io/npm/dm/%40haseebeqx%2Fpi-runbooks)](https://www.npmjs.com/package/@haseebeqx/pi-runbooks)
[![Node.js](https://img.shields.io/node/v/%40haseebeqx%2Fpi-runbooks)](package.json)
[![License](https://img.shields.io/npm/l/%40haseebeqx%2Fpi-runbooks)](LICENSE)

A [Pi](https://pi.dev) plugin for turning work you do with Pi into reusable, reviewed workflows.

Use Pi Runbooks to:

- repeat a successful workflow without rewriting the prompt;
- keep long-running work pinned to the same procedure;
- pause at explicit review gates;
- require files or other outputs before a run can succeed;
- improve a workflow from evidence gathered during real runs;
- approve every revision before it becomes the version used in the future.

> [!IMPORTANT]
> Pi plugins run with your normal system permissions. A runbook adds workflow controls, but it is not a security sandbox. Review this plugin and any runbook you use.

## Install

Requirements:

- Node.js 22.19.0 or newer
- Pi (currently tested with Pi 0.84.2)

Install the plugin from npm:

```sh
pi install npm:@haseebeqx/pi-runbooks
```

Restart Pi if the `/runbook` command does not appear immediately.

Update or remove the plugin with:

```sh
pi update npm:@haseebeqx/pi-runbooks
pi remove npm:@haseebeqx/pi-runbooks
```

## Create your first runbook

### Start with a new task

Name the workflow and tell Pi what to do:

```text
/runbook run dependency-audit Inspect this project for outdated and vulnerable dependencies, then write a report
```

If `dependency-audit` does not exist yet, the plugin starts it as a new governed workflow. Work with Pi normally: answer questions, give feedback, and request changes.

When Pi considers the work complete, the run stays open for your review. Ask follow-up questions or request edits, then close it when satisfied:

```text
/runbook close
```

The plugin analyzes the completed run. It either reports that no reusable change is supported or prepares a runbook candidate. The candidate becomes the version used by future runs only if you approve it.

Run the approved workflow again later:

```text
/runbook run dependency-audit
```

### Capture work you already completed

After completing useful work in a normal Pi session, turn that session into a reusable workflow:

```text
/runbook record dependency-audit
```

The plugin asks before inspecting the session, extracts a generalized candidate, and presents it for approval. Recording may use the entire current session branch, not only the latest request, so review the confirmation carefully if the session contains secrets, personal data, or unrelated work.

You can also omit the name and let Pi prompt for one:

```text
/runbook record
```

## During a run

A run remains attached to the Pi session branch where it started. Its procedure, allowed effects, tools, stage, and pending gate remain active until you close or abort it.

### Check progress

```text
/runbook status
```

Running `/runbook` with no arguments also shows the active run, or starts an interactive workflow when no run is active.

### Approve a workflow gate

A runbook may pause before moving to its next stage—for example, after preparing a plan:

```text
/runbook approve
```

You can ask for changes instead of approving. A workflow gate advances the procedure; it does not pre-authorize later high-risk actions. Those actions may still require separate confirmation.

### Review and close

When Pi submits an outcome for review, the run is still active. Continue the conversation and request any needed changes. When the result is final:

```text
/runbook close
```

Closing records the result and starts evidence-based learning. If you do not want to continue a run:

```text
/runbook abort optional reason
```

### Resume after restarting Pi

Reopen the same Pi session, including with `pi --session <path|id>`. Running, paused, and review-ready workflows are restored automatically on their assigned session branch. You do not need to manage a separate run ID.

## Manage your runbooks

List approved runbooks, local candidates, and pending proposals:

```text
/runbook list
/runbook list --details
```

Add a lasting instruction to an approved runbook:

```text
/runbook instruct dependency-audit Always include remediation priorities
```

The instruction is proposed as a revision and requires approval before future runs use it.

Create an editable copy of an approved runbook:

```text
/runbook edit dependency-audit
```

Return future runs to the previously approved personal version:

```text
/runbook rollback dependency-audit
```

An active run remains pinned to the version with which it started, even if another version is approved or restored.

Runbook names use lowercase letters, numbers, and single hyphens, such as `dependency-audit`.

## Use runbooks with Pi skills

Convert a currently loaded Pi Agent Skill, or a skill directory containing `SKILL.md`, into an editable runbook candidate:

```text
/runbook from-skill pdf-tools
/runbook from-skill path/to/my-skill
```

Review the generated contract—especially its required tools and allowed effects—then use the proposal command shown by Pi.

Export an approved runbook as a standalone Pi skill:

```text
/runbook to-skill dependency-audit
/runbook to-skill dependency-audit path/to/dependency-audit-skill
```

The exported skill includes `SKILL.md` and bundled support files. It does **not** include runbook pinning, gates, policy checks, output verification, or evidence tracking.

## Command reference

| Command | What it does |
|---|---|
| `/runbook` | Show the active run or start a new workflow interactively. |
| `/runbook run <name> [request]` | Run an approved runbook or local candidate, or create a named workflow. |
| `/runbook record [name]` | Extract a reusable workflow from the current session. |
| `/runbook status` | Show the active run, stage, and pending gate. |
| `/runbook approve` | Approve the current workflow gate. |
| `/runbook close` | Close a reviewed run and start learning. |
| `/runbook abort [reason]` | Abandon the active run. |
| `/runbook list [--details]` | List runbooks, candidates, and proposals. |
| `/runbook instruct <name> <instruction>` | Propose a persistent instruction for future runs. |
| `/runbook edit <name> [destination]` | Create an editable candidate from an approved runbook. |
| `/runbook rollback <name>` | Restore the previous personal version for future runs. |
| `/runbook from-skill <name\|directory> [destination]` | Convert a Pi skill into a runbook candidate. |
| `/runbook to-skill <name> [destination]` | Export an approved runbook as a Pi skill. |

Enter an unknown subcommand, such as `/runbook help`, to see Pi's complete built-in command help. It also lists advanced commands for manually sealing, verifying, proposing, promoting, and rejecting artifacts.

## How approval and learning work

Each run uses an immutable snapshot of its runbook. Completing a run does not overwrite that snapshot or alter the approved version.

After you close a reviewed run, the plugin summarizes run-scoped evidence and asks Pi whether the workflow should change. Supported changes become a candidate that must pass deterministic checks and receive your explicit approval. Stale candidates and candidates without the required evidence are not promoted.

The evidence ledger stores minimized facts and argument hashes rather than raw tool arguments. During learning, the plugin may transiently inspect run-bounded shell commands and outcomes to identify a supported deterministic shortcut; command output is omitted and likely inline credentials are redacted. This does not make recording or learning safe for secrets—continue to review what you share with Pi and what a candidate contains.

## Use an existing runbook project

A runbook usually contains:

```text
my-runbook/
├── RUNBOOK.md
└── runbook.json
```

`RUNBOOK.md` tells Pi how to perform the workflow. `runbook.json` declares when it applies, which tools and effect classes it may use, its workflow gates, required artifacts, and success checks. A runbook can also bundle scripts, references, templates, and optional Pi skill dependencies.

Trusted projects can provide local candidates under `.pi/runbooks/candidates/`. Run one by its contract name or candidate directory name:

```text
/runbook run staged-research
```

See the included [`staged-research` example](examples/research-runbook), the [runbook contract reference](docs/RUNBOOK_FORMAT.md), and the [architecture and trust boundaries](docs/ARCHITECTURE.md) for details.

## Safety and limitations

Pi Runbooks can verify immutable runbook content, limit declared effect classes, pause at workflow gates, ask for selected high-risk action approvals, hash declared outputs, and enforce deterministic output checks.

It cannot:

- isolate Pi or other plugins from your operating system;
- constrain arbitrary code running with the same user permissions;
- guarantee that every external side effect is observable;
- make an untrusted procedure, script, skill, or command safe.

Treat runbooks as reviewed automation: inspect unfamiliar workflows, protect credentials, and keep normal backups and source control practices.

## License

[MIT](LICENSE)
