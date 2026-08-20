import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
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
import { artifactChanges, evaluateCandidate } from "../src/evaluation.js";
import { appendAdditionalInstruction, nextSourceVersion } from "../src/instructions.js";
import { FactLedger } from "../src/ledger.js";
import { ReleaseRegistry, personalRegistryPath } from "../src/registry.js";
import { assertProposalIsProposed, ProposalStore } from "../src/proposals.js";
import { resolveAutomatic, resolveNamed, type ResolvedRelease } from "../src/resolver.js";
import { evaluatePredicates, hashRunArtifact, RunStore } from "../src/runs.js";
import { runbookToSkill, skillToRunbook } from "../src/skill-conversion.js";
import { commandEvidenceFromSession } from "../src/trajectory.js";
import {
  attestTools,
  decide,
  hashArguments,
  POLICY_VERSION,
  verifyToolAttestations,
  type PolicyDecision,
  type ToolMetadata,
} from "../src/policy.js";
import type { LedgerFact, RunbookContract, RunbookRun } from "../src/types.js";

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
  ["run", "run <runbook-name> [request]", "Start an approved runbook or local candidate as written, or provide a request to refine it or create an ad hoc workflow."],
  ["record", "record [runbook-name]", "Convert the current session so far into a reusable runbook."],
  ["from-skill", "from-skill <skill-name|directory> [destination]", "Convert a loaded Pi Agent Skill into an editable runbook candidate."],
  ["to-skill", "to-skill <runbook-name> [destination]", "Export an approved runbook as a standalone Pi Agent Skill."],
  ["status", "status", "Show the active run, current stage, and status."],
  ["list", "list [--details]", "List runbook names and statuses; use --details for paths, IDs, and actions."],
  ["edit", "edit <runbook-name> [destination]", "Create an editable candidate from the currently approved release."],
  ["instruct", "instruct <runbook-name> <instruction>", "Add a persistent instruction and request approval for future runs."],
  ["approve", "approve", "Approve the workflow gate currently waiting for your decision."],
  ["close", "close", "Close a reviewed run and start automatic evidence-based learning."],
  ["abort", "abort [reason]", "Abandon the active run and optionally record why."],
  ["seal", "seal <source-directory>", "Create an immutable runbook artifact from a source directory."],
  ["verify", "verify [digest]", "Verify a sealed artifact, or the active run's artifact."],
  ["draft", "draft [destination]", "Advanced: create an editable improvement workspace from the latest run on this session branch."],
  ["propose", "propose <candidate>", "Advanced: submit a manually prepared candidate without activating it."],
  ["promote", "promote <proposal-id|digest>", "Advanced: activate a reviewed proposal or bootstrap a sealed runbook."],
  ["reject", "reject <proposal-id> [reason]", "Advanced: reject a candidate proposal without changing the active version."],
  ["rollback", "rollback <runbook-name>", "Return future runs to the preceding approved version."],
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

function suggestedRunbookName(request: string): string {
  const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/g, "");
  return slug || "reusable-workflow";
}

function conciseContext(value: string, limit = 300): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function approvalExplanation(
  decision: PolicyDecision,
  actionLabel: string,
  action: string,
  run: RunbookRun,
  contract: RunbookContract,
  directlyEntered = false,
): string {
  const details = decision.approvalDetails;
  const purpose = details?.purpose.map((item) => `- ${item}`).join("\n")
    ?? "- Perform the exact action shown below.";
  const risks = details?.risks.map((item) => `- ${item}`).join("\n")
    ?? `- ${decision.reason}`;
  const stage = run.currentStage ? `, currently at stage “${run.currentStage}”` : "";
  const need = directlyEntered
    ? "You entered this command directly; approval is required before the active runbook allows it to execute."
    : `The agent requested this while running “${run.runbookName}”${stage}. The workflow goal is “${conciseContext(contract.description)}”, for the current request “${conciseContext(run.originalPrompt)}”.`;
  const inferenceWarning = directlyEntered
    ? ""
    : "\nThis context explains why the action was requested, but does not prove it is necessary. Confirm that the action and target match the workflow goal.";

  return `What it tries to accomplish:\n${purpose}\n\nWhy it is needed:\n${need}${inferenceWarning}\n\nRisks if approved:\n${risks}\n\nWhy approval was triggered:\n${decision.reason}\n\nExact ${actionLabel}:\n${action}\n\nApproval is one-time and applies only to this exact action.`;
}

function firstUserText(ctx: ExtensionContext): string | undefined {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content = entry.message.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return undefined;
}

function teamRegistryFor(ctx: ExtensionContext): ReleaseRegistry | undefined {
  if (!ctx.isProjectTrusted()) return undefined;
  return new ReleaseRegistry(join(ctx.cwd, CONFIG_DIR_NAME, "runbooks", "registry.json"), false);
}

function toolMetadata(pi: ExtensionAPI): ToolMetadata[] {
  return pi.getAllTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sourceInfo: { source: tool.sourceInfo.source },
  }));
}

export default function runbooksExtension(pi: ExtensionAPI) {
  const home = process.env.PI_RUNBOOKS_HOME
    ? resolve(process.env.PI_RUNBOOKS_HOME)
    : join(getAgentDir(), "runbooks");
  const artifacts = new ArtifactStore(home);
  const personal = new ReleaseRegistry(personalRegistryPath(home));
  const runs = new RunStore(home);
  const proposals = new ProposalStore(home);
  const ledger = new FactLedger(join(home, "facts.jsonl"));
  let activeRun: RunbookRun | undefined;
  let activeContract: RunbookContract | undefined;
  const blockedCalls = new Set<string>();
  let batchBarrierToolCallId: string | undefined;
  let suppressAutomaticOnce = false;
  let learningActive = false;
  let completionCwd: string | undefined;
  let completionProjectTrusted = false;
  const governedToolNames = new Set(["runbook_checkpoint", "runbook_finish", "runbook_complete_learning"]);
  const assignmentEntryType = "pi-runbooks:assignment";

  const assignmentRunIds = (ctx: ExtensionContext): string[] => ctx.sessionManager.getBranch()
    .flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== assignmentEntryType) return [];
      const runId = (entry.data as { runId?: unknown } | undefined)?.runId;
      return typeof runId === "string" ? [runId] : [];
    });

  const assignedRunForBranch = (ctx: ExtensionContext) => runs.activeForAssignments(
    assignmentRunIds(ctx),
    ctx.sessionManager.getSessionId(),
  );

  const syncGovernedTools = () => {
    const active = pi.getActiveTools().filter((name) => !governedToolNames.has(name));
    if (activeRun) active.push("runbook_checkpoint", "runbook_finish");
    else if (learningActive) active.push("runbook_complete_learning");
    pi.setActiveTools([...new Set(active)]);
  };

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

  const setActive = async (run: RunbookRun | undefined, ctx: ExtensionContext) => {
    activeRun = run;
    activeContract = run ? await artifacts.contract(run.artifactDigest) : undefined;
    const status = !run
      ? undefined
      : run.pendingGate
        ? `runbook: ${run.runbookName} · approval required`
        : run.status === "review"
          ? `runbook: ${run.runbookName} · ready for review · /runbook close`
          : `runbook: ${run.runbookName} · ${run.status}`;
    ctx.ui.setStatus("pi-runbooks", status);

    // Approval gates need the user's immediate attention. Review state does not:
    // the result is already in the conversation, so keep only a compact footer
    // reminder and let /runbook status provide details on demand.
    if (run?.pendingGate) {
      ctx.ui.setWidget("pi-runbooks-approval", [
        `Approval required · ${run.runbookName}`,
        run.pendingGate.prompt,
        "Use /runbook approve to continue, or send a message describing the changes you want.",
      ]);
    } else {
      ctx.ui.setWidget("pi-runbooks-approval", undefined);
    }
    syncGovernedTools();
  };

  const adHocRelease = async (name: string): Promise<ResolvedRelease> => {
    await mkdir(home, { recursive: true });
    const source = await mkdtemp(join(home, ".ad-hoc-source-"));
    try {
      await writeFile(join(source, "RUNBOOK.md"), `# Ad hoc governed workflow\n\nCarry out the user's original request as a complete workflow.\n\n1. Clarify material ambiguity before taking consequential action.\n2. Inspect the current project and use any Pi skills that are relevant; the workflow is not tied to a preselected skill.\n3. Make a concise plan for complex work.\n4. Use runbook_checkpoint at meaningful stage boundaries and before waiting for user approval.\n5. Ask for explicit approval before irreversible, externally visible, credential, billing, infrastructure, deployment, or production effects.\n6. Verify the result rather than assuming an action succeeded.\n7. Call runbook_finish with success, failure, or abandoned when the requested work is ready for user review. The run remains open for questions and changes until the user closes it.\n\nThe original user request, not this generic procedure, defines the workflow goal.\n`, "utf8");
      await writeFile(join(source, "runbook.json"), `${JSON.stringify({
        schemaVersion: 1,
        name,
        version: "0.0.1",
        description: "Governed capture of a user-requested workflow that does not require a pre-existing runbook",
        invocation: "explicit",
        procedure: "RUNBOOK.md",
        requiredCapabilities: ["runbook_checkpoint", "runbook_finish"],
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
    const root = join(ctx.cwd, CONFIG_DIR_NAME, "runbooks", "candidates");
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
  ): Promise<RunbookRun> => {
    if (activeRun) throw new Error(`The ${activeRun.runbookName} runbook is already active`);
    await artifacts.verify(release.digest);
    const attestations = attestTools(release.contract.requiredCapabilities, toolMetadata(pi));
    const sessionFile = ctx.sessionManager.getSessionFile();
    const run = await runs.create({
      runbookName: release.name,
      artifactDigest: release.digest,
      releaseScope: release.scope,
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      ...(sessionFile ? { sessionFile } : {}),
      originalPrompt: prompt,
      toolAttestations: attestations,
    });
    pi.appendEntry(assignmentEntryType, {
      runId: run.runId,
      assignmentId: run.assignmentId,
      runbookName: run.runbookName,
      artifactDigest: run.artifactDigest,
    });
    await setActive(run, ctx);
    await appendFact(ctx, { type: "RUN_ASSIGNED", reason: "fixed artifact assignment persisted on the Pi session branch before runbook execution" });
    return run;
  };

  const notifyRunStarted = (run: RunbookRun, release: ResolvedRelease, ctx: ExtensionContext) => {
    const theme = ctx.ui.theme;
    const approved = release.scope === "personal" || release.scope === "team";
    const candidate = release.scope === "project-candidate";
    ctx.ui.notify([
      theme.fg("success", theme.bold(`Started ${run.runbookName}`)),
      approved
        ? `Using ${theme.fg("success", `${release.scope} approved runbook`)} ${theme.fg("muted", release.digest.slice(0, 12) + "…")}`
        : candidate
          ? `Using an immutable snapshot of local candidate ${theme.fg("muted", release.digest.slice(0, 12) + "…")}`
          : theme.fg("warning", "This is a new ad hoc workflow; it is not yet a reusable approved runbook."),
      approved || candidate
        ? `Run it again later with ${theme.fg("accent", `/runbook run ${run.runbookName}`)} (optionally add a request)`
        : theme.fg("muted", "When the run finishes, Pi will show how to turn it into a reusable runbook."),
    ].join("\n"), "info");
  };

  const approveGate = async (ctx: ExtensionContext): Promise<void> => {
    if (!activeRun?.pendingGate || activeRun.status !== "paused") throw new Error("No runbook approval gate is pending");
    const gate = activeRun.pendingGate;
    activeRun.status = "running";
    delete activeRun.pendingGate;
    await runs.save(activeRun);
    await appendFact(ctx, { type: "GATE_APPROVED", reason: gate.id, data: { gatePromptHash: hashArguments(gate.prompt) } });
    await setActive(activeRun, ctx);
  };

  const requestGateRevision = async (ctx: ExtensionContext, revision?: string): Promise<void> => {
    if (!activeRun?.pendingGate || activeRun.status !== "paused") throw new Error("No runbook approval gate is pending");
    const gate = activeRun.pendingGate;
    activeRun.status = "running";
    delete activeRun.pendingGate;
    await runs.save(activeRun);
    await appendFact(ctx, {
      type: "GATE_REVISION_REQUESTED",
      reason: gate.id,
      data: {
        gatePromptHash: hashArguments(gate.prompt),
        ...(revision ? { revisionHash: hashArguments(revision) } : {}),
      },
    });
    await setActive(activeRun, ctx);
  };

  const closeReviewedRun = async (ctx: ExtensionContext): Promise<RunbookRun> => {
    if (!activeRun || activeRun.status !== "review" || !activeRun.completionReview) {
      throw new Error("No runbook run is ready to close. Complete the work and wait for Pi to submit it for review first.");
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
      toolName: "runbook_close",
      enforcementLevel: "guarded",
      reason: review.summary,
      data: { predicateResults: review.predicateResults, userConfirmed: true },
    });
    const completedRun = activeRun;
    await setActive(undefined, ctx);

    const theme = ctx.ui.theme;
    const successful = completedRun.status === "completed";
    ctx.ui.notify([
      theme.fg(successful ? "success" : "warning", theme.bold(`Runbook run ${completedRun.status}`)),
      completedRun.runbookName,
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
    learningPurpose: "improve" | "record-session" = "improve",
  ): Promise<void> => {
    if (activeRun) throw new Error("Finish or detach the active run before starting a learning draft");
    const run = await runs.read(runId);
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "abandoned") {
      throw new Error(`Run ${runId} is not closed yet. Review it and use /runbook close first.`);
    }
    const defaultDirectoryName = `${run.runbookName}-${run.runId.slice(0, 8)}`;
    const destination = resolve(ctx.cwd, destinationArgument ?? join(CONFIG_DIR_NAME, "runbooks", "candidates", defaultDirectoryName));
    const proposeCommand = destinationArgument
      ? `/runbook propose ${JSON.stringify(relative(ctx.cwd, destination) || destination)} ${run.artifactDigest} ${run.runId}`
      : `/runbook propose ${defaultDirectoryName}`;
    await artifacts.materializeForRevision(run.artifactDigest, destination);
    await writeCandidateMetadata(destination, { baseDigest: run.artifactDigest, runId, workflow });
    const runFacts = (await ledger.readAll()).filter((fact) => fact.runId === runId).slice(-100);
    const commandEvidence = await commandEvidenceFromSession(
      run.sessionFile,
      run.startedAt,
      run.completion?.completedAt ?? run.updatedAt,
    );
    const adHocGuidance = learningPurpose === "record-session"
      ? "\nThe user explicitly asked to convert the existing session so far into a reusable runbook. Infer the repeatable goal, ordered stages, important decisions, approval points, and verification steps from the conversation so far. The whole prior session context is potential evidence, but do not blindly copy it: omit secrets, credentials, raw outputs, incidental debugging, personal data, absolute paths, and one-off project details. Generalize necessary inputs with clear placeholders or applicability guards. Preserve only commands and automation supported by observed successful execution. Replace the generic procedure and description, keep the user-selected runbook name, and increment the source version."
      : run.releaseScope === "explicit-digest"
        ? "\nThis began as an ad hoc workflow. If the trajectory contains a genuinely reusable procedure, replace the generic instructions with that procedure and refine the contract description while keeping the user-selected runbook name unless they request a rename. Do not invent reusable instructions when the evidence supports only a one-off task. Add skillDependencies only when they materially improve the workflow."
        : "";
    const completionInstruction = workflow === "automatic"
      ? `When the analysis is complete, you MUST call runbook_complete_learning exactly once with runId ${runId}. Use decision no_change when the evidence does not support a safe, material procedural improvement. Use decision propose only after editing the candidate. Do not ask the user to manage files, digests, proposals, or commands; the tool performs deterministic evaluation and presents the only required approval.`
      : `When finished, ask the user to review and run:\n${proposeCommand}`;
    suppressAutomaticOnce = true;
    learningActive = workflow === "automatic";
    syncGovernedTools();
    const taskIntroduction = learningPurpose === "record-session"
      ? `Convert the current Pi session so far into a concise, reusable runbook. Use the prior conversation as evidence and create the smallest workflow that can reliably reproduce its successful process.`
      : `Review the completed runbook run ${runId} and identify the smallest evidence-supported procedural improvement.`;
    const learningTask = `${taskIntroduction}\n\nBase digest: ${run.artifactDigest}\nEditable candidate directory: ${destination}\nOriginal request: ${run.originalPrompt}\nTerminal status: ${run.status}\nCompletion: ${JSON.stringify(run.completion ?? null)}\nEvidence facts (execution-correlated, not causal claims):\n${JSON.stringify(runFacts, null, 2)}\nDeterministic command evidence (minimized from the Pi-owned session trace; command outputs and non-command arguments are omitted):\n${JSON.stringify(commandEvidence, null, 2)}\n\nEdit only the candidate directory, preserve the runbook structure and any declared skill dependencies, increment the source version when materially changed, and do not activate it.${adHocGuidance}\n\nExplicitly evaluate the command evidence for a token- or time-saving deterministic fast path. Add automation only when the observed trajectory supports it:\n1. Prefer a consolidated command when it can replace several observed smaller commands while preserving their checks and failure semantics.\n2. Add a helper under scripts/ only when repeated, stable command sequences justify maintaining one.\nRecord the supporting commands and outcomes in the candidate procedure, plus applicability guards. A successful observed command is evidence that it ran in this trajectory, not proof that it is universally correct. Never invent a command from argument hashes, promote an unexecuted optimization, copy likely credentials, or add a speculative helper. If evidence is insufficient, leave automation out.\n\n${completionInstruction}`;
    pi.sendMessage({
      customType: "runbook-learning-task",
      content: learningTask,
      display: false,
    }, { triggerTurn: true });
    const theme = ctx.ui.theme;
    ctx.ui.notify([
      theme.fg("success", theme.bold(learningPurpose === "record-session" ? "Recording this session as a runbook" : workflow === "automatic" ? "Automatic runbook learning started" : "Runbook improvement workspace created")),
      workflow === "automatic" ? theme.fg("muted", learningPurpose === "record-session" ? "Pi is extracting a reusable workflow; no file or proposal commands are needed." : "Pi is analyzing the run; no draft or proposal commands are needed.") : destination,
      "",
      workflow === "automatic"
        ? theme.fg("text", "You will be asked only if Pi finds an improvement that passes deterministic checks.")
        : theme.fg("text", "When the review is ready, Pi will give you a /runbook propose command."),
      workflow === "automatic"
        ? theme.fg("muted", "The approved runbook remains unchanged until you approve the candidate.")
        : theme.fg("muted", "After proposing, you will be able to promote or reject the candidate."),
    ].join("\n"), "info");
  };

  const createEditWorkspace = async (
    name: string,
    destinationArgument: string | undefined,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const release = await resolveNamed(name, artifacts, personal, teamRegistryFor(ctx));
    if (!release) throw new Error(`No approved runbook named ${name}`);

    const defaultDirectoryName = `${name}-edit`;
    const destination = resolve(
      ctx.cwd,
      destinationArgument ?? join(CONFIG_DIR_NAME, "runbooks", "candidates", defaultDirectoryName),
    );
    await artifacts.materializeForRevision(release.digest, destination);
    const manifest = await artifacts.manifest(release.digest);
    const updatedContract = {
      ...manifest.contract,
      version: nextSourceVersion(manifest.contract.version),
    };
    await writeFile(join(destination, "runbook.json"), `${JSON.stringify(updatedContract, null, 2)}\n`, "utf8");

    const candidateRoot = resolve(ctx.cwd, CONFIG_DIR_NAME, "runbooks", "candidates");
    const relativeCandidate = relative(candidateRoot, destination);
    const isDiscoverable = relativeCandidate !== "" && !relativeCandidate.startsWith("..") && !relativeCandidate.includes("/") && !relativeCandidate.includes("\\");
    const proposeCommand = isDiscoverable
      ? `/runbook propose ${JSON.stringify(relativeCandidate)}`
      : `/runbook propose ${JSON.stringify(relative(ctx.cwd, destination) || destination)} ${release.digest} none edited-approved-runbook`;
    const theme = ctx.ui.theme;
    ctx.ui.notify([
      theme.fg("success", theme.bold(`Editable candidate created for ${name}`)),
      destination,
      `Procedure: ${join(destination, manifest.procedurePath)}`,
      theme.fg("muted", `Source version prepared as ${updatedContract.version}; the approved release is unchanged.`),
      "",
      theme.fg("text", "Edit the candidate, then submit it for approval with:"),
      `  ${theme.fg("success", proposeCommand)}`,
    ].join("\n"), "info");
  };

  const addPersistentInstruction = async (
    name: string,
    instruction: string,
    ctx: ExtensionContext,
  ): Promise<void> => {
    const release = await resolveNamed(name, artifacts, personal, teamRegistryFor(ctx));
    if (!release) throw new Error(`No approved runbook named ${name}`);
    const normalizedInstruction = instruction.replace(/\s+/g, " ").trim();
    if (!normalizedInstruction) throw new Error("Usage: /runbook instruct <runbook-name> <instruction>");

    await mkdir(home, { recursive: true });
    const temporaryRoot = await mkdtemp(join(home, ".instruction-source-"));
    const source = join(temporaryRoot, "candidate");
    try {
      await artifacts.materializeForRevision(release.digest, source);
      const base = await artifacts.manifest(release.digest);
      const procedurePath = join(source, base.procedurePath);
      const procedure = await readFile(procedurePath, "utf8");
      await writeFile(procedurePath, appendAdditionalInstruction(procedure, normalizedInstruction), "utf8");
      const updatedContract = {
        ...base.contract,
        version: nextSourceVersion(base.contract.version),
      };
      await writeFile(join(source, "runbook.json"), `${JSON.stringify(updatedContract, null, 2)}\n`, "utf8");

      const candidate = await artifacts.seal(source);
      const changes = artifactChanges(base, candidate);
      const proposal = await proposals.create({
        name,
        candidateDigest: candidate.digest,
        baseDigest: release.digest,
        evidenceRunIds: [],
        rationale: `Add persistent instruction: ${normalizedInstruction}`,
      });
      await ledger.append({
        type: "CANDIDATE_PROPOSED",
        artifactDigest: candidate.digest,
        reason: proposal.rationale,
        data: { proposalId: proposal.proposalId, baseDigest: release.digest, evidenceRunIds: [], source: "runbook-instruct" },
      });

      const theme = ctx.ui.theme;
      if (!ctx.hasUI) {
        ctx.ui.notify([
          theme.fg("success", theme.bold(`Instruction candidate ready for ${name}`)),
          `Proposal ID: ${proposal.proposalId}`,
          `Changed files: ${[...changes.added, ...changes.modified, ...changes.removed].join(", ")}`,
          `Approve with: /runbook promote ${proposal.proposalId}`,
        ].join("\n"), "info");
        return;
      }

      const approved = await ctx.ui.confirm(
        `Add this instruction to ${name}?`,
        `${normalizedInstruction}\n\nVersion ${base.contract.version} → ${updatedContract.version}\nChanged files: ${[...changes.added, ...changes.modified, ...changes.removed].join(", ")}\n\nApproval applies to future runs. Active runs remain pinned.`,
      );
      if (!approved) {
        proposal.status = "rejected";
        await proposals.save(proposal);
        await ledger.append({
          type: "CANDIDATE_REJECTED",
          artifactDigest: candidate.digest,
          reason: "persistent instruction was not approved",
          data: { proposalId: proposal.proposalId, fingerprint: proposal.fingerprint },
        });
        ctx.ui.notify(`Instruction was not added to ${name}`, "warning");
        return;
      }

      const current = await resolveNamed(name, artifacts, personal, teamRegistryFor(ctx));
      if (!current || current.digest !== release.digest) {
        proposal.status = "stale";
        await proposals.save(proposal);
        throw new Error(`The approved ${name} release changed while approval was pending; run the instruct command again`);
      }
      await personal.promote(name, candidate.digest);
      proposal.status = "promoted";
      await proposals.save(proposal);
      await ledger.append({
        type: "PROMOTED",
        artifactDigest: candidate.digest,
        reason: `approved persistent instruction for ${name}`,
        data: { proposalId: proposal.proposalId },
      });
      ctx.ui.notify([
        theme.fg("success", theme.bold(`Instruction added to ${name}`)),
        theme.fg("muted", `Version ${updatedContract.version} will be used by future runs; active runs remain pinned.`),
      ].join("\n"), "info");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Autocomplete metadata stays extension-local. It is read directly from the
    // registries and never added to the session or model context.
    completionCwd = ctx.cwd;
    completionProjectTrusted = ctx.isProjectTrusted();

    // The branch-local assignment entry is the durable binding. The mutable run
    // record supplies current status, gates, and the pinned artifact after a
    // process restart; unrelated branches and forked sessions do not inherit it.
    await setActive(await assignedRunForBranch(ctx), ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const previous = activeRun;
    const assigned = await assignedRunForBranch(ctx);
    if (assigned?.runId === previous?.runId) return;
    if (previous) {
      await appendFact(ctx, { type: "RUN_DETACHED_FROM_BRANCH", reason: "active branch no longer contains its durable assignment" });
    }
    await setActive(assigned, ctx);
    if (assigned) {
      ctx.ui.notify(`Restored ${assigned.runbookName} from this session branch`, "info");
    } else if (previous) {
      ctx.ui.notify("Runbook run detached because the session tree moved before its assignment", "warning");
    }
  });

  pi.on("input", async (event, ctx) => {
    if (activeRun?.status === "paused" && activeRun.pendingGate) {
      if (event.text.trim().toLowerCase() === "approved") {
        await approveGate(ctx);
      } else {
        await requestGateRevision(ctx, event.text.trim());
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
        ctx.ui.notify(`Runbook conflict: ${automatic.conflicts.map((item) => item.name).join(", ")}`, "error");
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
      ? `\nThis run is IN REVIEW. Proposed outcome: ${activeRun.completionReview.outcome}. The user may ask questions or request changes, and all resulting work remains inside this governed run. Do not restart the procedure unnecessarily. If material changes alter the result, call runbook_finish again with an updated outcome and summary. Only the user closes the run with /runbook close.`
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\n# Active governed runbook\nPinned artifact: ${activeRun.artifactDigest}\nImmutable runbook root: ${root}\nResolve all runbook-relative references, optional skills, and scripts beneath that root. Write declared run artifacts relative to the run cwd: ${activeRun.cwd}. The assignment remains fixed for the entire run. Use runbook_checkpoint at durable stage boundaries and use runbook_finish when work is ready for user review; the user explicitly closes the run after follow-ups.${skillDependencyText}${gateText}${reviewText}\n\n<runbook-procedure>\n${procedure}\n</runbook-procedure>`,
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
      await appendFact(ctx, { type: "BLOCKED", toolCallId: event.toolCallId, toolName: event.toolName, argsHash, policyVersion: POLICY_VERSION, reason: activeRun.status === "paused" ? "runbook is paused at a workflow gate" : "a gate or terminal action earlier in this parallel batch established a safety barrier" });
      return { block: true, reason: "Runbook workflow barrier is active" };
    }
    if ((event.toolName === "runbook_checkpoint" && input.gate) || event.toolName === "runbook_finish") {
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
      return { block: true, reason: "Runbook assignment attestation failed" };
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
      const action = event.toolName === "bash"
        ? String(input.command ?? "")
        : (event.toolName === "write" || event.toolName === "edit")
          ? String(input.path ?? "")
          : JSON.stringify(input, null, 2);
      const approved = await ctx.ui.confirm(
        `Review and allow this ${event.toolName} action once?`,
        approvalExplanation(decision, event.toolName === "bash" ? "command" : "action", action, activeRun, activeContract),
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
      return { result: { output: `Blocked by active runbook: ${decision.reason}`, exitCode: 126, cancelled: false, truncated: false } };
    }
    if (decision.decision === "require_approval") {
      const approved = await ctx.ui.confirm(
        "Review and allow this shell command once?",
        approvalExplanation(decision, "command", event.command, activeRun, activeContract, true),
      );
      if (!approved) {
        await appendFact(ctx, { type: "USER_REJECTED", toolName: "user_bash", argsHash, enforcementLevel: "observed", policyVersion: POLICY_VERSION, reason: decision.reason });
        return { result: { output: "Rejected by user", exitCode: 126, cancelled: false, truncated: false } };
      }
    }
    await appendFact(ctx, { type: "AUTHORIZED", toolName: "user_bash", argsHash, enforcementLevel: "observed", policyVersion: POLICY_VERSION, reason: decision.reason });
  });

  pi.registerTool({
    name: "runbook_complete_learning",
    label: "Complete runbook learning",
    description: "Complete automatic learning for a closed runbook run. Either record that no material change is supported, or seal, evaluate, and present an evidence-linked candidate for one-step user approval.",
    promptSnippet: "Finalize automatic runbook learning without exposing draft, proposal, or digest mechanics",
    promptGuidelines: ["Use runbook_complete_learning exactly once when an automatic runbook-learning review instructs you to complete it."],
    parameters: CompleteLearningParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      // The completion call is terminal for the learning turn. Remove all
      // runbook-only tools before the next model request, even if evaluation fails.
      learningActive = false;
      syncGovernedTools();
      const run = await runs.read(params.runId);
      if (run.status !== "completed" && run.status !== "failed" && run.status !== "abandoned") {
        throw new Error("Automatic learning requires a closed evidence run");
      }
      const candidateRoot = join(run.cwd, CONFIG_DIR_NAME, "runbooks", "candidates");
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
          toolName: "runbook_complete_learning",
          enforcementLevel: "guarded",
          reason: params.summary,
        });
        await rm(candidate.sourcePath, { recursive: true, force: true });
        return {
          content: [{ type: "text", text: "Automatic learning completed: the evidence did not support a safe, material runbook change. The temporary workspace was removed." }],
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
          : "Candidate became stale before evaluation; the approved runbook was not changed");
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
          content: [{ type: "text", text: `Candidate ${proposal.proposalId} passed deterministic evaluation and awaits human approval. In an interactive session, review it with /runbook list and promote or reject it.` }],
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
          content: [{ type: "text", text: "The user declined the learned update. The approved runbook remains unchanged." }],
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
    name: "runbook_checkpoint",
    label: "Runbook checkpoint",
    description: "Persist a governed runbook stage checkpoint, hash stage artifacts, and optionally pause at a workflow approval gate.",
    promptSnippet: "Record durable runbook stage boundaries and approval gates",
    promptGuidelines: ["Use runbook_checkpoint at every stage boundary required by the active governed runbook."],
    parameters: CheckpointParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeRun) throw new Error("No active runbook run");
      await appendFact(ctx, { type: "STARTED", toolCallId, toolName: "runbook_checkpoint", argsHash: hashArguments(params), enforcementLevel: "guarded", reason: "guarded checkpoint execution began with schema-validated final arguments" });
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
        toolName: "runbook_checkpoint",
        enforcementLevel: "guarded",
        reason: params.summary,
        data: { stage: params.stage, artifacts: artifactHashes, ...(params.gate ? { gateId: params.gate.id } : {}) },
      });
      await setActive(activeRun, ctx);

      let gateResolution: "approved" | "revision_requested" | "paused" | undefined;
      let revision: string | undefined;
      if (params.gate && ctx.hasUI) {
        const choice = await ctx.ui.select(
          "Workflow approval required",
          ["Approve and continue", "Request changes", "Keep paused"],
        );
        if (choice === "Approve and continue") {
          await approveGate(ctx);
          gateResolution = "approved";
        } else if (choice === "Request changes") {
          const requested = await ctx.ui.input("What should Pi change?", "Describe the revision");
          if (requested?.trim()) {
            revision = requested.trim();
            await requestGateRevision(ctx, revision);
            gateResolution = "revision_requested";
          } else {
            gateResolution = "paused";
          }
        } else {
          gateResolution = "paused";
        }
      } else if (params.gate) {
        gateResolution = "paused";
      }

      const text = gateResolution === "approved"
        ? `Checkpoint ${params.stage} saved. The user approved ${params.gate!.id}; continue with the next stage.`
        : gateResolution === "revision_requested"
          ? `Checkpoint ${params.stage} saved. The user requested changes before approval: ${revision}`
          : params.gate
            ? `Checkpoint ${params.stage} saved. Approval ${params.gate.id} is pending; do not continue to later stages.`
            : `Checkpoint ${params.stage} saved.`;
      return {
        content: [{ type: "text", text }],
        details: {
          runId: activeRun.runId,
          stage: params.stage,
          artifacts: artifactHashes,
          paused: activeRun.status === "paused",
          ...(gateResolution ? { gateResolution } : {}),
        },
      };
    },
  });

  pi.registerTool({
    name: "runbook_finish",
    label: "Submit runbook for review",
    description: "Mark the active governed run ready for user review after evaluating its deterministic completion predicates. The run remains active for follow-up questions and changes until the user closes it.",
    promptSnippet: "Submit a runbook outcome for user review without closing the run",
    promptGuidelines: ["Use runbook_finish when the requested work is ready for user review, and use it again if material follow-up changes alter the proposed outcome."],
    parameters: FinishParameters,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!activeRun || !activeContract) throw new Error("No active runbook run");
      if (activeRun.pendingGate) throw new Error("Cannot finish while an approval gate is pending");
      await appendFact(ctx, { type: "STARTED", toolCallId, toolName: "runbook_finish", argsHash: hashArguments(params), enforcementLevel: "guarded", reason: "guarded completion evaluation began with schema-validated final arguments" });
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
        toolName: "runbook_finish",
        enforcementLevel: "guarded",
        reason: params.summary,
        data: { outcome: params.outcome, predicateResults },
      });
      await setActive(activeRun, ctx);
      return {
        content: [{
          type: "text",
          text: `The proposed ${params.outcome} outcome is ready for user review. The run remains active. Answer follow-up questions and make requested changes within this runbook; the user will close it with /runbook close.`,
        }],
        details: { runId: activeRun.runId, status: activeRun.status, proposedOutcome: params.outcome, predicateResults },
      };
    },
  });

  pi.registerCommand("runbook", {
    description: "Governed runbooks: create, run, improve, approve, and reuse reliable workflows",
    getArgumentCompletions: async (prefix) => {
      if (!/\s/.test(prefix)) {
        const items = COMMAND_HELP
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, usage, description]) => ({ value: name, label: usage, description }));
        return items.length ? items : null;
      }

      const match = /^(run|edit|instruct|to-skill|rollback)\s+([^\s]*)$/.exec(prefix);
      if (!match) return null;
      const command = match[1]!;
      const namePrefix = match[2]!;

      try {
        const personalNames = Object.keys((await personal.read()).releases);
        const teamNames = completionProjectTrusted && completionCwd
          ? Object.keys((await new ReleaseRegistry(
              join(completionCwd, CONFIG_DIR_NAME, "runbooks", "registry.json"),
              false,
            ).read()).releases)
          : [];

        const sources = new Map<string, Set<string>>();
        const add = (name: string, source: string) => {
          const existing = sources.get(name) ?? new Set<string>();
          existing.add(source);
          sources.set(name, existing);
        };
        for (const name of personalNames) add(name, "personal approved");
        if (command !== "rollback") {
          for (const name of teamNames) add(name, "team approved");
        }

        if (command === "run" && completionProjectTrusted && completionCwd) {
          const candidates = await listProjectCandidates(
            join(completionCwd, CONFIG_DIR_NAME, "runbooks", "candidates"),
          );
          const valid = candidates.filter((candidate) => candidate.contract);
          const counts = new Map<string, number>();
          for (const candidate of valid) {
            const name = candidate.contract!.name;
            counts.set(name, (counts.get(name) ?? 0) + 1);
          }
          for (const candidate of valid) {
            const name = candidate.contract!.name;
            if (counts.get(name) === 1) add(name, "local candidate");
            else add(candidate.directoryName, `local candidate for ${name}`);
          }
        }

        const items = [...sources.entries()]
          .filter(([name]) => name.startsWith(namePrefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, nameSources]) => ({
            // Pi replaces the complete argument prefix, not only its final word.
            value: `${command} ${name}`,
            label: name,
            description: [...nameSources].join(" · "),
          }));
        return items.length ? items : null;
      } catch {
        // Completion is optional UI assistance; registry errors remain the
        // command handler's responsibility and should not disrupt typing.
        return null;
      }
    },
    handler: async (args, ctx) => {
      try {
        const words = parseWords(args);
        const knownCommands = new Set(COMMAND_HELP.map(([name]) => name));
        const team = teamRegistryFor(ctx);
        const nameAndStart = async (prompt: string) => {
          if (!ctx.hasUI) throw new Error("This mode cannot ask for a name. Use /runbook run <name> <request>");
          let name: string | undefined;
          while (!name) {
            const entered = await ctx.ui.input("Name this runbook", suggestedRunbookName(prompt));
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
              theme.fg("accent", theme.bold(activeRun.runbookName)),
              `Status: ${activeRun.status} · Stage: ${activeRun.currentStage ?? "not set"}`,
            ];
            if (activeRun.pendingGate) {
              lines.push(
                "",
                theme.fg("warning", `Waiting for your approval: ${activeRun.pendingGate.prompt}`),
                `Continue with ${theme.fg("success", "/runbook approve")}`,
              );
            } else if (activeRun.status === "review") {
              lines.push(
                "",
                theme.fg("accent", "Ready for your review. Ask questions or request changes normally."),
                `When satisfied: ${theme.fg("success", "/runbook close")}`,
              );
            } else {
              lines.push("", theme.fg("muted", "Use /runbook status for details or /runbook abort <reason> to stop."));
            }
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          if (!ctx.hasUI) {
            ctx.ui.notify("Use /runbook run <name> [request]", "info");
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
            theme.fg("error", theme.bold(`Unknown runbook command: ${JSON.stringify(command)}`)),
            "",
            theme.fg("text", "Workflow requests are not accepted directly after /runbook."),
            theme.fg("muted", "Start interactively with /runbook, or use the explicit run command:"),
            `  ${theme.fg("success", "/runbook run <runbook-name> [request]")}`,
            "",
            theme.fg("accent", theme.bold("Runbook commands")),
            ...COMMAND_HELP.flatMap(([, usage, description]) => [
              `  ${theme.fg("accent", `/runbook ${usage}`)}`,
              `    ${theme.fg("muted", description)}`,
            ]),
          ];
          ctx.ui.notify(help.join("\n"), "error");
          return;
        }
        if (command === "record") {
          let name = words.shift();
          if (words.length > 0) throw new Error("Usage: /runbook record [runbook-name]");
          if (activeRun) throw new Error(`The ${activeRun.runbookName} runbook is already active. Finish or abort it before recording the surrounding session.`);
          await ctx.waitForIdle();
          const originalPrompt = firstUserText(ctx);
          const branch = ctx.sessionManager.getBranch();
          const hasAssistantWork = branch.some((entry) => entry.type === "message" && entry.message.role === "assistant");
          if (!originalPrompt || !hasAssistantWork) {
            throw new Error("There is not enough session history to record yet. Complete a workflow in this session first.");
          }
          if (!ctx.hasUI) {
            throw new Error("Recording an existing session requires an interactive confirmation because the whole active branch may be used.");
          }
          const confirmed = await ctx.ui.confirm(
            "Record this session as a runbook?",
            "Pi may infer the runbook from the entire current session so far—not only the latest task. That can include earlier instructions, tool usage across session branches, project-specific details, or sensitive information. Pi will try to generalize and redact the workflow, and nothing is approved for future runs until you approve the generated candidate. Continue?",
          );
          if (!confirmed) return;

          while (!name) {
            const entered = await ctx.ui.input("Name this reusable runbook", suggestedRunbookName(originalPrompt));
            if (!entered?.trim()) return;
            name = entered.trim();
          }
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
            throw new Error("Runbook names use lowercase letters, numbers, and single hyphens (for example: release-check)");
          }
          if (await resolveNamed(name, artifacts, personal, team)) {
            throw new Error(`An approved runbook named ${name} already exists. Choose a new name, or run it and let automatic learning improve it.`);
          }

          const release = await adHocRelease(name);
          const sessionFile = ctx.sessionManager.getSessionFile();
          const run = await runs.create({
            runbookName: name,
            artifactDigest: release.digest,
            releaseScope: "explicit-digest",
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            ...(sessionFile ? { sessionFile } : {}),
            originalPrompt,
            toolAttestations: attestTools(release.contract.requiredCapabilities, toolMetadata(pi)),
          });
          const headerTimestamp = ctx.sessionManager.getHeader()?.timestamp;
          const firstBranchTimestamp = branch[0]?.timestamp;
          const captureStartedAt = headerTimestamp ?? firstBranchTimestamp;
          if (captureStartedAt && Number.isFinite(Date.parse(captureStartedAt))) run.startedAt = captureStartedAt;
          const capturedAt = new Date().toISOString();
          run.status = "completed";
          run.completion = {
            summary: "Existing Pi session captured for reusable workflow extraction",
            completedAt: capturedAt,
            predicateResults: [],
          };
          await runs.save(run);
          const capturedLeaf = ctx.sessionManager.getLeafId();
          await ledger.append({
            type: "SESSION_CAPTURED",
            runId: run.runId,
            assignmentId: run.assignmentId,
            sessionId: run.sessionId,
            artifactDigest: run.artifactDigest,
            ...(capturedLeaf ? { branchEntryId: capturedLeaf } : {}),
            reason: "user confirmed conversion of the current session into a reusable runbook",
          });
          await startDraft(run.runId, undefined, ctx, "automatic", "record-session");
          return;
        }
        if (command === "from-skill") {
          const sourceArgument = words.shift();
          const destinationArgument = words.shift();
          if (!sourceArgument || words.length > 0) throw new Error("Usage: /runbook from-skill <skill-name|directory> [destination]");
          const pathCandidate = resolve(ctx.cwd, sourceArgument);
          let source: string;
          let defaultName: string;
          try {
            await lstat(pathCandidate);
            source = pathCandidate;
            defaultName = basename(source, ".md");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const skillName = sourceArgument.replace(/^\/?skill:/, "");
            const matches = pi.getCommands().filter((item) =>
              item.source === "skill" && item.name === `skill:${skillName}`,
            );
            if (matches.length === 0) {
              throw new Error(`No loaded Pi skill named ${skillName}. Use its loaded skill name or provide a directory path.`);
            }
            if (matches.length > 1) throw new Error(`Multiple loaded Pi skills are named ${skillName}; provide a directory path.`);
            source = matches[0]!.sourceInfo.path;
            defaultName = skillName;
          }
          const destination = resolve(ctx.cwd, destinationArgument ?? join(CONFIG_DIR_NAME, "runbooks", "candidates", `${defaultName}-from-skill`));
          const contract = await skillToRunbook(source, destination);
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("success", theme.bold(`Converted Pi skill to runbook candidate: ${contract.name}`)),
            destination,
            theme.fg("warning", "Review runbook.json, especially requiredCapabilities and allowedEffectClasses, before sealing."),
            "",
            theme.fg("text", "Submit it for approval with:"),
            `  ${theme.fg("success", `/runbook propose ${JSON.stringify(relative(ctx.cwd, destination) || destination)} new none imported-from-pi-skill`)}`,
          ].join("\n"), "info");
          return;
        }
        if (command === "to-skill") {
          const name = words.shift();
          const destinationArgument = words.shift();
          if (!name || words.length > 0) throw new Error("Usage: /runbook to-skill <runbook-name> [destination]");
          const release = await resolveNamed(name, artifacts, personal, team);
          if (!release) throw new Error(`No approved runbook named ${name}`);
          const destination = resolve(ctx.cwd, destinationArgument ?? join(CONFIG_DIR_NAME, "skills", name));
          await runbookToSkill(artifacts, release.digest, destination);
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("success", theme.bold(`Exported ${name} as a Pi skill`)),
            destination,
            theme.fg("muted", "The skill contains SKILL.md and bundled support files; runbook governance metadata is not included."),
            theme.fg("muted", "Restart or reload Pi resources to discover the new skill."),
          ].join("\n"), "info");
          return;
        }
        if (command === "seal") {
          const source = words[0];
          if (!source) throw new Error("Usage: /runbook seal <source-directory>");
          const manifest = await artifacts.seal(resolve(ctx.cwd, source));
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("success", theme.bold(`Sealed ${manifest.contract.name}@${manifest.contract.version}`)),
            `Artifact: ${manifest.digest}`,
            "",
            theme.fg("text", "For a new runbook, approve it with:"),
            `  ${theme.fg("success", `/runbook promote ${manifest.digest}`)}`,
            theme.fg("muted", "Updates to an approved runbook must go through the proposal review flow."),
          ].join("\n"), "info");
          return;
        }
        if (command === "edit") {
          const name = words.shift();
          if (!name || words.length > 1) throw new Error("Usage: /runbook edit <runbook-name> [destination]");
          await createEditWorkspace(name, words[0], ctx);
          return;
        }
        if (command === "instruct") {
          const name = words.shift();
          if (!name || words.length === 0) throw new Error("Usage: /runbook instruct <runbook-name> <instruction>");
          await addPersistentInstruction(name, words.join(" "), ctx);
          return;
        }
        if (command === "draft") {
          if (words.length > 1) throw new Error("Usage: /runbook draft [destination]");
          const runId = assignmentRunIds(ctx).at(-1);
          if (!runId) throw new Error("No runbook run is assigned to this session branch");
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
            if (!selector) throw new Error("Usage: /runbook propose <candidate>");
            if (!ctx.isProjectTrusted()) throw new Error("Project candidate discovery requires a trusted project");
            const candidate = selectProjectCandidate(
              await listProjectCandidates(join(ctx.cwd, CONFIG_DIR_NAME, "runbooks", "candidates")),
              selector,
            );
            if (!candidate) throw new Error(`No local candidate found for ${selector}. Use /runbook list to see candidate directory names.`);
            source = candidate.sourcePath;
            let evidenceRun = candidate.metadata ? await runs.read(candidate.metadata.runId) : undefined;
            if (!evidenceRun) {
              const conventionMatches = (await runs.list()).filter((run) =>
                candidate.directoryName === `${run.runbookName}-${run.runId.slice(0, 8)}`,
              );
              if (conventionMatches.length === 1) evidenceRun = conventionMatches[0];
            }
            const currentRelease = await personal.resolve(candidate.contract!.name) ?? await team?.resolve(candidate.contract!.name);
            baseToken = candidate.metadata?.baseDigest ?? evidenceRun?.artifactDigest ?? currentRelease?.digest ?? "new";
            runToken = candidate.metadata?.runId ?? evidenceRun?.runId ?? "none";
          }
          if (!source || !baseToken || !runToken) throw new Error("Usage: /runbook propose <candidate>");
          const manifest = await artifacts.seal(resolve(ctx.cwd, source));
          const baseDigest = baseToken === "new" ? undefined : baseToken;
          if (baseDigest === manifest.digest) throw new Error("Candidate is byte-identical to its base artifact");
          const evidenceRunIds = runToken === "none" ? [] : [runToken];
          let evidenceRun: RunbookRun | undefined;
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
                theme.fg("success", theme.bold(`Reusable runbook candidate ready: ${proposal.name}`)),
                `Proposal ID: ${theme.fg("accent", proposal.proposalId)}`,
                theme.fg("muted", proposal.rationale),
                "",
                theme.fg("text", "Review the candidate, then choose:"),
                `  ${theme.fg("success", `/runbook promote ${proposal.proposalId}`)}`,
                `    ${theme.fg("muted", "Approve it for future runs.")}`,
                `  ${theme.fg("warning", `/runbook reject ${proposal.proposalId} <reason>`)}`,
                `    ${theme.fg("muted", "Discard it without changing the approved runbook.")}`,
              ].join("\n")
            : [
                theme.fg("warning", theme.bold(`Candidate is stale: ${proposal.name}`)),
                `Proposal ID: ${proposal.proposalId}`,
                theme.fg("muted", "The approved runbook changed after this candidate's base version. Regenerate or rebase it before promotion."),
              ].join("\n"), lineageCurrent ? "info" : "warning");
          return;
        }
        if (command === "reject") {
          const proposalId = words.shift();
          if (!proposalId) throw new Error("Usage: /runbook reject <proposalId> [reason]");
          const proposal = await proposals.read(proposalId);
          assertProposalIsProposed(proposal, "reject");
          proposal.status = "rejected";
          await proposals.save(proposal);
          await ledger.append({ type: "CANDIDATE_REJECTED", artifactDigest: proposal.candidateDigest, reason: words.join(" ") || "manual rejection", data: { proposalId, fingerprint: proposal.fingerprint } });
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("warning", theme.bold(`Rejected proposal for ${proposal.name}`)),
            theme.fg("muted", "The currently approved runbook was not changed."),
            `View remaining runbooks and proposals with ${theme.fg("accent", "/runbook list")}`,
          ].join("\n"), "warning");
          return;
        }
        if (command === "promote") {
          const token = words[0];
          if (!token) throw new Error("Usage: /runbook promote <proposalId|digest>");
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
            theme.fg("success", theme.bold(`Runbook approved: ${contract.name}`)),
            theme.fg("muted", `Version ${digest.slice(0, 12)}… is now used for future runs.`),
            "",
            theme.fg("text", "Run it again with:"),
            `  ${theme.fg("success", `/runbook run ${contract.name}`)}`,
            theme.fg("muted", "Use /runbook list whenever you need to find approved runbook names."),
          ].join("\n"), "info");
          return;
        }
        if (command === "rollback") {
          const name = words[0];
          if (!name) throw new Error("Usage: /runbook rollback <name>");
          const pointer = await personal.rollback(name);
          await ledger.append({ type: "ROLLED_BACK", artifactDigest: pointer.digest, reason: `manual rollback of ${name}` });
          ctx.ui.notify(`Rolled ${name} back to ${pointer.digest.slice(0, 12)}…; active runs remain pinned`, "warning");
          return;
        }
        if (command === "run") {
          const name = words.shift();
          if (!name) throw new Error("Usage: /runbook run <runbook-name> [request]");
          let prompt = words.join(" ");
          let release = await resolveNamed(name, artifacts, personal, team)
            ?? await projectCandidateRelease(name, ctx);
          if (!release) {
            if (!prompt) {
              if (!ctx.hasUI) {
                throw new Error(`No approved runbook or local candidate named ${name}. Provide a request to create an ad hoc workflow: /runbook run ${name} <request>`);
              }
              const theme = ctx.ui.theme;
              ctx.ui.notify([
                theme.fg("accent", theme.bold(`No saved runbook named ${name}`)),
                "Pi Runbooks can turn this run into a reproducible workflow.",
                "When you run it again, Pi can improve the workflow based on your new instructions and evidence from prior runs.",
                theme.fg("muted", `Keep giving Pi instructions and feedback normally. Once the work is ready for review and you are done, close the runbook with ${theme.fg("success", "/runbook close")}.`),
                "",
                theme.fg("text", "Start by telling Pi what you want it to do."),
              ].join("\n"), "info");
              const entered = await ctx.ui.input(
                "What should Pi do?",
                "Give Pi your instructions for this workflow",
              );
              if (!entered?.trim()) return;
              prompt = entered.trim();
            }
            release = await adHocRelease(name);
          } else if (!prompt) {
            prompt = `Run the ${name} runbook as written. Its procedure and the current working directory define the complete workflow; no additional request was supplied.`;
          }
          const run = await createRun(release, prompt, ctx);
          notifyRunStarted(run, release, ctx);
          pi.sendUserMessage(prompt);
          return;
        }
        if (command === "approve") {
          await approveGate(ctx);
          ctx.ui.notify("Runbook gate approved. Send the next instruction or continue the workflow.", "info");
          return;
        }
        if (command === "close") {
          if (!activeRun || activeRun.status !== "review" || !activeRun.completionReview) {
            throw new Error("No runbook run is ready to close. Complete the work and wait for Pi to submit it for review first.");
          }
          const completedRun = await closeReviewedRun(ctx);
          await startDraft(completedRun.runId, undefined, ctx, "automatic");
          return;
        }
        if (command === "abort") {
          if (!activeRun) throw new Error("No active runbook run");
          activeRun.status = "abandoned";
          delete activeRun.pendingGate;
          delete activeRun.completionReview;
          await runs.save(activeRun);
          await appendFact(ctx, { type: "RUN_ABANDONED", reason: words.join(" ") || "manually abandoned" });
          await setActive(undefined, ctx);
          ctx.ui.notify("Runbook run abandoned", "warning");
          return;
        }
        if (command === "verify") {
          const digest = words[0] ?? activeRun?.artifactDigest;
          if (!digest) throw new Error("Usage: /runbook verify <digest>");
          await artifacts.verify(digest);
          ctx.ui.notify(`Artifact verified: ${digest}`, "info");
          return;
        }
        if (command === "list") {
          const details = words.length === 1 && ["--details", "--verbose", "-v"].includes(words[0] ?? "");
          if (words.length > (details ? 1 : 0)) throw new Error("Usage: /runbook list [--details]");
          if (words.length === 1 && !details) throw new Error("Usage: /runbook list [--details]");

          const registry = await personal.read();
          const teamData = await team?.read();
          const proposalData = await proposals.list();
          const projectCandidates = ctx.isProjectTrusted()
            ? await listProjectCandidates(join(ctx.cwd, CONFIG_DIR_NAME, "runbooks", "candidates"))
            : [];
          const theme = ctx.ui.theme;
          type ReleaseEntry = { digest: string; contract: RunbookContract };
          type WorkflowEntry = {
            name: string;
            personal?: ReleaseEntry;
            team?: ReleaseEntry;
            candidates: typeof projectCandidates;
            proposals: typeof proposalData;
          };
          const workflows = new Map<string, WorkflowEntry>();
          const workflow = (name: string): WorkflowEntry => {
            const existing = workflows.get(name);
            if (existing) return existing;
            const created: WorkflowEntry = { name, candidates: [], proposals: [] };
            workflows.set(name, created);
            return created;
          };

          for (const [name, pointer] of Object.entries(registry.releases)) {
            workflow(name).personal = { digest: pointer.digest, contract: await artifacts.contract(pointer.digest) };
          }
          for (const [name, pointer] of Object.entries(teamData?.releases ?? {})) {
            workflow(name).team = { digest: pointer.digest, contract: await artifacts.contract(pointer.digest) };
          }
          for (const candidate of projectCandidates) workflow(candidate.contract?.name ?? candidate.directoryName).candidates.push(candidate);
          for (const proposal of proposalData) workflow(proposal.name).proposals.push(proposal);

          const entries = [...workflows.values()].sort((left, right) => left.name.localeCompare(right.name));
          const lines: string[] = [theme.fg("accent", theme.bold(`Runbooks (${entries.length})`))];
          if (entries.length === 0) {
            lines.push(`  ${theme.fg("muted", "No runbooks yet.")}`);
            if (details) lines.push(`  Start a workflow with ${theme.fg("accent", "/runbook")} and follow the save instructions when it finishes.`);
          }

          for (const entry of entries) {
            const release = entry.personal ?? entry.team;
            const validCandidates = entry.candidates.filter((candidate) => candidate.contract);
            const invalidCandidates = entry.candidates.filter((candidate) => !candidate.contract);
            const pending = entry.proposals.filter((proposal) => proposal.status === "proposed");
            const statuses: string[] = [];
            if (release) statuses.push(`approved ${entry.personal ? "personal" : "team"}`);
            if (validCandidates.length === 1) statuses.push(`v${validCandidates[0]!.contract!.version} · editable`);
            else if (validCandidates.length > 1) statuses.push(`${validCandidates.length} editable candidates`);
            if (invalidCandidates.length > 0) statuses.push(`${invalidCandidates.length === 1 ? "invalid candidate" : `${invalidCandidates.length} invalid candidates`}`);
            if (pending.length === 1) statuses.push("proposed");
            else if (pending.length > 1) statuses.push(`${pending.length} proposals pending`);
            if (!release && validCandidates.length === 0 && invalidCandidates.length === 0 && pending.length === 0) {
              const latest = [...entry.proposals].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
              if (latest) statuses.push(latest.status);
            }

            const color = release ? "success" : pending.length > 0 || validCandidates.length > 0 ? "warning" : "muted";
            const description = (release?.contract.description ?? validCandidates[0]?.contract?.description)?.replace(/\s+/g, " ").trim();
            if (details) {
              lines.push(`  ${theme.fg(color, theme.bold(entry.name))} ${theme.fg("muted", `· ${statuses.join(" · ")}`)}`);
              if (description) lines.push(`    ${description}`);
              if (release) {
                const scope = entry.personal ? "personal" : "team";
                lines.push(
                  `    ${theme.fg("muted", `Approved: ${scope} · ${release.digest.slice(0, 12)}…`)}`,
                  `    ${theme.fg("accent", `/runbook run ${entry.name}`)} ${theme.fg("muted", "[optional request]")}`,
                );
                if (entry.personal && entry.team) lines.push(`    ${theme.fg("muted", "A personal release overrides the team release.")}`);
              }
              for (const candidate of entry.candidates) {
                const displayPath = relative(ctx.cwd, candidate.sourcePath) || candidate.sourcePath;
                if (candidate.contract) {
                  lines.push(
                    `    ${theme.fg("muted", `Candidate v${candidate.contract.version} · Directory: ${candidate.directoryName} · ${displayPath}`)}`,
                    `    ${theme.fg("accent", `/runbook propose ${candidate.directoryName}`)}`,
                  );
                } else {
                  lines.push(`    ${theme.fg("error", `Invalid candidate: ${candidate.directoryName} · ${displayPath} · ${candidate.error ?? "Unable to read candidate"}`)}`);
                }
              }
              for (const proposal of pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
                lines.push(
                  `    ${proposal.rationale}`,
                  `    Proposal ID: ${proposal.proposalId}`,
                  `    ${theme.fg("success", `/runbook promote ${proposal.proposalId}`)}`,
                  `    ${theme.fg("warning", `/runbook reject ${proposal.proposalId} <reason>`)}`,
                );
              }
            } else {
              const summary = description ? ` — ${description.length > 100 ? `${description.slice(0, 99).trimEnd()}…` : description}` : "";
              lines.push(`  ${theme.fg(color, theme.bold(entry.name))} ${theme.fg("muted", `· ${statuses.join(" · ")}`)}${summary}`);
            }
          }
          if (!details) lines.push("", `${theme.fg("muted", "More details and actions:")} ${theme.fg("accent", "/runbook list --details")}`);
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (command !== "status") throw new Error(`Unknown runbook command: ${command}`);
        if (activeRun) {
          const theme = ctx.ui.theme;
          const lines = [
            theme.fg("accent", theme.bold(activeRun.runbookName)),
            `Status: ${activeRun.status} · Stage: ${activeRun.currentStage ?? "not set"}`,
            `Artifact: ${activeRun.artifactDigest.slice(0, 12)}…`,
          ];
          if (activeRun.pendingGate) {
            lines.push(
              "",
              theme.fg("warning", `Waiting for your approval: ${activeRun.pendingGate.prompt}`),
              `Continue with ${theme.fg("success", "/runbook approve")}`,
            );
          } else if (activeRun.status === "review") {
            lines.push(
              "",
              theme.fg("accent", "The proposed result is ready for review."),
              theme.fg("text", "Ask follow-up questions or request changes; the pinned runbook and its safety policy stay active."),
              `Close only when satisfied: ${theme.fg("success", "/runbook close")}`,
              theme.fg("muted", "Quit safely and reopen this same Pi session later to continue."),
            );
          } else {
            lines.push("", theme.fg("muted", "Quit safely and reopen this same Pi session later to continue."));
          }
          ctx.ui.notify(lines.join("\n"), "info");
        } else {
          const theme = ctx.ui.theme;
          ctx.ui.notify([
            theme.fg("muted", "No runbook run is active."),
            `Start interactively: ${theme.fg("accent", "/runbook")}`,
            `View reusable runbooks: ${theme.fg("accent", "/runbook list")}`,
            `Run one by name: ${theme.fg("accent", "/runbook run <runbook-name> [request]")}`,
          ].join("\n"), "info");
        }
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  // Custom tools are active by default when registered. session_start runs
  // after the extension runtime is bound and selects the appropriate governed
  // tools for either a restored run or the neutral state.
}
