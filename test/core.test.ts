import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import runbooksExtension, { approvalExplanation, workflowGateExplanation } from "../extensions/runbooks.js";
import { ArtifactStore } from "../src/artifacts.js";
import { CANDIDATE_METADATA_FILE, listProjectCandidates, selectProjectCandidate, writeCandidateMetadata } from "../src/candidates.js";
import { validateContract, isApplicable } from "../src/contract.js";
import { artifactChanges, evaluateCandidate } from "../src/evaluation.js";
import { appendAdditionalInstruction, nextSourceVersion } from "../src/instructions.js";
import { FactLedger } from "../src/ledger.js";
import { decide } from "../src/policy.js";
import { assertProposalIsProposed, ProposalStore } from "../src/proposals.js";
import { ReleaseRegistry } from "../src/registry.js";
import { resolveAutomatic } from "../src/resolver.js";
import { evaluatePredicates, hashRunArtifact, RunStore } from "../src/runs.js";
import { runbookToSkill, skillToRunbook } from "../src/skill-conversion.js";
import { commandEvidenceFromSession, redactCommand } from "../src/trajectory.js";

function contract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    name: "research-runbook",
    version: "0.1.0",
    description: "A complex research workflow",
    invocation: "explicit",
    requiredCapabilities: ["read", "bash"],
    allowedEffectClasses: ["filesystem.read", "process.exec", "governance"],
    successPredicates: [{ type: "artifact_nonempty", path: "results/report.md" }],
    ...overrides,
  };
}

test("extension loading registers only the runbook namespace and tools", () => {
  const registrations = { events: 0, tools: [] as string[], commands: [] as string[] };
  const loadingApi = {
    on: () => { registrations.events += 1; },
    registerTool: (tool: { name: string }) => { registrations.tools.push(tool.name); },
    registerCommand: (name: string) => { registrations.commands.push(name); },
    getActiveTools: () => { throw new Error("action method called during extension loading"); },
    getAllTools: () => { throw new Error("action method called during extension loading"); },
    setActiveTools: () => { throw new Error("action method called during extension loading"); },
  } as unknown as ExtensionAPI;

  assert.doesNotThrow(() => runbooksExtension(loadingApi));
  assert.equal(registrations.events, 8);
  assert.deepEqual(registrations.commands, ["runbook"]);
  assert.deepEqual(registrations.tools.sort(), ["runbook_checkpoint", "runbook_complete_learning", "runbook_finish"]);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-"));
  const source = join(root, "source");
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: research-runbook\ndescription: Research.\n---\n\n# Procedure\n", "utf8");
  await writeFile(join(source, "runbook.json"), `${JSON.stringify(contract(), null, 2)}\n`, "utf8");
  await writeFile(join(source, "scripts", "validate.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(source, "scripts", "validate.sh"), 0o755);
  return { root, source, home: join(root, "home") };
}

test("runbook command completes approved names without invoking the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-completion-"));
  const home = join(root, "home");
  await new ReleaseRegistry(join(home, "registry.json")).promote("release-check", "a".repeat(64));

  let getArgumentCompletions: ((prefix: string) => Promise<Array<{ value: string; label: string }> | null>) | undefined;
  const api = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (_name: string, options: { getArgumentCompletions: typeof getArgumentCompletions }) => {
      getArgumentCompletions = options.getArgumentCompletions;
    },
  } as unknown as ExtensionAPI;

  const previousHome = process.env.PI_RUNBOOKS_HOME;
  process.env.PI_RUNBOOKS_HOME = home;
  try {
    runbooksExtension(api);
  } finally {
    if (previousHome === undefined) delete process.env.PI_RUNBOOKS_HOME;
    else process.env.PI_RUNBOOKS_HOME = previousHome;
  }

  assert.deepEqual(await getArgumentCompletions?.("run rel"), [{
    value: "run release-check",
    label: "release-check",
    description: "personal approved",
  }]);
  assert.deepEqual(await getArgumentCompletions?.("edit rel"), [{
    value: "edit release-check",
    label: "release-check",
    description: "personal approved",
  }]);
  assert.equal(await getArgumentCompletions?.("run release-check request"), null);
});

test("extension restores an active run and its prompt controls when the same session reopens", async () => {
  const { root, source, home } = await fixture();
  const artifacts = new ArtifactStore(home);
  const sealed = await artifacts.seal(source);
  const runs = new RunStore(home);
  const run = await runs.create({
    runbookName: sealed.contract.name,
    artifactDigest: sealed.digest,
    releaseScope: "personal",
    cwd: root,
    sessionId: "same-session",
    originalPrompt: "research this",
    toolAttestations: [],
  });

  const handlers = new Map<string, (event: unknown, ctx: any) => Promise<any>>();
  let activeTools = ["read", "bash"];
  const api = {
    on: (name: string, handler: (event: unknown, ctx: any) => Promise<any>) => { handlers.set(name, handler); },
    registerTool: () => {},
    registerCommand: () => {},
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
    getAllTools: () => [],
  } as unknown as ExtensionAPI;
  const previousHome = process.env.PI_RUNBOOKS_HOME;
  process.env.PI_RUNBOOKS_HOME = home;
  try {
    runbooksExtension(api);
  } finally {
    if (previousHome === undefined) delete process.env.PI_RUNBOOKS_HOME;
    else process.env.PI_RUNBOOKS_HOME = previousHome;
  }

  const branch = [{
    type: "custom",
    id: "assignment",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: "pi-runbooks:assignment",
    data: { runId: run.runId },
  }];
  const ctx = {
    cwd: root,
    isProjectTrusted: () => false,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "same-session",
      getLeafId: () => "assignment",
    },
    ui: { setStatus: () => {}, setWidget: () => {} },
  };
  await handlers.get("session_start")?.({}, ctx);
  assert.ok(activeTools.includes("runbook_checkpoint"));
  assert.ok(activeTools.includes("runbook_finish"));

  const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "continue" }, ctx);
  assert.match(result?.systemPrompt ?? "", new RegExp(`Pinned artifact: ${sealed.digest}`));
  assert.doesNotMatch(result?.systemPrompt ?? "", /Run ID:|Assignment ID:/);
  assert.match(result?.systemPrompt ?? "", /# Procedure/);
});

test("from-skill resolves currently loaded Pi skills by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-loaded-skill-"));
  const skillFile = join(root, "release-check.md");
  await writeFile(skillFile, "---\nname: release-check\ndescription: Check a release.\n---\n\n# Check\n");
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  const api = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; },
    getCommands: () => [{
      name: "skill:release-check",
      source: "skill",
      sourceInfo: { path: skillFile, source: "settings", scope: "user", origin: "top-level" },
    }],
  } as unknown as ExtensionAPI;
  runbooksExtension(api);
  assert.ok(handler);
  await handler("from-skill release-check candidate", {
    cwd: root,
    isProjectTrusted: () => false,
    ui: {
      notify: (message: string) => { notices.push(message); },
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    },
  });
  assert.equal(JSON.parse(await readFile(join(root, "candidate", "runbook.json"), "utf8")).name, "release-check");
  assert.match(notices[0] ?? "", /Converted Pi skill/);
});

test("persistent instructions append to the procedure and advance source versions", () => {
  assert.equal(nextSourceVersion("0.1.9"), "0.1.10");
  assert.equal(nextSourceVersion("release"), "release.1");
  assert.equal(
    appendAdditionalInstruction("# Procedure\n\n1. Inspect.\n", "Always verify generated files."),
    "# Procedure\n\n1. Inspect.\n\n## Additional instructions\n\n- Always verify generated files.\n",
  );
  assert.equal(
    appendAdditionalInstruction("# Procedure\n\n## Additional instructions\n\n- First.\n\n## Finish\n\nDone.\n", "Second."),
    "# Procedure\n\n## Additional instructions\n\n- First.\n\n- Second.\n\n## Finish\n\nDone.\n",
  );
});

test("contract validation rejects path traversal and ambiguous values", () => {
  assert.throws(() => validateContract(contract({ artifacts: [{ name: "x", path: "../secret" }] })), /inside the run directory/);
  assert.throws(() => validateContract(contract({ invocation: "sometimes" })), /invocation/);
  assert.equal(validateContract(contract({ name: "what" })).name, "what");
});

test("applicability is deterministic and UNKNOWN does not match", async () => {
  const { root } = await fixture();
  const parsed = validateContract(contract({ applicability: { requiredFiles: ["package.json"] } }));
  assert.deepEqual(await isApplicable(parsed, root), { matches: false, reason: "required file missing: package.json" });
  await writeFile(join(root, "package.json"), "{}\n");
  assert.equal((await isApplicable(parsed, root)).matches, true);
});

test("runbooks can be skill-less or declare multiple skill dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-workflow-"));
  const source = join(root, "source");
  await mkdir(join(source, "skills", "research"), { recursive: true });
  await mkdir(join(source, "skills", "reporting"), { recursive: true });
  await writeFile(join(source, "RUNBOOK.md"), "# Skill-less main workflow\n");
  await writeFile(join(source, "skills", "research", "SKILL.md"), "---\nname: research\ndescription: Research.\n---\n");
  await writeFile(join(source, "skills", "reporting", "SKILL.md"), "---\nname: reporting\ndescription: Report.\n---\n");
  await writeFile(join(source, "runbook.json"), JSON.stringify(contract({
    procedure: "RUNBOOK.md",
    skillDependencies: ["skills/research", "skills/reporting"],
  })));
  const store = new ArtifactStore(join(root, "home"));
  const manifest = await store.seal(source);
  assert.equal(manifest.procedurePath, "RUNBOOK.md");
  assert.equal(await store.procedure(manifest.digest), "# Skill-less main workflow\n");
  assert.deepEqual(manifest.contract.skillDependencies, ["skills/research", "skills/reporting"]);
});

test("Pi skills convert to editable runbooks and sealed runbooks export as standalone skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-skill-conversion-"));
  const skill = join(root, "source-skill");
  const candidate = join(root, "candidate");
  const exported = join(root, "exported-skill");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: release-check\ndescription: Check whether a project is ready to release.\nallowed-tools: read bash\n---\n\n# Release check\n\nRun the bundled validator.\n");
  await writeFile(join(skill, "scripts", "validate.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(skill, "scripts", "validate.sh"), 0o755);

  const converted = await skillToRunbook(skill, candidate);
  assert.equal(converted.name, "release-check");
  assert.equal(converted.procedure, "SKILL.md");
  assert.deepEqual(converted.requiredCapabilities, ["runbook_checkpoint", "runbook_finish"]);
  assert.equal((await readFile(join(candidate, "SKILL.md"), "utf8")).includes("# Release check"), true);

  const artifacts = new ArtifactStore(join(root, "home"));
  const sealed = await artifacts.seal(candidate);
  await runbookToSkill(artifacts, sealed.digest, exported);
  const exportedSkill = await readFile(join(exported, "SKILL.md"), "utf8");
  assert.match(exportedSkill, /^---\nname: release-check\ndescription: "Check whether a project is ready to release\."\n---/);
  assert.match(exportedSkill, /# Release check/);
  await assert.rejects(readFile(join(exported, "runbook.json"), "utf8"), /ENOENT/);
  assert.equal((await lstat(join(exported, "scripts", "validate.sh"))).mode & 0o111, 0o111);
});

test("skill conversion rejects invalid metadata and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-invalid-skill-"));
  const invalid = join(root, "invalid");
  await mkdir(invalid);
  await writeFile(join(invalid, "SKILL.md"), "---\nname: Invalid Name\ndescription: Bad.\n---\n");
  await assert.rejects(skillToRunbook(invalid, join(root, "candidate")), /frontmatter name/);

  const linked = join(root, "linked");
  await mkdir(linked);
  await writeFile(join(linked, "SKILL.md"), "---\nname: linked\ndescription: Linked skill.\n---\n");
  await symlink(join(invalid, "SKILL.md"), join(linked, "reference.md"));
  await assert.rejects(skillToRunbook(linked, join(root, "linked-candidate")), /does not allow symlinks/);
});

test("sealing is content-addressed, immutable, and detects mutation", async () => {
  const { source, home } = await fixture();
  const store = new ArtifactStore(home);
  const first = await store.seal(source);
  const second = await store.seal(source);
  assert.equal(first.digest, second.digest);
  assert.equal((await store.contract(first.digest)).name, "research-runbook");
  await chmod(join(store.contentRoot(first.digest), "SKILL.md"), 0o644);
  await writeFile(join(store.contentRoot(first.digest), "SKILL.md"), "mutated");
  await assert.rejects(store.verify(first.digest), /integrity check failed/);
});

test("artifact verification rejects security-sensitive manifest tampering", async () => {
  const { source, home } = await fixture();
  const store = new ArtifactStore(home);
  const sealed = await store.seal(source);
  const manifestPath = join(store.artifactRoot(sealed.digest), "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    contract: { allowedEffectClasses: string[] };
  };
  manifest.contract.allowedEffectClasses = ["*"];
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  await assert.rejects(store.verify(sealed.digest), /manifest does not match sealed content/);
  await assert.rejects(store.contract(sealed.digest), /manifest does not match sealed content/);
});

test("candidate evaluation verifies identity, evidence state, and material artifact changes", async () => {
  const { root, source, home } = await fixture();
  const artifacts = new ArtifactStore(home);
  const base = await artifacts.seal(source);
  const runs = new RunStore(home);
  const run = await runs.create({
    runbookName: base.contract.name,
    artifactDigest: base.digest,
    releaseScope: "personal",
    cwd: root,
    sessionId: "session",
    originalPrompt: "research this",
    toolAttestations: [],
  });
  run.status = "completed";
  await runs.save(run);

  const candidateDirectory = join(root, "candidate");
  await artifacts.materializeForRevision(base.digest, candidateDirectory);
  await writeFile(join(candidateDirectory, "SKILL.md"), "# Improved procedure\n");
  await writeFile(join(candidateDirectory, "runbook.json"), `${JSON.stringify(contract({ version: "0.1.1" }), null, 2)}\n`);
  const candidate = await artifacts.seal(candidateDirectory);
  const evaluation = await evaluateCandidate(artifacts, run, candidate.digest);

  assert.equal(evaluation.passed, true);
  assert.deepEqual(evaluation.changes, { added: [], modified: ["SKILL.md", "runbook.json"], removed: [] });
  assert.deepEqual(artifactChanges(base, candidate), evaluation.changes);
  assert.equal(evaluation.checks.every((check) => check.passed), true);
});

test("personal registry promotion and rollback preserve lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-registry-"));
  const registry = new ReleaseRegistry(join(root, "registry.json"));
  await registry.promote("research-runbook", "a".repeat(64));
  await registry.promote("research-runbook", "b".repeat(64));
  const rolledBack = await registry.rollback("research-runbook");
  assert.equal(rolledBack.digest, "a".repeat(64));
  assert.equal(rolledBack.previousDigest, "b".repeat(64));
});

test("automatic resolution honors personal-over-team precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-resolution-"));
  const personal = new ReleaseRegistry(join(root, "personal.json"));
  const team = new ReleaseRegistry(join(root, "team.json"));
  await personal.promote("personal-auto", "a".repeat(64));
  await team.promote("team-auto", "b".repeat(64));
  const contracts = new Map([
    ["a".repeat(64), validateContract(contract({ name: "personal-auto", invocation: "auto", requiredCapabilities: [] }))],
    ["b".repeat(64), validateContract(contract({ name: "team-auto", invocation: "auto", requiredCapabilities: [] }))],
  ]);
  const fakeArtifacts = { contract: async (digest: string) => contracts.get(digest)! } as ArtifactStore;
  const resolved = await resolveAutomatic(root, fakeArtifacts, personal, team);
  assert.equal(resolved.match?.name, "personal-auto");
  assert.deepEqual(resolved.conflicts, []);
});

test("project candidate workspaces are discovered with provenance and invalid entries remain visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-candidates-"));
  const valid = join(root, "review-process-run123");
  const invalid = join(root, "unfinished");
  await mkdir(valid);
  await mkdir(invalid);
  await writeFile(join(valid, "runbook.json"), JSON.stringify(contract({ name: "review-process" })));
  await writeCandidateMetadata(valid, { baseDigest: "a".repeat(64), runId: "12345678-1234-1234-1234-123456789abc", workflow: "automatic" });

  const candidates = await listProjectCandidates(root);
  assert.deepEqual(candidates.map((candidate) => candidate.directoryName), ["review-process-run123", "unfinished"]);
  assert.equal(candidates[0]?.contract?.name, "review-process");
  assert.equal(candidates[0]?.metadata?.baseDigest, "a".repeat(64));
  assert.equal(candidates[0]?.metadata?.workflow, "automatic");
  assert.match(candidates[1]?.error ?? "", /missing runbook.json/);
});

test("runbook list is concise by default and exposes details on request", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-list-"));
  const home = join(root, "home");
  const candidate = join(root, ".pi", "runbooks", "candidates", "research-draft");
  const proposedCandidate = join(root, ".pi", "runbooks", "candidates", "review-process-draft");
  await mkdir(candidate, { recursive: true });
  await mkdir(proposedCandidate, { recursive: true });
  await writeFile(join(candidate, "runbook.json"), JSON.stringify(contract({ name: "research-draft", version: "0.2.0" })));
  await writeFile(join(proposedCandidate, "runbook.json"), JSON.stringify(contract({ name: "review-process", version: "0.3.0" })));
  const proposal = await new ProposalStore(home).create({
    name: "review-process",
    candidateDigest: "a".repeat(64),
    evidenceRunIds: [],
    rationale: "A long internal explanation that belongs in the detailed view.",
  });

  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const previousHome = process.env.PI_RUNBOOKS_HOME;
  process.env.PI_RUNBOOKS_HOME = home;
  try {
    runbooksExtension({
      on: () => {},
      registerTool: () => {},
      registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; },
    } as unknown as ExtensionAPI);
  } finally {
    if (previousHome === undefined) delete process.env.PI_RUNBOOKS_HOME;
    else process.env.PI_RUNBOOKS_HOME = previousHome;
  }
  assert.ok(handler);

  const notices: string[] = [];
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      notify: (message: string) => { notices.push(message); },
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    },
  };
  await handler("list", ctx);
  const concise = notices.pop() ?? "";
  assert.match(concise, /research-draft · v0\.2\.0 · editable/);
  assert.match(concise, /review-process · v0\.3\.0 · editable · proposed/);
  assert.equal(concise.split("\n").filter((line) => /^  review-process ·/.test(line)).length, 1);
  assert.match(concise, /\/runbook list --details/);
  assert.doesNotMatch(concise, /Directory:|Proposal ID:|long internal explanation|\/runbook promote/);

  await handler("list --details", ctx);
  const detailed = notices.pop() ?? "";
  assert.match(detailed, /Directory: research-draft/);
  assert.match(detailed, /Directory: review-process-draft/);
  assert.equal(detailed.split("\n").filter((line) => /^  review-process ·/.test(line)).length, 1);
  assert.match(detailed, new RegExp(`Proposal ID: ${proposal.proposalId}`));
  assert.match(detailed, /long internal explanation/);
  assert.match(detailed, /\/runbook promote/);
});

test("project candidates resolve by contract name or exact directory without requiring approval", () => {
  const parsed = validateContract(contract({ name: "review-process" }));
  const candidates = [
    { directoryName: "review-process-run123", sourcePath: "/one", contract: parsed },
    { directoryName: "review-process-run456", sourcePath: "/two", contract: parsed },
    { directoryName: "broken", sourcePath: "/broken", error: "missing runbook.json" },
  ];

  assert.equal(selectProjectCandidate([candidates[0]!], "review-process")?.sourcePath, "/one");
  assert.equal(selectProjectCandidate(candidates, "review-process-run456")?.sourcePath, "/two");
  assert.throws(
    () => selectProjectCandidate(candidates, "review-process"),
    /Choose a candidate directory: review-process-run123, review-process-run456/,
  );
  assert.throws(() => selectProjectCandidate(candidates, "broken"), /missing runbook.json/);
});

test("candidate provenance is not included in sealed artifacts", async () => {
  const { source, home } = await fixture();
  await writeCandidateMetadata(source, { baseDigest: "a".repeat(64), runId: "12345678-1234-1234-1234-123456789abc" });
  const manifest = await new ArtifactStore(home).seal(source);
  assert.equal(manifest.files.some((file) => file.path === CANDIDATE_METADATA_FILE), false);
});

test("equivalent learning proposals are suppressed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-proposals-"));
  const proposals = new ProposalStore(root);
  const input = {
    name: "research-runbook",
    candidateDigest: "b".repeat(64),
    baseDigest: "a".repeat(64),
    evidenceRunIds: ["run-1"],
    rationale: "Improve recovery",
  };
  const first = await proposals.create(input);
  const second = await proposals.create({ ...input, rationale: "Duplicate wording" });
  assert.equal(second.proposalId, first.proposalId);
  assert.equal((await proposals.list()).length, 1);
});

test("only pending proposals can be promoted or rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-proposal-status-"));
  const proposals = new ProposalStore(root);
  const proposal = await proposals.create({
    name: "research-runbook",
    candidateDigest: "b".repeat(64),
    evidenceRunIds: [],
    rationale: "Bootstrap candidate",
  });

  assert.doesNotThrow(() => assertProposalIsProposed(proposal, "promote"));
  proposal.status = "rejected";
  assert.throws(() => assertProposalIsProposed(proposal, "promote"), /cannot be promoted: rejected/);
  assert.throws(() => assertProposalIsProposed(proposal, "reject"), /cannot be rejected: rejected/);
  proposal.status = "promoted";
  assert.throws(() => assertProposalIsProposed(proposal, "reject"), /cannot be rejected: promoted/);
});

test("run assignment remains pinned and restores from the current session branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-runs-"));
  const runs = new RunStore(root);
  const run = await runs.create({
    runbookName: "research-runbook",
    artifactDigest: "a".repeat(64),
    releaseScope: "personal",
    cwd: root,
    sessionId: "session",
    originalPrompt: "research this",
    toolAttestations: [],
  });
  const stored = await runs.read(run.runId);
  assert.equal(stored.artifactDigest, "a".repeat(64));

  stored.status = "review";
  stored.completionReview = {
    outcome: "success",
    summary: "Ready for user review",
    proposedAt: new Date().toISOString(),
    predicateResults: [],
  };
  await runs.save(stored);

  assert.equal((await runs.activeForAssignments([run.runId], "session"))?.status, "review");
  assert.equal(await runs.activeForAssignments([], "session"), undefined);
  assert.equal(await runs.activeForAssignments([run.runId], "forked-session"), undefined);
  assert.equal(
    await runs.activeForAssignments([run.runId, "00000000-0000-0000-0000-000000000000"], "session"),
    undefined,
    "a newer assignment marker supersedes older branch assignments even when its run record is unavailable",
  );

  stored.status = "completed";
  await runs.save(stored);
  assert.equal(await runs.activeForAssignments([run.runId], "session"), undefined);
});

test("success predicates and effect policy fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-outcome-"));
  const parsed = validateContract(contract());
  assert.equal((await evaluatePredicates(parsed, root))[0]?.passed, false);
  await mkdir(join(root, "results"));
  await writeFile(join(root, "results", "report.md"), "report\n");
  assert.equal((await evaluatePredicates(parsed, root))[0]?.passed, true);
  assert.equal(decide(parsed, "write", { path: "x" }).decision, "deny");
  const destructive = decide(parsed, "bash", { command: "sudo rm -rf /tmp/x" });
  assert.equal(destructive.decision, "require_approval");
  assert.match(destructive.reason, /privilege elevation \(sudo\).*file deletion \(rm\)/);
  assert.match(destructive.approvalDetails?.purpose.join(" ") ?? "", /elevated.*Delete/s);
  assert.match(destructive.approvalDetails?.risks.join(" ") ?? "", /system-wide.*recover/s);
  assert.equal(decide(parsed, "bash", { command: "rm -r -f /tmp/x" }).decision, "require_approval");
  const adHoc = validateContract(contract({ allowedEffectClasses: ["*"] }));
  const terraform = decide(adHoc, "bash", { command: "terraform apply plan.tfplan" });
  assert.equal(terraform.decision, "require_approval");
  assert.match(terraform.approvalDetails?.purpose[0] ?? "", /managed infrastructure/);
  assert.match(terraform.approvalDetails?.risks[0] ?? "", /downtime, data loss, or cost changes/);
  const aws = decide(adHoc, "bash", { command: "aws cloudformation deploy --stack-name app" });
  assert.equal(aws.decision, "require_approval");
  assert.match(aws.approvalDetails?.purpose[0] ?? "", /selected AWS account and region/);
  const protectedWrite = decide(adHoc, "edit", { path: ".env" });
  assert.equal(protectedWrite.decision, "require_approval");
  assert.match(protectedWrite.reason, /protected path \.env/);

  const explanation = approvalExplanation(
    terraform,
    "command",
    "terraform apply plan.tfplan",
    { runbookName: "deploy-app", originalPrompt: "Deploy the reviewed plan", currentStage: "deployment" } as any,
    { description: "Deploy the application infrastructure" } as any,
  );
  assert.match(explanation, /What it tries to accomplish:/);
  assert.match(explanation, /Why it is needed:/);
  assert.match(explanation, /workflow goal.*Deploy the application infrastructure/s);
  assert.match(explanation, /Risks if approved:.*downtime, data loss, or cost changes/s);
  assert.match(explanation, /Exact command:\nterraform apply plan\.tfplan/);
});

test("workflow gate approval explains the decision, scope, and consequences", () => {
  const explanation = workflowGateExplanation(
    {
      runbookName: "deploy-app",
      originalPrompt: "Deploy the reviewed plan to staging",
      currentStage: "plan-review",
      pendingGate: {
        id: "approve-plan",
        prompt: "Confirm that the staging infrastructure plan is acceptable",
        requestedAt: new Date().toISOString(),
        stage: "plan-review",
        summary: "Generated and reviewed the infrastructure plan; deployment remains.",
        artifactPaths: ["results/plan.txt"],
      },
    } as any,
    {
      description: "Review and deploy application infrastructure",
      allowedEffectClasses: ["filesystem.read", "process.exec", "governance"],
    } as any,
  );

  assert.match(explanation, /Decision requested:\nConfirm that the staging infrastructure plan is acceptable/);
  assert.match(explanation, /What has been completed:.*Generated and reviewed/s);
  assert.match(explanation, /Why continuation is requested:.*Deploy the reviewed plan to staging/s);
  assert.match(explanation, /What approval does:.*Releases only this workflow gate/s);
  assert.match(explanation, /does not pre-approve a command, deployment, publication/s);
  assert.match(explanation, /Potential consequences:.*later workflow stages/s);
  assert.match(explanation, /Checkpoint artifacts:\n- results\/plan\.txt/);
  assert.match(explanation, /workflow remains paused and you can request changes/);
});

test("run artifacts cannot resolve through symlinks outside the run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-runbooks-outside-"));
  await writeFile(join(outside, "report.md"), "external report\n");
  await symlink(outside, join(root, "results"));
  const parsed = validateContract(contract());

  const [result] = await evaluatePredicates(parsed, root);
  assert.equal(result?.passed, false);
  assert.match(result?.reason ?? "", /resolves outside allowed root/);
  await assert.rejects(hashRunArtifact(root, "results/report.md"), /resolves outside allowed root/);
});

test("draft command evidence is run-bounded, outcome-aware, aggregated, and redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-trajectory-"));
  const sessionFile = join(root, "session.jsonl");
  const entries = [
    { type: "message", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "before", name: "bash", arguments: { command: "ignore-before" } }] } },
    { type: "message", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [
      { type: "toolCall", id: "one", name: "bash", arguments: { command: "npm test" } },
      { type: "toolCall", id: "secret", name: "bash", arguments: { command: "API_TOKEN=hunter2 deploy --password secret" } },
    ] } },
    { type: "message", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolName: "bash", toolCallId: "one", isError: false, content: [{ type: "text", text: "large output is not retained" }] } },
    { type: "message", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "two", name: "bash", arguments: { command: "npm test" } }] } },
    { type: "message", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolName: "bash", toolCallId: "two", isError: true, content: [] } },
    { type: "message", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "after", name: "bash", arguments: { command: "ignore-after" } }] } },
  ];
  await writeFile(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const evidence = await commandEvidenceFromSession(sessionFile, "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:06.000Z");
  assert.equal(evidence.length, 2);
  assert.deepEqual(
    { command: evidence[0]?.command, attempts: evidence[0]?.attempts, succeeded: evidence[0]?.succeeded, failed: evidence[0]?.failed },
    { command: "npm test", attempts: 2, succeeded: 1, failed: 1 },
  );
  assert.equal(evidence[1]?.command, "API_TOKEN=<redacted> deploy --password=<redacted>");
  assert.equal(JSON.stringify(evidence).includes("large output"), false);
  assert.equal(redactCommand("--api-key=abc command"), "--api-key=<redacted> command");
});

test("fact ledger appends complete JSONL records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runbooks-ledger-"));
  const path = join(root, "facts.jsonl");
  const ledger = new FactLedger(path);
  await Promise.all([
    ledger.append({ type: "PROPOSED", reason: "one" }),
    ledger.append({ type: "BLOCKED", reason: "two" }),
  ]);
  const facts = await ledger.readAll();
  assert.deepEqual(facts.map((fact) => fact.type), ["PROPOSED", "BLOCKED"]);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
});
