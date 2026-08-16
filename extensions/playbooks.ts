import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArtifactStore } from "../src/artifacts.js";
import { listProjectCandidates, selectProjectCandidate, writeCandidateMetadata } from "../src/candidates.js";
import { evaluateCandidate } from "../src/evaluation.js";
import { FactLedger } from "../src/ledger.js";
import { ReleaseRegistry, personalRegistryPath } from "../src/registry.js";
import { assertProposalIsProposed, ProposalStore } from "../src/proposals.js";
import { resolveAutomatic, resolveNamed, type ResolvedRelease } from "../src/resolver.js";
import { evaluatePredicates, hashRunArtifact, RunStore } from "../src/runs.js";
import { commandEvidenceFromSession } from "../src/trajectory.js";
import {
  attestTools,
  decide,
  hashArguments,
  POLICY_VERSION,
  verifyToolAttestations,
  type ToolMetadata,
} from "../src/policy.js";
import type { LedgerFact, PlaybookContract, PlaybookRun } from "../src/types.js";

const CheckpointParameters = Type.Object({
  stage: Type.String({ description: "Stable workflow stage name" }),
  summary: Type.String({ description: "What was completed and what remains" }),
  artifactPaths: Type.Optional(Type.Array(Type.String({ description: "Run-relative artifact path to hash" }))),
  gate: Type.Optional(Type.Object({
    id: Type.String({ description: "Stable approval gate identifier" }),
    prompt: Type.String({ description: "Exact decision requested from the user" }),
  })),
});

const FinishParameters = Type.Object({
  outcome: StringEnum(["success", "failure", "abandoned"] as const),
  summary: Type.String(),
});

const CompleteLearningParameters = Type.Object({
  runId: Type.String({ description: "Evidence run being analyzed" }),
  decision: StringEnum(["propose", "no_change"] as const),
  summary: Type.String({ description: "Concise evidence-based explanation of the decision and candidate changes" }),
});

const COMMAND_HELP: ReadonlyArray<readonly [name: string, usage: string, description: string]> = [
  ["run", "run <playbook-name> [request]", "Start an approved playbook or local candidate as written, or provide a request to refine it or create an ad hoc workflow."],
  ["status", "status", "Show the active run, current stage, and status."],
  ["list", "list", "List approved playbooks, project candidate workspaces, and submitted proposals."],
  ["approve", "approve", "Approve the workflow gate currently waiting for your decision."],
  ["close", "close", "Close a reviewed run and start automatic evidence-based learning."],
  ["resume", "resume <run-id>", "Attach an unfinished or review-ready run to this Pi session."],
  ["abort", "abort [reason]", "Abandon the active run and optionally record why."],
  ["seal", "seal <source-directory>", "Create an immutable playbook artifact from a source directory."],
  ["verify", "verify [digest]", "Verify a sealed artifact, or the active run's artifact."],
  ["draft", "draft <run-id> [destination]", "Advanced: create an editable improvement workspace from a completed run."],
  ["propose", "propose <candidate>", "Advanced: submit a manually prepared candidate without activating it."],
  ["promote", "promote <proposal-id|digest>", "Advanced: activate a reviewed proposal or bootstrap a sealed playbook."],
  ["reject", "reject <proposal-id> [reason]", "Advanced: reject a candidate proposal without changing the active version."],
  ["rollback", "rollback <playbook-name>", "Return future runs to the preceding approved version."],
];

function parseWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const character of input.trim()) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if ((character === "'" || character === "\"") && current.length === 0) quote = character;
    else if (/\s/.test(character)) { if (current) { words.push(current); current = ""; } }
    else current += character;
  }
  if (quote) throw new Error("Unterminated quote");
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

function suggestedPlaybookName(request: string): string {
  const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/g, "");
  return slug || "reusable-workflow";
}

function teamRegistryFor(ctx: ExtensionContext): ReleaseRegistry | undefined {
  if (!ctx.isProjectTrusted()) return undefined;
  return new ReleaseRegistry(join(ctx.cwd, CONFIG_DIR_NAME, "playbooks", "registry.json"), false);
}

function toolMetadata(pi: ExtensionAPI): ToolMetadata[] {
  return pi.getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sourceInfo: { source: tool.sourceInfo.source },
  }));
}

export default function playbooksExtension(pi: ExtensionAPI) {
  const home = process.env.PI_PLAYBOOKS_HOME
    ? resolve(process.env.PI_PLAYBOOKS_HOME)
    : join(getAgentDir(), "playbooks");
  const artifacts = new ArtifactStore(home);
  const personal = new ReleaseRegistry(personalRegistryPath(home));
  const runs = new RunStore(home);
  const proposals = new ProposalStore(home);
  const ledger = new FactLedger(join(home, "facts.jsonl"));
  let activeRun: PlaybookRun | undefined;
  let activeContract: PlaybookContract | undefined;
  const blockedCalls = new Set<string>();
  let batchBarrierToolCallId: string | undefined;
  let suppressAutomaticOnce = false;

  const appendFact = async (ctx: ExtensionContext, fact: Omit<LedgerFact, "factId" | "timestamp">) => {
    const enriched: Omit<LedgerFact, "factId" | "timestamp"> = { ...fact, sessionId: ctx.sessionManager.getSessionId() };
    if (activeRun) {
      enriched.runId ??= activeRun.runId;
      enriched.assignmentId ??= activeRun.assignmentId;
      enriched.artifactDigest ??= activeRun.artifactDigest;
    }
    const leaf = ctx.sessionManager.getLeafId();
    if (!enriched.branchEntryId && leaf) enriched.branchEntryId = leaf;
    return ledger.append(enriched);
  };

  const setActive = async (run: PlaybookRun | undefined, ctx: ExtensionContext) => {
    activeRun = run;
    activeContract = run ? await artifacts.contract(run.artifactDigest) : undefined;
    ctx.ui.setStatus("pi-playbooks", run ? `playbook: ${run.playbookName} (${run.status})` : undefined);
  };

  const adHocRelease = async (name: string): Promise<ResolvedRelease> => {
    await mkdir(home, { recursive: true });
    const source = await mkdtemp(join(home, ".ad-hoc-source-"));
    try {
      await writeFile(join(source, "PLAYBOOK.md"), `# Ad hoc governed workflow\n\nCarry out the user's original request as a complete workflow.\n\n1. Clarify material ambiguity before taking consequential action.\n2. Inspect the current project and use any Pi skills that are relevant; the workflow is not tied to a preselected skill.\n3. Make a concise plan for complex work.\n4. Use playbook_checkpoint at meaningful stage boundaries and before waiting for user approval.\n5. Ask for explicit approval before irreversible, externally visible, credential, billing, infrastructure, deployment, or production effects.\n6. Verify the result rather than assuming an action succeeded.\n7. Call playbook_finish with success, failure, or abandoned when the requested work is ready for user review. The run remains open for questions and changes until the user closes it.\n\nThe original user request, not this generic procedure, defines the workflow goal.\n`, "utf8");
      await writeFile(join(source, "playbook.json"), `${JSON.stringify({
        schemaVersion: 1,
        name,
        version: "0.0.1",
        description: "Governed capture of a user-requested workflow that does not require a pre-existing playbook",
        invocation: "explicit",
        procedure: "PLAYBOOK.md",
        requiredCapabilities: ["playbook_checkpoint", "playbook_finish"],
        allowedEffectClasses: ["*"],
        evidencePolicy: { retainArgumentValues: false, promotionLevels: ["guarded", "sandboxed"] },
      }, null, 2)}\n`, "utf8");
      const manifest = await artifacts.seal(source);
      return { name: manifest.contract.name, digest: manifest.digest, scope: "explicit-digest", contract: manifest.contract };
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  };

  const projectCandidateRelease = async (name: string, ctx: ExtensionContext): Promise<ResolvedRelease | undefined> => {
    if (!ctx.isProjectTrusted()) return undefined;
    const root = join(ctx.cwd, CONFIG_DIR_NAME, "playbooks", "candidates");
    const candidate = selectProjectCandidate(await listProjectCandidates(root), name);
    if (!candidate) return undefined;
    const manifest = await artifacts.seal(candidate.sourcePath);
    return {
      name: manifest.contract.name,
      digest: manifest.digest,
      scope: "project-candidate",
      contract: manifest.contract,
    };
  };

  const createRun = async (
    release: ResolvedRelease,
    prompt: string,
    ctx: ExtensionContext,
  ): Promise<PlaybookRun> => {
    if (activeRun) throw new Error(`Run ${activeRun.runId} is already active`);
    await artifacts.verify(release.digest);
    const attestations = attestTools(release.contract.requiredCapabilities, toolMetadata(pi));
    const leaf = ctx.sessionManager.getLeafId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const run = await runs.create({
      playbookName: release.name,
      artifactDigest: release.digest,
      releaseScope: release.scope,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(sessionFile ? { sessionFile } : {}),
      ...(leaf ? { branchRootEntryId: leaf } : {}),
      originalPrompt: prompt,
      toolAttestations: attestations,
    });
    await setActive(run, ctx);
    pi.appendEntry("pi-playbooks:assignment", {
      runId: run.runId,
      assignmentId: run.assignmentId,
      playbookName: run.playbookName,
      artifactDigest: run.artifactDigest,
    });
    await appendFact(ctx, { type: "RUN_ASSIGNED", reason: "fixed artifact assignment created before playbook execution" });
    return run;
  };

  const notifyRunStarted = (run: PlaybookRun, release: ResolvedRelease, ctx: ExtensionContext) => {
    const theme = ctx.ui.theme;
    const approved = release.scope === "personal" || release.scope === "team";
    const candidate = release.scope === "project-candidate";
    ctx.ui.notify([
      theme.fg("success", theme.bold(`Started ${run.playbookName}`)),
      `Run ID: ${theme.fg("accent", run.runId)}`,
      approved
        ? `Using ${theme.fg("success", `${release.scope} approved playbook`)} ${theme.fg("muted", release.digest.slice(0, 12) + "…")}`
        : candidate
          ? `Using an immutable snapshot of local candidate ${theme.fg("muted", release.digest.slice(0, 12) + "…")}`
          : theme.fg("warning", "This is a new ad hoc workflow; it is not yet a reusable approved playbook."),
      approved || candidate
        ? `Run it again later with ${theme.fg("accent", `/playbook run ${run.playbookName}`)} (optionally add a request)`
        : theme.fg("muted", "When the run finishes, Pi will show how to turn it into a reusable playbook."),
    ].join("\n"), "info");
  };

  const approveGate = async (ctx: ExtensionContext): Promise<void> => {
    if (!activeRun?.pendingGate || activeRun.status !== "paused") throw new Error("No playbook approval gate is pending");
    const gate = activeRun.pendingGate;
    activeRun.status = "running";
    delete activeRun.pendingGate;
    await runs.save(activeRun);
    await appendFact(ctx, { type: "GATE_APPROVED", reason: gate.id, data: { gatePromptHash: hashArguments(gate.prompt) } });
    await setActive(activeRun, ctx);
  };

  const closeReviewedRun = async (ctx: ExtensionContext): Promise<PlaybookRun> => {
    if (!activeRun || activeRun.status !== "review" || !activeRun.completionReview) {
      throw new Error("No playbook run is ready to close. Complete the work and wait for Pi to submit it for review first.");
    }
    const review = activeRun.completionReview;
    activeRun.status = review.outcome === "success" ? "completed" : review.outcome === "failure" ? "failed" : "abandoned";
    activeRun.completion = {
      summary: review.summary,
      completedAt: new Date().toISOString(),
      predicateResults: review.predicateResults,
    };
    delete activeRun.completionReview;
    await runs.save(activeRun);
    await appendFact(ctx, {
      type: `RUN_${activeRun.status.toUpperCase()}`,
      toolName: "playbook_close",
      enforcementLevel: "guarded",
      reason: review.summary,
      data: { predicateResults: review.predicateResults, userConfirmed: true },
    });
    const completedRun = activeRun;
    await setActive(undefined, ctx);

    const theme = ctx.ui.theme;
    const successful = completedRun.status === "completed";
    ctx.ui.notify([
      theme.fg(successful ? "success" : "warning", theme.bold(`Playbook run ${completedRun.status}`)),
      `${completedRun.playbookName} · ${completedRun.runId}`,
      review.summary,
      "",
      theme.fg("accent", "Pi will now learn from this run automatically."),
      theme.fg("muted", "If a safe, material improvement is found, you will only be asked whether to approve it."),
      "",
      theme.fg("muted", "The Pi conversation remains open even though the governed run is closed."),
    ].join("\n"), successful ? "info" : "warning");
    return completedRun;
  };

  const startDraft = async (
    runId: string,
    destinationArgument: string | undefined,
    ctx: ExtensionContext,
    workflow: "manual" | "automatic" = "manual",
  ): Promise<void> => {
    if (activeRun) throw new Error("Finish or detach the active run before starting a learning draft");
    const run = await runs.read(runId);
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "abandoned") {
      throw new Error(`Run ${runId} is not closed yet. Review it and use /playbook close first.`);
    }
    const defaultDirectoryName = `${run.playbookName}-${run.runId.slice(0, 8)}`;
    const destination = resolve(ctx.cwd, destinationArgument ?? join(CONFIG_DIR_NAME, "playbooks", "candidates", defaultDirectoryName));
    const proposeCommand = destinationArgument
      ? `/playbook propose ${JSON.stringify(relative(ctx.cwd, destination) || destination)} ${run.artifactDigest} ${run.runId}`
      : `/playbook propose ${defaultDirectoryName}`;
    await artifacts.materializeForRevision(run.artifactDigest, destination);
    await writeCandidateMetadata(destination, { baseDigest: run.artifactDigest, runId, workflow });
    const runFacts = (await ledger.readAll()).filter((fact) => fact.runId === runId).slice(-100);
    const commandEvidence = await commandEvidenceFromSession(
      run.sessionFile,
      run.startedAt,
      run.completion?.completedAt ?? run.updatedAt,
    );
    const adHocGuidance = run.releaseScope === "explicit-digest"
      ? "\nThis began as an ad hoc workflow. If the trajectory contains a genuinely reusable procedure, replace the generic instructions with that procedure and refine the contract description while keeping the user-selected playbook name unless they request a rename. Do not invent reusable instructions when the evidence supports only a one-off task. Add skillDependencies only when they materially improve the workflow."
      : "";
    const completionInstruction = workflow === "automatic"
      ? `When the analysis is complete, you MUST call playbook_complete_learning exactly once with runId ${runId}. Use decision no_change when the evidence does not support a safe, material procedural improvement. Use decision propose only after editing the candidate. Do not ask the user to manage files, digests, proposals, or commands; the tool performs deterministic evaluation and presents the only required approval.`
      : `When finished, ask the user to review and run:\n${proposeCommand}`;
    suppressAutomaticOnce = true;
    pi.sendUserMessage(`Review the completed playbook run ${runId} and identify the smallest evidence-supported procedural improvement.\n\nBase digest: ${run.artifactDigest}\nEditable candidate directory: ${destination}\nOriginal request: ${run.originalPrompt}\nTerminal status: ${run.status}\nCompletion: ${JSON.stringify(run.completion ?? null)}\nEvidence facts (execution-correlated, not causal claims):\n${JSON.stringify(runFacts, null, 2)}\nDeterministic command evidence (minimized from the Pi-owned session trace; command outputs and non-command arguments are omitted):\n${JSON.stringify(commandEvidence, null, 2)}\n\nEdit only the candidate directory, preserve the playbook structure and any declared skill dependencies, increment the source version when materially changed, and do not activate it.${adHocGuidance}\n\nExplicitly evaluate the command evidence for a token- or time-saving deterministic fast path. Add automation only when the observed trajectory supports it:\n1. Prefer a consolidated command when it can replace several observed smaller commands while preserving their checks and failure semantics.\n2. Add a helper under scripts/ only when repeated, stable command sequences justify maintaining one.\nRecord the supporting commands and outcomes in the candidate procedure, plus applicability guards. A successful observed command is evidence that it ran in this trajectory, not proof that it is universally correct. Never invent a command from argument hashes, promote an unexecuted optimization, copy likely credentials, or add a speculative helper. If evidence is insufficient, leave automation out.\n\n${completionInstruction}`);
    const theme = ctx.ui.theme;
    ctx.ui.notify([
      theme.fg("success", theme.bold(workflow === "automatic" ? "Automatic playbook learning started" : "Playbook improvement workspace created")),
      workflow === "automatic" ? theme.fg("muted", "Pi is analyzing the run; no draft or proposal commands are needed.") : destination,
      "",
      workflow === "automatic"
        ? theme.fg("text", "You will be asked only if Pi finds an improvement that passes deterministic checks.")
        : theme.fg("text", "When the review is ready, Pi will give you a /playbook propose command."),
      workflow === "automatic"
        ? theme.fg("muted", "The approved playbook remains unchanged until you approve the candidate.")
        : theme.fg("muted", "After proposing, you will be able to promote or reject the candidate."),
    ].join("\n"), "info");
  };

  pi.on("session_start", async (_event, ctx) => {
    const found = await runs.activeForSession(ctx.sessionManager.getSessionId());
    if (found.length > 1) {
      ctx.ui.notify("Multiple active playbook runs reference this session; use /playbook resume <runId>", "error");
      await setActive(undefined, ctx);
      return;
    }
    await setActive(found[0], ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (!activeRun?.branchRootEntryId) return;
    const onAssignedBranch = ctx.sessionManager.getBranch().some((entry) => entry.id === activeRun?.branchRootEntryId);
    if (!onAssignedBranch) {
      await appendFact(ctx, { type: "RUN_DETACHED_FROM_BRANCH", reason: "active branch no longer contains assignment root" });
      await setActive(undefined, ctx);
      ctx.ui.notify("Playbook run detached because the session tree moved before its assignment", "warning");
    }
  });

  pi.on("input", async (event, ctx) => {
    if (activeRun?.status === "paused" && activeRun.pendingGate) {
      if (event.text.trim().toLowerCase() === "approved") {
        await approveGate(ctx);
      } else {
        const gate = activeRun.pendingGate;
        activeRun.status = "running";
        delete activeRun.pendingGate;
        await runs.save(activeRun);
        await appendFact(ctx, { type: "GATE_REVISION_REQUESTED", reason: gate.id, data: { gatePromptHash: hashArguments(gate.prompt) } });
        await setActive(activeRun, ctx);
      }
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!activeRun && suppressAutomaticOnce) {
      suppressAutomaticOnce = false;
    } else if (!activeRun) {
      const automatic = await resolveAutomatic(ctx.cwd, artifacts, personal, teamRegistryFor(ctx));
      if (automatic.conflicts.length > 1) {
        await appendFact(ctx, {
          type: "APPLICABILITY_CONFLICT",
          reason: "same-priority applicability conflict; no implicit winner",
          data: { candidates: automatic.conflicts.map(({ name, digest, scope }) => ({ name, digest, scope })) },
        });
        ctx.ui.notify(`Playbook conflict: ${automatic.conflicts.map((item) => item.name).join(", ")}`, "error");
      } else if (automatic.match) {
        await createRun(automatic.match, event.prompt, ctx);
      }
    }
    if (!activeRun || !activeContract) return;

    await artifacts.verify(activeRun.artifactDigest);
    const procedure = await artifacts.procedure(activeRun.artifactDigest);
    const root = artifacts.contentRoot(activeRun.artifactDigest);
    const skillDependencyText = activeContract.skillDependencies?.length
      ? `\nOptional sealed Agent Skills available to this workflow (read their SKILL.md only when needed):\n${activeContract.skillDependencies.map((path) => `- ${join(root, path, "SKILL.md")}`).join("\n")}`
      : "";
    const gateText = activeRun.pendingGate
      ? `\nThis run is PAUSED at gate ${activeRun.pendingGate.id}: ${activeRun.pendingGate.prompt}\nDo not perform later stages until the user explicitly approves. Revisions to the pending stage are allowed.`
      : "";
    const reviewText = activeRun.status === "review" && activeRun.completionReview
      ? `\nThis run is IN REVIEW. Proposed outcome: ${activeRun.completionReview.outcome}. The user may ask questions or request changes, and all resulting work remains inside this governed run. Do not restart the procedure unnecessarily. If material changes alter the result, call playbook_finish again with an updated outcome and summary. Only the user closes the run with /playbook close.`
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n# Active governed playbook\nRun ID: ${activeRun.runId}\nAssignment ID: ${activeRun.assignmentId}\nPinned artifact: ${activeRun.artifactDigest}\nImmutable playbook root: ${root}\nResolve all playbook-relative references, optional skills, and scripts beneath that root. Write declared run artifacts relative to the run cwd: ${activeRun.cwd}. The assignment remains fixed for the entire run. Use playbook_checkpoint at durable stage boundaries and use playbook_finish when work is ready for user review; the user explicitly closes the run after follow-ups.${skillDependencyText}${gateText}${reviewText}\n\n<playbook-procedure>\n${procedure}\n</playbook-procedure>`,
    };
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!activeRun) return;
    await appendFact(ctx, {
      type: "PROPOSED",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsHash: hashArguments(event.args),
      reason: "Pi emitted tool intent before tool_call handlers",
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activeRun || !activeContract) return;
    const input = event.input as Record<string, unknown>;
    const argsHash = hashArguments(input);
    if (activeRun.status === "paused" || (batchBarrierToolCallId && batchBarrierToolCallId !== event.toolCallId)) {
      blockedCalls.add(event.toolCallId);
      await appendFact(ctx, { type: "BLOCKED", toolCallId: event.toolCallId, toolName: event.toolName, argsHash, policyVersion: POLICY_VERSION, reason: activeRun.status === "paused" ? "playbook is paused at a workflow gate" : "a gate or terminal action earlier in this parallel batch established a safety barrier" });
      return { block: true, reason: "Playbook workflow barrier is active" };
    }
    if ((event.toolName === "playbook_checkpoint" && input.gate) || event.toolName === "playbook_finish") {
      batchBarrierToolCallId = event.toolCallId;
    }
    try {
      await artifacts.verify(activeRun.artifactDigest);
      const staleReason = verifyToolAttestations(activeRun.toolAttestations, toolMetadata(pi));
      if (staleReason) throw new Error(staleReason);
    } catch (error) {
      blockedCalls.add(event.toolCallId);
      await appendFact(ctx, {
        type: "BLOCKED",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsHash,
        reason: `pre-effect attestation failed: ${(error as Error).message}`,
      });
      return { block: true, reason: "Playbook assignment attestation failed" };
    }

    const decision = decide(activeContract, event.toolName, input);
    if (decision.decision === "deny") {
      blockedCalls.add(event.toolCallId);
      await appendFact(ctx, {
        type: "BLOCKED",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        argsHash,
        enforcementLevel: decision.enforcementLevel,
        policyVersion: POLICY_VERSION,
        reason: decision.reason,
      });
      return { block: true, reason: decision.reason };
    }
    if (decision.decision === "require_approval") {
      if (!ctx.hasUI) {
        blockedCalls.add(event.toolCallId);
        await appendFact(ctx, { type: "BLOCKED", toolCallId: event.toolCallId, toolName: event.toolName, argsHash, enforcementLevel: decision.enforcementLevel, policyVersion: POLICY_VERSION, reason: "approval required but no UI is available" });
        return { block: true, reason: "Approval required but unavailable" };
      }
      const approved = await ctx.ui.confirm(
        `Approve one ${event.toolName} action?`,
        `${JSON.stringify(input, null, 2)}\n\nPlaybook: ${activeRun.playbookName}\nDigest: ${activeRun.artifactDigest.slice(0, 12)}…\nReason: ${decision.reason}`,
      );
      if (!approved) {
        blockedCalls.add(event.toolCallId);
        await appendFact(ctx, { type: "USER_REJECTED", toolCallId: event.toolCallId, toolName: event.toolName, argsHash, enforcementLevel: decision.enforcementLevel, policyVersion: POLICY_VERSION, reason: decision.reason });
        return { block: true, reason: "Action rejected by user" };
      }
    }
    await appendFact(ctx, {
      type: "AUTHORIZED",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsHash,
      enforcementLevel: decision.enforcementLevel,
      policyVersion: POLICY_VERSION,
      reason: decision.reason,
      data: { effectClass: decision.effectClass },
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    if (batchBarrierToolCallId === event.toolCallId) batchBarrierToolCallId = undefined;
    if (!activeRun) return;
    if (blockedCalls.delete(event.toolCallId)) return;
    await appendFact(ctx, {
      type: event.isError ? "FAILED" : "SUCCEEDED",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      argsHash: hashArguments(event.input),
      reason: event.isError ? "tool returned an error" : "tool returned successfully",
    });
  });

  pi.on("user_bash", async (event, ctx) => {
    if (!activeRun || !activeContract) return;
    const decision = decide(activeContract, "bash", { command: event.command });
    const argsHash = hashArguments({ command: event.command });
    if (decision.decision === "deny" || (decision.decision === "require_approval" && !ctx.hasUI)) {
      await appendFact(ctx, { type: "BLOCKED", toolName: "user_bash", argsHash, enforcementLevel: "observed", policyVersion: POLICY_VERSION, reason: decision.reason });
      return { result: { output: `Blocked by active playbook: ${decision.reason}`, exitCode: 126, cancelled: false, truncated: false } };
    }
    if (decision.decision === "require_approval") {
      const approved = await ctx.ui.confirm("Approve one user shell command?", `${event.command}\n\n${decision.reason}`);
      if (!approved) {
        await appendFact(ctx, { type: "USER_REJECTED", toolName: "user_bash", argsHash, enforcementLevel: "observed", policyVersion: POLICY_VERSION, reason: decision.reason });
        return { result: { output: "Rejected by user", exitCode: 126, cancelled: false, truncated: false } };
      }
    }
    await appendFact(ctx, { type: "AUTHORIZED", toolName: "user_bash", argsHash, enforcementLevel: "observed", policyVersion: POLICY_VERSION, reason: decision.reason });
  });

  pi.registerTool({
    name: "playbook_complete_learning",
    label: "Complete playbook learning",
    description: "Complete automatic learning for a closed playbook run. Either record that no material change is supported, or seal, evaluate, and present an evidence-linked candidate for one-step user approval.",
    promptSnippet: "Finalize automatic playbook learning without exposing draft, proposal, or digest mechanics",
    promptGuidelines: ["Use playbook_complete_learning exactly once when an automatic playbook-learning review instructs you to complete it."],
    parameters: CompleteLearningParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const run = await runs.read(params.runId);
      if (run.status !== "completed" && run.status !== "failed" && run.status !== "abandoned") {
        throw new Error("Automatic learning requires a closed evidence run");
      }
      const candidateRoot = join(run.cwd, CONFIG_DIR_NAME, "playbooks", "candidates");
      const matches = (await listProjectCandidates(candidateRoot)).filter((candidate) =>
        candidate.metadata?.runId === run.runId && candidate.metadata.workflow === "automatic",
      );
      if (matches.length !== 1 || !matches[0]?.contract) {
        throw new Error("Automatic learning workspace is missing or ambiguous");
      }
      const candidate = matches[0];
      if (candidate.metadata?.baseDigest !== run.artifactDigest) {
        throw new Error("Automatic learning workspace does not match the evidence run base");
      }

      if (params.decision === "no_change") {
        await ledger.append({
          type: "LEARNING_NO_CHANGE",
          runId: run.runId,
          assignmentId: run.assignmentId,
          artifactDigest: run.artifactDigest,
          toolCallId,
          toolName: "playbook_complete_learning",
          enforcementLevel: "guarded",
          reason: params.summary,
        });
        await rm(candidate.sourcePath, { recursive: true, force: true });
        return {
          content: [{ type: "text", text: "Automatic learning completed: the evidence did not support a safe, material playbook change. The temporary workspace was removed." }],
          details: { runId: run.runId, decision: "no_change" },
        };
      }

      const manifest = await artifacts.seal(candidate.sourcePath);
      const evaluation = await evaluateCandidate(artifacts, run, manifest.digest);
      const baseContract = await artifacts.contract(run.artifactDigest);
      const team = teamRegistryFor(ctx);
      const current = await personal.resolve(manifest.contract.name) ?? await team?.resolve(manifest.contract.name);
      const unpublishedBase = !current && (run.releaseScope === "explicit-digest" || run.releaseScope === "project-candidate");
      const lineageCurrent = current?.digest === run.artifactDigest || unpublishedBase;
      const facts = (await ledger.readAll()).filter((fact) => fact.runId === run.runId);
      const existingProposal = (await proposals.list()).find((item) =>
        item.candidateDigest === manifest.digest && item.evidenceRunIds.includes(run.runId),
      );
      if (existingProposal?.status === "promoted") {
        return {
          content: [{ type: "text", text: `This learned update to ${manifest.contract.name} was already approved for future runs.` }],
          details: { runId: run.runId, proposalId: existingProposal.proposalId, decision: "already_promoted", digest: manifest.digest },
        };
      }
      if (existingProposal?.status === "rejected" || existingProposal?.status === "stale") {
        throw new Error(`This automatic candidate was already ${existingProposal.status}; create new evidence before reconsidering it`);
      }
      const proposal = existingProposal ?? await proposals.create({
        name: manifest.contract.name,
        candidateDigest: manifest.digest,
        baseDigest: run.artifactDigest,
        evidenceRunIds: [run.runId],
        ...(facts.at(-1) ? { evidenceWatermark: facts.at(-1)!.factId } : {}),
        rationale: params.summary,
      });

      if (!lineageCurrent || !evaluation.passed) {
        proposal.status = lineageCurrent ? "rejected" : "stale";
        await proposals.save(proposal);
        await ledger.append({
          type: lineageCurrent ? "CANDIDATE_EVALUATION_FAILED" : "CANDIDATE_STALE",
          runId: run.runId,
          assignmentId: run.assignmentId,
          artifactDigest: manifest.digest,
          reason: lineageCurrent
            ? evaluation.checks.filter((check) => !check.passed).map((check) => check.reason).join("; ")
            : "approved release changed before automatic proposal submission",
          data: { proposalId: proposal.proposalId, checks: evaluation.checks, changes: evaluation.changes },
        });
        throw new Error(lineageCurrent
          ? `Candidate did not pass deterministic evaluation: ${evaluation.checks.filter((check) => !check.passed).map((check) => check.reason).join("; ")}`
          : "Candidate became stale before evaluation; the approved playbook was not changed");
      }

      await ledger.append({
        type: "CANDIDATE_EVALUATION_PASSED",
        runId: run.runId,
        assignmentId: run.assignmentId,
        artifactDigest: manifest.digest,
        reason: params.summary,
        data: { proposalId: proposal.proposalId, checks: evaluation.checks, changes: evaluation.changes },
      });

      const changed = [
        ...evaluation.changes.added.map((path) => `+ ${path}`),
        ...evaluation.changes.modified.map((path) => `~ ${path}`),
        ...evaluation.changes.removed.map((path) => `- ${path}`),
      ];
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: `Candidate ${proposal.proposalId} passed deterministic evaluation and awaits human approval. In an interactive session, review it with /playbook list and promote or reject it.` }],
          details: { runId: run.runId, proposalId: proposal.proposalId, decision: "awaiting_approval", evaluation },
        };
      }

      const approved = await ctx.ui.confirm(
        `Approve learned update to ${proposal.name}?`,
        `${params.summary}\n\nSource version: ${baseContract.version} → ${manifest.contract.version}\nVerified changes:\n${changed.map((line) => `  ${line}`).join("\n")}\n\nThe candidate passed ${evaluation.checks.length} deterministic checks. Approval affects future runs only; the evidence run remains pinned to its original version.`,
      );
      if (!approved) {
        proposal.status = "rejected";
        await proposals.save(proposal);
        await ledger.append({
          type: "CANDIDATE_REJECTED",
          runId: run.runId,
          assignmentId: run.assignmentId,
          artifactDigest: manifest.digest,
          reason: "user declined automatic promotion",
          data: { proposalId: proposal.proposalId, fingerprint: proposal.fingerprint },
        });
        return {
          content: [{ type: "text", text: "The user declined the learned update. The approved playbook remains unchanged." }],
          details: { runId: run.runId, proposalId: proposal.proposalId, decision: "rejected" },
        };
      }

      await artifacts.verify(manifest.digest);
      const latest = await personal.resolve(manifest.contract.name) ?? await team?.resolve(manifest.contract.name);
      const latestLineageCurrent = latest?.digest === run.artifactDigest || (!latest && unpublishedBase);
      if (!latestLineageCurrent) {
        proposal.status = "stale";
        await proposals.save(proposal);
        throw new Error("The approved release changed during review; promotion was blocked as stale");
      }
      await personal.promote(manifest.contract.name, manifest.digest);
      proposal.status = "promoted";
      await proposals.save(proposal);
      await ledger.append({
        type: "PROMOTED",
        runId: run.runId,
        assignmentId: run.assignmentId,
        artifactDigest: manifest.digest,
        reason: `human-approved automatic personal promotion of ${manifest.contract.name}`,
        data: { proposalId: proposal.proposalId, baseDigest: run.artifactDigest },
      });
      return {
        content: [{ type: "text", text: `The learned update to ${manifest.contract.name} was approved and will be used for future runs. No draft, proposal, or promotion command is needed.` }],
        details: { runId: run.runId, proposalId: proposal.proposalId, decision: "promoted", digest: manifest.digest, evaluation },
      };
    },
  });

  pi.registerTool({
    name: "playbook_checkpoint",
    label: "Playbook checkpoint",
    description: "Persist a governed playbook stage checkpoint, hash stage artifacts, and optionally pause at a workflow approval gate.",
    promptSnippet: "Record durable playbook stage boundaries and approval gates",
    promptGuidelines: ["Use playbook_checkpoint at every stage boundary required by the active governed playbook."],
    parameters: CheckpointParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeRun) throw new Error("No active playbook run");
      await appendFact(ctx, { type: "STARTED", toolCallId, toolName: "playbook_checkpoint", argsHash: hashArguments(params), enforcementLevel: "guarded", reason: "guarded checkpoint execution began with schema-validated final arguments" });
      const artifactHashes = [];
      for (const path of params.artifactPaths ?? []) artifactHashes.push(await hashRunArtifact(activeRun.cwd, path));
      activeRun.currentStage = params.stage;
      if (params.gate) {
        activeRun.status = "paused";
        activeRun.pendingGate = { id: params.gate.id, prompt: params.gate.prompt, requestedAt: new Date().toISOString() };
      }
      await runs.save(activeRun);
      await appendFact(ctx, {
        type: params.gate ? "GATE_REQUESTED" : "CHECKPOINT",
        toolCallId,
        toolName: "playbook_checkpoint",
        enforcementLevel: "guarded",
        reason: params.summary,
        data: { stage: params.stage, artifacts: artifactHashes, ...(params.gate ? { gateId: params.gate.id } : {}) },
      });
      await setActive(activeRun, ctx);
      return {
        content: [{ type: "text", text: params.gate ? `Checkpoint ${params.stage} saved; run paused for approval at ${params.gate.id}.` : `Checkpoint ${params.stage} saved.` }],
        details: { runId: activeRun.runId, stage: params.stage, artifacts: artifactHashes, paused: Boolean(params.gate) },
      };
    },
  });

  pi.registerTool({
    name: "playbook_finish",
    label: "Submit playbook for review",
    description: "Mark the active governed run ready for user review after evaluating its deterministic completion predicates. The run remains active for follow-up questions and changes until the user closes it.",
    promptSnippet: "Submit a playbook outcome for user review without closing the run",
    promptGuidelines: ["Use playbook_finish when the requested work is ready for user review, and use it again if material follow-up changes alter the proposed outcome."],
    parameters: FinishParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeRun || !activeContract) throw new Error("No active playbook run");
      if (activeRun.pendingGate) throw new Error("Cannot finish while an approval gate is pending");
      await appendFact(ctx, { type: "STARTED", toolCallId, toolName: "playbook_finish", argsHash: hashArguments(params), enforcementLevel: "guarded", reason: "guarded completion evaluation began with schema-validated final arguments" });
      const predicateResults = await evaluatePredicates(activeContract, activeRun.cwd);
      if (params.outcome === "success" && predicateResults.some((result) => !result.passed)) {
        throw new Error(`Success predicates failed: ${predicateResults.filter((result) => !result.passed).map((result) => result.reason).join("; ")}`);
      }
      activeRun.status = "review";
      activeRun.completionReview = {
        outcome: params.outcome,
        summary: params.summary,
        proposedAt: new Date().toISOString(),
        predicateResults,
      };
      await runs.save(activeRun);
      await appendFact(ctx, {
        type: "COMPLETION_PROPOSED",
        toolCallId,
        toolName: "playbook_finish",
        enforcementLevel: "guarded",
        reason: params.summary,
        data: { outcome: params.outcome, predicateResults },
      });
      await setActive(activeRun, ctx);
      const theme = ctx.ui.theme;
      ctx.ui.notify([
        theme.fg("success", theme.bold("Work is ready for your review")),
        `${activeRun.playbookName} · ${activeRun.runId}`,
        params.summary,
        "",
        theme.fg("text", "Ask questions or request changes normally; they remain part of this governed run."),
        `When satisfied, close it with ${theme.fg("success", "/playbook close")}`,
      ].join("\n"), "info");
      return {
        content: [{
          type: "text",
          text: `The proposed ${params.outcome} outcome is ready for user review. The run remains active. Answer follow-up questions and make requested changes within this playbook; the user will close it with /playbook close.`,
        }],
        details: { runId: activeRun.runId, status: activeRun.status, proposedOutcome: params.outcome, predicateResults },
      };
    },
  });

  pi.registerCommand("playbook", {
    description: "Governed playbooks: create, run, improve, approve, and reuse reliable workflows",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix)) return null;
      const items = COMMAND_HELP
        .filter(([name]) => name.startsWith(prefix))
        .map(([name, usage, description]) => ({ value: name, label: usage, description }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        const words = parseWords(args);
        const knownCommands = new Set(COMMAND_HELP.map(([name]) => name));
        const team = teamRegistryFor(ctx);
        const nameAndStart = async (prompt: string) => {
          if (!ctx.hasUI) throw new Error("This mode cannot ask for a name. Use /playbook run <name> <request>");
          let name: string | undefined;
          while (!name) {
            const entered = await ctx.ui.input("Name this playbook", suggestedPlaybookName(prompt));
            if (!entered?.trim()) return;
            if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entered)) name = entered;
            else ctx.ui.notify("Use lowercase letters, numbers, and single hyphens (for example: heroku-deploy)", "warning");
          }
          const release = await adHocRelease(name);
          const run = await createRun(release, prompt, ctx);
          notifyRunStarted(run, release, ctx);
          pi.sendUserMessage(prompt);
        };

        if (words.length === 0) {
          if (activeRun) {
            const theme = ctx.ui.theme;
            const lines = [
              theme.fg("accent", theme.bold(activeRun.playbookName)),
              `Run ID: ${activeRun.runId}`,
              `Status: ${activeRun.status} · Stage: ${activeRun.currentStage ?? "not set"}`,
            ];
            if (activeRun.pendingGate) {
              lines.push(
                "",
                theme.fg("warning", `Waiting for your approval: ${activeRun.pendingGate.prompt}`),
                `Continue with ${theme.fg("success", "/playbook approve")}`,
              );
            } else if (activeRun.status === "review") {
              lines.push(
                "",
                theme.fg("accent", "Ready for your review. Ask questions or request changes normally."),
                `When satisfied: ${theme.fg("success", "/playbook close")}`,
              );
            } else {
              lines.push("", theme.fg("muted", "Use /playbook status for details or /playbook abort <reason> to stop."));
            }
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify("Use /playbook run <name> [request]", "info");
            return;
          }
          const prompt = await ctx.ui.input("What would you like Pi to do?", "Describe a workflow or task");
          if (!prompt?.trim()) return;
          await nameAndStart(prompt.trim());
          return;
        }

        const command = words.shift()!;
        if (!knownCommands.has(command)) {
          const theme = ctx.ui.theme;
          const help = [
            theme.fg("error", theme.bold(`Unknown playbook command: ${JSON.stringify(command)}`)),
            "",
            theme.fg("text", "Workflow requests are not accepted directly after /playbook."),
            theme.fg("muted", "Start interactively with /playbook, or use the explicit run command:"),
            `  ${theme.fg("success", "/playbook run <playbook-name> [request]")}`,
            "",
            theme.fg("accent", theme.bold("Playbook commands")),
            ...COMMAND_HELP.flatMap(([, usage, description]) => [
              `  ${theme.fg("accent", `/playbook ${usage}`)}`,
              `    ${theme.fg("muted", description)}`,
            ]),
          ];
          ctx.ui.notify(help.join("\n"), "error");
          return;
        }
        if (command === "seal") {
          const source = words[0];
          if (!source) throw new Error("Usage: /playbook seal <source-directory>");
          const manifest = await artifacts.seal(resolve(ctx.cwd, source));
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("success", theme.bold(`Sealed ${manifest.contract.name}@${manifest.contract.version}`)),
            `Artifact: ${manifest.digest}`,
            "",
            theme.fg("text", "For a new playbook, approve it with:"),
            `  ${theme.fg("success", `/playbook promote ${manifest.digest}`)}`,
            theme.fg("muted", "Updates to an approved playbook must go through the proposal review flow."),
          ].join("\n"), "info");
          return;
        }
        if (command === "draft") {
          const runId = words.shift();
          if (!runId) throw new Error("Usage: /playbook draft <runId> [destination]");
          await startDraft(runId, words[0], ctx);
          return;
        }
        if (command === "propose") {
          let source: string | undefined;
          let baseToken: string | undefined;
          let runToken: string | undefined;
          const explicitForm = words.length >= 3 && (words[1] === "new" || /^[a-f0-9]{64}$/.test(words[1]!)) && (words[2] === "none" || /^[a-f0-9-]{36}$/.test(words[2]!));
          if (explicitForm) {
            source = words.shift();
            baseToken = words.shift();
            runToken = words.shift();
          } else {
            const selector = words.shift();
            if (!selector) throw new Error("Usage: /playbook propose <candidate>");
            if (!ctx.isProjectTrusted()) throw new Error("Project candidate discovery requires a trusted project");
            const candidate = selectProjectCandidate(
              await listProjectCandidates(join(ctx.cwd, CONFIG_DIR_NAME, "playbooks", "candidates")),
              selector,
            );
            if (!candidate) throw new Error(`No local candidate found for ${selector}. Use /playbook list to see candidate directory names.`);
            source = candidate.sourcePath;
            let evidenceRun = candidate.metadata ? await runs.read(candidate.metadata.runId) : undefined;
            if (!evidenceRun) {
              const conventionMatches = (await runs.list()).filter((run) =>
                candidate.directoryName === `${run.playbookName}-${run.runId.slice(0, 8)}`,
              );
              if (conventionMatches.length === 1) evidenceRun = conventionMatches[0];
            }
            const currentRelease = await personal.resolve(candidate.contract!.name) ?? await team?.resolve(candidate.contract!.name);
            baseToken = candidate.metadata?.baseDigest ?? evidenceRun?.artifactDigest ?? currentRelease?.digest ?? "new";
            runToken = candidate.metadata?.runId ?? evidenceRun?.runId ?? "none";
          }
          if (!source || !baseToken || !runToken) throw new Error("Usage: /playbook propose <candidate>");
          const manifest = await artifacts.seal(resolve(ctx.cwd, source));
          const baseDigest = baseToken === "new" ? undefined : baseToken;
          if (baseDigest === manifest.digest) throw new Error("Candidate is byte-identical to its base artifact");
          const evidenceRunIds = runToken === "none" ? [] : [runToken];
          let evidenceRun: PlaybookRun | undefined;
          if (runToken !== "none") {
            evidenceRun = await runs.read(runToken);
            if (baseDigest && evidenceRun.artifactDigest !== baseDigest) throw new Error("Evidence run was not assigned to the proposed base digest");
          }
          const current = await personal.resolve(manifest.contract.name) ?? await team?.resolve(manifest.contract.name);
          const facts = await ledger.readAll();
          const relevantFacts = evidenceRunIds.length ? facts.filter((fact) => fact.runId && evidenceRunIds.includes(fact.runId)) : facts;
          const proposal = await proposals.create({
            name: manifest.contract.name,
            candidateDigest: manifest.digest,
            ...(baseDigest ? { baseDigest } : {}),
            evidenceRunIds,
            ...(relevantFacts.at(-1) ? { evidenceWatermark: relevantFacts.at(-1)!.factId } : {}),
            rationale: words.join(" ") || "agent-proposed procedural revision",
          });
          const derivedFromAdHoc = Boolean(
            baseDigest &&
            !current &&
            evidenceRun?.releaseScope === "explicit-digest" &&
            evidenceRun.artifactDigest === baseDigest,
          );
          const lineageCurrent = baseDigest ? current?.digest === baseDigest || derivedFromAdHoc : !current;
          if (!lineageCurrent) {
            proposal.status = "stale";
            await proposals.save(proposal);
          }
          await ledger.append({ type: lineageCurrent ? "CANDIDATE_PROPOSED" : "CANDIDATE_STALE", artifactDigest: manifest.digest, reason: proposal.rationale, data: { proposalId: proposal.proposalId, baseDigest: baseDigest ?? null, evidenceRunIds } });
          const theme = ctx.ui.theme;
          ctx.ui.notify(lineageCurrent
            ? [
                theme.fg("success", theme.bold(`Reusable playbook candidate ready: ${proposal.name}`)),
                `Proposal ID: ${theme.fg("accent", proposal.proposalId)}`,
                theme.fg("muted", proposal.rationale),
                "",
                theme.fg("text", "Review the candidate, then choose:"),
                `  ${theme.fg("success", `/playbook promote ${proposal.proposalId}`)}`,
                `    ${theme.fg("muted", "Approve it for future runs.")}`,
                `  ${theme.fg("warning", `/playbook reject ${proposal.proposalId} <reason>`)}`,
                `    ${theme.fg("muted", "Discard it without changing the approved playbook.")}`,
              ].join("\n")
            : [
                theme.fg("warning", theme.bold(`Candidate is stale: ${proposal.name}`)),
                `Proposal ID: ${proposal.proposalId}`,
                theme.fg("muted", "The approved playbook changed after this candidate's base version. Regenerate or rebase it before promotion."),
              ].join("\n"), lineageCurrent ? "info" : "warning");
          return;
        }
        if (command === "reject") {
          const proposalId = words.shift();
          if (!proposalId) throw new Error("Usage: /playbook reject <proposalId> [reason]");
          const proposal = await proposals.read(proposalId);
          assertProposalIsProposed(proposal, "reject");
          proposal.status = "rejected";
          await proposals.save(proposal);
          await ledger.append({ type: "CANDIDATE_REJECTED", artifactDigest: proposal.candidateDigest, reason: words.join(" ") || "manual rejection", data: { proposalId, fingerprint: proposal.fingerprint } });
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("warning", theme.bold(`Rejected proposal for ${proposal.name}`)),
            theme.fg("muted", "The currently approved playbook was not changed."),
            `View remaining playbooks and proposals with ${theme.fg("accent", "/playbook list")}`,
          ].join("\n"), "warning");
          return;
        }
        if (command === "promote") {
          const token = words[0];
          if (!token) throw new Error("Usage: /playbook promote <proposalId|digest>");
          const allProposals = await proposals.list();
          const proposal = allProposals.find((candidate) => candidate.proposalId === token || candidate.candidateDigest === token);
          if (proposal) assertProposalIsProposed(proposal, "promote");
          const digest = proposal?.candidateDigest ?? token;
          const contract = await artifacts.contract(digest);
          await artifacts.verify(digest);
          const current = await personal.resolve(contract.name) ?? await team?.resolve(contract.name);
          if (current) {
            if (!proposal) throw new Error("Updates to an existing release must be promoted through a candidate proposal");
            if (proposal.baseDigest !== current.digest) {
              proposal.status = "stale";
              await proposals.save(proposal);
              throw new Error("Proposal base is stale; rebase or regenerate it");
            }
          }
          await personal.promote(contract.name, digest);
          if (proposal) { proposal.status = "promoted"; await proposals.save(proposal); }
          await ledger.append({ type: "PROMOTED", artifactDigest: digest, reason: `manual personal promotion of ${contract.name}`, data: proposal ? { proposalId: proposal.proposalId } : { bootstrap: true } });
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("success", theme.bold(`Playbook approved: ${contract.name}`)),
            theme.fg("muted", `Version ${digest.slice(0, 12)}… is now used for future runs.`),
            "",
            theme.fg("text", "Run it again with:"),
            `  ${theme.fg("success", `/playbook run ${contract.name}`)}`,
            theme.fg("muted", "Use /playbook list whenever you need to find approved playbook names."),
          ].join("\n"), "info");
          return;
        }
        if (command === "rollback") {
          const name = words[0];
          if (!name) throw new Error("Usage: /playbook rollback <name>");
          const pointer = await personal.rollback(name);
          await ledger.append({ type: "ROLLED_BACK", artifactDigest: pointer.digest, reason: `manual rollback of ${name}` });
          ctx.ui.notify(`Rolled ${name} back to ${pointer.digest.slice(0, 12)}…; active runs remain pinned`, "warning");
          return;
        }
        if (command === "run") {
          const name = words.shift();
          if (!name) throw new Error("Usage: /playbook run <playbook-name> [request]");
          let prompt = words.join(" ");
          let release = await resolveNamed(name, artifacts, personal, team)
            ?? await projectCandidateRelease(name, ctx);
          if (!release) {
            if (!prompt) {
              throw new Error(`No approved playbook or local candidate named ${name}. Provide a request to create an ad hoc workflow: /playbook run ${name} <request>`);
            }
            release = await adHocRelease(name);
          } else if (!prompt) {
            prompt = `Run the ${name} playbook as written. Its procedure and the current working directory define the complete workflow; no additional request was supplied.`;
          }
          const run = await createRun(release, prompt, ctx);
          notifyRunStarted(run, release, ctx);
          pi.sendUserMessage(prompt);
          return;
        }
        if (command === "approve") {
          await approveGate(ctx);
          ctx.ui.notify("Playbook gate approved. Send the next instruction or continue the workflow.", "info");
          return;
        }
        if (command === "close") {
          if (!activeRun || activeRun.status !== "review" || !activeRun.completionReview) {
            throw new Error("No playbook run is ready to close. Complete the work and wait for Pi to submit it for review first.");
          }
          const completedRun = await closeReviewedRun(ctx);
          await startDraft(completedRun.runId, undefined, ctx, "automatic");
          return;
        }
        if (command === "resume") {
          const runId = words[0];
          if (!runId) throw new Error("Usage: /playbook resume <runId>");
          if (activeRun) throw new Error(`Run ${activeRun.runId} is already active`);
          const run = await runs.read(runId);
          if (run.status !== "running" && run.status !== "paused" && run.status !== "review") throw new Error(`Run is terminal: ${run.status}`);
          await artifacts.verify(run.artifactDigest);
          await runs.attach(run, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
          await setActive(run, ctx);
          await appendFact(ctx, { type: "RUN_RESUMED", reason: "explicitly attached to this Pi session" });
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("success", theme.bold(`Resumed ${run.playbookName}`)),
            `Run ID: ${theme.fg("accent", run.runId)}`,
            `Status: ${run.status} · Stage: ${run.currentStage ?? "not set"}`,
            run.pendingGate
              ? theme.fg("warning", `Waiting for approval: ${run.pendingGate.prompt}\nUse /playbook approve to continue.`)
              : run.status === "review"
                ? theme.fg("accent", "This run is ready for review. Ask follow-up questions, request changes, or use /playbook close when satisfied.")
                : theme.fg("muted", "Continue the workflow in this session. Use /playbook status to check progress."),
          ].join("\n"), "info");
          return;
        }
        if (command === "abort") {
          if (!activeRun) throw new Error("No active playbook run");
          activeRun.status = "abandoned";
          delete activeRun.pendingGate;
          delete activeRun.completionReview;
          await runs.save(activeRun);
          await appendFact(ctx, { type: "RUN_ABANDONED", reason: words.join(" ") || "manually abandoned" });
          await setActive(undefined, ctx);
          ctx.ui.notify("Playbook run abandoned", "warning");
          return;
        }
        if (command === "verify") {
          const digest = words[0] ?? activeRun?.artifactDigest;
          if (!digest) throw new Error("Usage: /playbook verify <digest>");
          await artifacts.verify(digest);
          ctx.ui.notify(`Artifact verified: ${digest}`, "info");
          return;
        }
        if (command === "list") {
          const registry = await personal.read();
          const teamData = await team?.read();
          const proposalData = await proposals.list();
          const projectCandidates = ctx.isProjectTrusted()
            ? await listProjectCandidates(join(ctx.cwd, CONFIG_DIR_NAME, "playbooks", "candidates"))
            : [];
          const theme = ctx.ui.theme;
          const lines: string[] = [theme.fg("accent", theme.bold("Approved playbooks"))];
          const addReleases = async (scope: string, releases: typeof registry.releases) => {
            for (const [name, pointer] of Object.entries(releases)) {
              const contract = await artifacts.contract(pointer.digest);
              lines.push(
                `  ${theme.fg("success", theme.bold(name))} ${theme.fg("muted", `(${scope}, ${pointer.digest.slice(0, 12)}…)`)}`,
                `    ${contract.description}`,
                `    ${theme.fg("accent", `/playbook run ${name}`)} ${theme.fg("muted", "[optional request]")}`,
              );
            }
          };
          await addReleases("personal", registry.releases);
          if (teamData) await addReleases("team", teamData.releases);
          if (Object.keys(registry.releases).length === 0 && (!teamData || Object.keys(teamData.releases).length === 0)) {
            lines.push(
              `  ${theme.fg("muted", "No approved playbooks yet.")}`,
              `  Start a workflow with ${theme.fg("accent", "/playbook")} and follow the save instructions when it finishes.`,
            );
          }

          lines.push("", theme.fg("accent", theme.bold("Project candidate workspaces")));
          if (projectCandidates.length === 0) {
            lines.push(`  ${theme.fg("muted", "No local candidate workspaces in this project.")}`);
          } else {
            for (const candidate of projectCandidates) {
              const displayPath = relative(ctx.cwd, candidate.sourcePath) || candidate.sourcePath;
              if (candidate.contract) {
                lines.push(
                  `  ${theme.fg("warning", theme.bold(candidate.contract.name))} ${theme.fg("muted", `v${candidate.contract.version} · editable, not submitted`)}`,
                  `    ${candidate.contract.description}`,
                  `    ${theme.fg("muted", `Directory: ${candidate.directoryName} · ${displayPath}`)}`,
                  `    ${theme.fg("accent", `/playbook propose ${candidate.directoryName}`)}`,
                );
              } else {
                lines.push(
                  `  ${theme.fg("warning", theme.bold(candidate.directoryName))} ${theme.fg("error", "(invalid candidate)")}`,
                  `    ${theme.fg("muted", displayPath)}`,
                  `    ${theme.fg("error", candidate.error ?? "Unable to read candidate")}`,
                );
              }
            }
          }

          lines.push("", theme.fg("accent", theme.bold("Submitted proposals")));
          if (proposalData.length === 0) {
            lines.push(`  ${theme.fg("muted", "No proposals waiting for review.")}`);
          } else {
            for (const proposal of proposalData) {
              const statusColor = proposal.status === "proposed" ? "warning" : proposal.status === "promoted" ? "success" : "muted";
              lines.push(
                `  ${theme.fg(statusColor, theme.bold(proposal.name))} · ${proposal.status}`,
                `    ${proposal.rationale}`,
                `    Proposal ID: ${proposal.proposalId}`,
              );
              if (proposal.status === "proposed") {
                lines.push(
                  `    ${theme.fg("success", `/playbook promote ${proposal.proposalId}`)}`,
                  `    ${theme.fg("warning", `/playbook reject ${proposal.proposalId} <reason>`)}`,
                );
              }
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (command !== "status") throw new Error(`Unknown playbook command: ${command}`);
        if (activeRun) {
          const theme = ctx.ui.theme;
          const lines = [
            theme.fg("accent", theme.bold(activeRun.playbookName)),
            `Run ID: ${activeRun.runId}`,
            `Status: ${activeRun.status} · Stage: ${activeRun.currentStage ?? "not set"}`,
            `Artifact: ${activeRun.artifactDigest.slice(0, 12)}…`,
          ];
          if (activeRun.pendingGate) {
            lines.push(
              "",
              theme.fg("warning", `Waiting for your approval: ${activeRun.pendingGate.prompt}`),
              `Continue with ${theme.fg("success", "/playbook approve")}`,
            );
          } else if (activeRun.status === "review") {
            lines.push(
              "",
              theme.fg("accent", "The proposed result is ready for review."),
              theme.fg("text", "Ask follow-up questions or request changes; the pinned playbook and its safety policy stay active."),
              `Close only when satisfied: ${theme.fg("success", "/playbook close")}`,
              theme.fg("muted", `If you change sessions: /playbook resume ${activeRun.runId}`),
            );
          } else {
            lines.push("", theme.fg("muted", `If you change sessions, continue with /playbook resume ${activeRun.runId}`));
          }
          ctx.ui.notify(lines.join("\n"), "info");
        } else {
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("muted", "No playbook run is active."),
            `Start interactively: ${theme.fg("accent", "/playbook")}`,
            `View reusable playbooks: ${theme.fg("accent", "/playbook list")}`,
            `Run one by name: ${theme.fg("accent", "/playbook run <playbook-name> [request]")}`,
          ].join("\n"), "info");
        }
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
}
