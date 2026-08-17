# Pi Runbooks

[![npm](https://img.shields.io/npm/v/%40haseebeqx%2Fpi-runbooks)](https://www.npmjs.com/package/@haseebeqx/pi-runbooks)

A [Pi](https://pi.dev) extension for turning repeatable work into versioned, governed workflows.

Pi Runbooks can record successful sessions, run reusable procedures, pause at approval gates, verify required outputs, and propose evidence-based improvements. Every run is pinned to an immutable snapshot, and no proposed revision is activated without your approval.

> [!IMPORTANT]
> Pi extensions run with your normal system permissions. Review this package and any runbook you install.

## Install

Requirements:

- Node.js 22.19.0 or newer
- Pi (tested with Pi 0.84.2)

Install from npm:

```sh
pi install npm:@haseebeqx/pi-runbooks
```

To update or remove it:

```sh
pi update npm:@haseebeqx/pi-runbooks
pi remove npm:@haseebeqx/pi-runbooks
```

## Quick start

### Record work you already completed

Work normally in Pi, then turn the current session into a reusable runbook:

```text
/runbook record release-check
```

Pi reviews the session, proposes a candidate only when it finds a reusable workflow, and asks for approval before activating it.

Run the approved runbook later with:

```text
/runbook run release-check
```

Recording requires an interactive Pi session with prior work to inspect. It can use the entire current session, so do not record material you do not want reflected in a generated candidate.

### Start a governed run

Start interactively:

```text
/runbook
```

Or start a named run directly:

```text
/runbook run release-check Check whether this repository is ready for release
```

A controlled run may use checkpoints and approval gates. When Pi marks it ready for review, close it with:

```text
/runbook close
```

Pi can then propose a reusable workflow or a revision based on the run. You decide whether to approve it.

## Common commands

| Command | Purpose |
|---|---|
| `/runbook` | Start interactively or show the active run. |
| `/runbook record [name]` | Extract a reusable workflow from the current session. |
| `/runbook run <name> [request]` | Run an approved runbook, candidate, or new governed workflow. |
| `/runbook status` | Show the active run and pending gate. |
| `/runbook list` | List releases, candidates, and proposals. |
| `/runbook approve` | Approve the pending workflow gate. |
| `/runbook close` | Close a reviewed run and begin learning. |
| `/runbook abort [reason]` | Abandon the active run. |
| `/runbook resume <run-id>` | Attach an existing run to the current session. |
| `/runbook edit <name>` | Create an editable candidate from an approved release. |
| `/runbook instruct <name> <instruction>` | Propose one persistent instruction. |
| `/runbook rollback <name>` | Restore the previous personal release. |

Use `/runbook <unknown-command>` in Pi to display the complete built-in command help, including advanced proposal and artifact commands.

Runbook names use lowercase letters, numbers, and single hyphens, such as `release-check`.

## Runbook format

A minimal runbook contains:

```text
my-runbook/
├── RUNBOOK.md
└── runbook.json
```

`RUNBOOK.md` is the model-facing procedure. `runbook.json` declares metadata, required tools, allowed effects, outputs, and deterministic success checks. Runbooks may also include scripts, references, templates, and sealed Agent Skill dependencies.

See [Runbook contract v1](docs/RUNBOOK_FORMAT.md) for the complete format and [Architecture](docs/ARCHITECTURE.md) for storage, lifecycle, policy, and trust-boundary details.

To activate the first version of a manually authored runbook:

```text
/runbook seal path/to/my-runbook
/runbook promote <digest-printed-by-seal>
```

Updates to an approved runbook go through the candidate review flow. An example is available in [`examples/research-runbook`](examples/research-runbook).

## Safety

Pi Runbooks provides workflow governance, not an operating-system sandbox. It can pin and verify runbook snapshots, restrict declared effect classes, request approval for selected high-risk actions, enforce workflow gates, hash checkpoint artifacts, and check required outputs. It cannot constrain arbitrary code in other extensions or guarantee that every external side effect is observable.

## Development

```sh
npm install
npm run check
npm test
```

## License

[MIT](LICENSE)
