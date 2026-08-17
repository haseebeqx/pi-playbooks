# Pi Playbooks

[![npm](https://img.shields.io/npm/v/%40haseebeqx%2Fpi-playbooks)](https://www.npmjs.com/package/@haseebeqx/pi-playbooks)

A [Pi](https://pi.dev) extension for turning repeatable work into versioned, governed workflows.

Pi Playbooks can record successful sessions, run reusable procedures, pause at approval gates, verify required outputs, and propose evidence-based improvements. Every run is pinned to an immutable snapshot, and no proposed revision is activated without your approval.

> [!IMPORTANT]
> Pi extensions run with your normal system permissions. Review this package and any playbook you install.

## Install

Requirements:

- Node.js 22.19.0 or newer
- Pi (tested with Pi 0.84.2)

Install from npm:

```sh
pi install npm:@haseebeqx/pi-playbooks
```

To update or remove it:

```sh
pi update npm:@haseebeqx/pi-playbooks
pi remove npm:@haseebeqx/pi-playbooks
```

## Quick start

### Record work you already completed

Work normally in Pi, then turn the current session into a reusable playbook:

```text
/playbook record release-check
```

Pi reviews the session, proposes a candidate only when it finds a reusable workflow, and asks for approval before activating it.

Run the approved playbook later with:

```text
/playbook run release-check
```

Recording requires an interactive Pi session with prior work to inspect. It can use the entire current session, so do not record material you do not want reflected in a generated candidate.

### Start a governed run

Start interactively:

```text
/playbook
```

Or start a named run directly:

```text
/playbook run release-check Check whether this repository is ready for release
```

A controlled run may use checkpoints and approval gates. When Pi marks it ready for review, close it with:

```text
/playbook close
```

Pi can then propose a reusable workflow or a revision based on the run. You decide whether to approve it.

## Common commands

| Command | Purpose |
|---|---|
| `/playbook` | Start interactively or show the active run. |
| `/playbook record [name]` | Extract a reusable workflow from the current session. |
| `/playbook run <name> [request]` | Run an approved playbook, candidate, or new governed workflow. |
| `/playbook status` | Show the active run and pending gate. |
| `/playbook list` | List releases, candidates, and proposals. |
| `/playbook approve` | Approve the pending workflow gate. |
| `/playbook close` | Close a reviewed run and begin learning. |
| `/playbook abort [reason]` | Abandon the active run. |
| `/playbook resume <run-id>` | Attach an existing run to the current session. |
| `/playbook edit <name>` | Create an editable candidate from an approved release. |
| `/playbook instruct <name> <instruction>` | Propose one persistent instruction. |
| `/playbook rollback <name>` | Restore the previous personal release. |

Use `/playbook <unknown-command>` in Pi to display the complete built-in command help, including advanced proposal and artifact commands.

Playbook names use lowercase letters, numbers, and single hyphens, such as `release-check`.

## Playbook format

A minimal playbook contains:

```text
my-playbook/
├── PLAYBOOK.md
└── playbook.json
```

`PLAYBOOK.md` is the model-facing procedure. `playbook.json` declares metadata, required tools, allowed effects, outputs, and deterministic success checks. Playbooks may also include scripts, references, templates, and sealed Agent Skill dependencies.

See [Playbook contract v1](docs/PLAYBOOK_FORMAT.md) for the complete format and [Architecture](docs/ARCHITECTURE.md) for storage, lifecycle, policy, and trust-boundary details.

To activate the first version of a manually authored playbook:

```text
/playbook seal path/to/my-playbook
/playbook promote <digest-printed-by-seal>
```

Updates to an approved playbook go through the candidate review flow. An example is available in [`examples/research-playbook`](examples/research-playbook).

## Safety

Pi Playbooks provides workflow governance, not an operating-system sandbox. It can pin and verify playbook snapshots, restrict declared effect classes, request approval for selected high-risk actions, enforce workflow gates, hash checkpoint artifacts, and check required outputs. It cannot constrain arbitrary code in other extensions or guarantee that every external side effect is observable.

## Development

```sh
npm install
npm run check
npm test
```

## License

[MIT](LICENSE)
