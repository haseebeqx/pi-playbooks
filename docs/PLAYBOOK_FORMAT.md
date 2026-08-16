# Playbook contract v1

`playbook.json` is the deterministic contract surrounding a model-facing workflow procedure. A playbook is not tied to an Agent Skill: it may be skill-less, use `SKILL.md` as its procedure for compatibility, or declare multiple optional skill dependencies.

## Required fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Must be `1`. |
| `name` | Lowercase playbook identifier using letters, numbers, and hyphens. |
| `version` | Source version label. Artifact identity still comes from content. |
| `description` | Human-readable purpose. |
| `invocation` | `explicit` or `auto`. |
| `requiredCapabilities` | Pi tool names that must exist with stable fingerprints for the run. |
| `allowedEffectClasses` | Effects the procedure may request. |

Supported effect classes are `filesystem.read`, `filesystem.write`, `process.exec`, `network`, `governance`, `tool:<name>`, and `*`. Prefer explicit classes over `*`.

## Procedure and optional skills

A skill-less workflow should explicitly select an ordinary Markdown procedure:

```json
{
  "procedure": "PLAYBOOK.md"
}
```

If `procedure` is omitted, sealing chooses `PLAYBOOK.md` when present and otherwise accepts a root `SKILL.md` for backward compatibility.

Optional Agent Skills are dependencies, not the identity of the playbook:

```json
{
  "procedure": "PLAYBOOK.md",
  "skillDependencies": [
    "skills/research",
    "skills/report-writing"
  ]
}
```

Every dependency path must stay inside the bundle and point to a directory containing `SKILL.md`. Dependencies are sealed with that playbook version and exposed to the model for on-demand reading. A later candidate may add or remove dependencies without changing the active release or the original installed skills.

## Applicability

```json
{
  "applicability": {
    "cwdGlobs": ["**/my-project"],
    "requiredFiles": ["package.json"],
    "forbiddenFiles": [".production-only"]
  }
}
```

Applicability uses normalized trusted filesystem attributes. Missing attributes do not authorize. Automatic selection occurs only when exactly one applicable automatic release remains after personal-over-team precedence.

## Artifacts

```json
{
  "artifacts": [
    {
      "name": "plan",
      "path": "results/plan.json",
      "stage": "plan",
      "required": true
    }
  ]
}
```

Paths are relative to the run working directory and cannot contain `..` or be absolute. `playbook_checkpoint` hashes artifact files at stage boundaries.

## Success predicates

Version 1 supports deterministic filesystem predicates:

```json
{
  "successPredicates": [
    { "type": "artifact_exists", "path": "results/analysis.json" },
    { "type": "artifact_nonempty", "path": "results/report.md" }
  ]
}
```

`playbook_finish` rejects a `success` outcome while any predicate fails. A valid outcome moves the run into review rather than closing it: follow-up questions and requested changes remain governed by the same pinned playbook. Material changes can update the proposed outcome with another `playbook_finish` call. The user closes the reviewed run explicitly with `/playbook close`, which starts automatic evidence-based learning. Pi either records `no_change` or prepares, seals, and deterministically evaluates a candidate before presenting one human approval decision. Failure and abandonment remain recordable even when outputs are incomplete. `/playbook draft` remains available as an advanced manual fallback.

## Evidence policy

```json
{
  "evidencePolicy": {
    "retainArgumentValues": false,
    "promotionLevels": ["guarded", "sandboxed"]
  }
}
```

The current ledger always minimizes action arguments to hashes. Promotion levels describe admissible evidence for future trial governance; current candidates receive deterministic checks and still require explicit human approval rather than unattended promotion.

When automatic learning or `/playbook draft` can access the run's Pi session trace, it separately builds a transient, run-bounded summary of bash command text and outcomes so the learning model can identify deterministic consolidation or helper-script opportunities. Tool output and non-command arguments are omitted, likely inline credentials are redacted, and this summary is not written to the fact ledger. Automation must be supported by observed execution evidence; an unexecuted suggestion or argument hash is insufficient.

## Workflow gates

Workflow gates are not action approvals. A checkpoint gate pauses the long-lived run across agent turns:

```json
{
  "stage": "plan",
  "summary": "Plan ready for review",
  "artifactPaths": ["results/plan.json"],
  "gate": {
    "id": "approve-plan",
    "prompt": "Approve the plan before evidence collection"
  }
}
```

A one-action approval instead authorizes one high-risk tool operation and is bound to the hashed arguments of that tool call.
