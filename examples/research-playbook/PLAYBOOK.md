# Staged Research

Keep the original request as the scope boundary throughout the run.

## 1. Plan

1. Create `results/research-plan.md` containing the focused question, sources to examine, limits, and expected report structure.
2. Call `playbook_checkpoint` with stage `plan`, the plan artifact path, and an approval gate whose ID is `approve-plan`.
3. Stop. Do not collect evidence until the user explicitly approves the gate.

## 2. Research

1. Read the approved plan again.
2. Collect traceable evidence and distinguish observations from interpretations.
3. Keep contrary evidence; do not pad sparse findings.
4. Call `playbook_checkpoint` with stage `evidence` and a concise summary.

## 3. Report

1. Write `results/report.md` with findings, sources, limitations, and falsifiable next steps.
2. Call `playbook_checkpoint` with stage `report` and the report artifact path.
3. Call `playbook_finish` with outcome `success`. The runtime will reject completion if the report is absent or empty, then keep the run open for user questions and requested changes until the user runs `/playbook close`.
