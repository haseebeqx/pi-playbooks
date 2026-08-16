import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { commandEvidenceFromSession, redactCommand } from "../src/trajectory.js";

function contract(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    name: "research-playbook",
    version: "0.1.0",
    description: "A complex research workflow",
    invocation: "explicit",
    requiredCapabilities: ["read", "bash"],
    allowedEffectClasses: ["filesystem.read", "process.exec", "governance"],
    successPredicates: [{ type: "artifact_nonempty", path: "results/report.md" }],
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-"));
  const source = join(root, "source");
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: research-playbook\ndescription: Research.\n---\n\n# Procedure\n", "utf8");
  await writeFile(join(source, "playbook.json"), `${JSON.stringify(contract(), null, 2)}\n`, "utf8");
  await writeFile(join(source, "scripts", "validate.sh"), "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(join(source, "scripts", "validate.sh"), 0o755);
  return { root, source, home: join(root, "home") };
}

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

test("playbooks can be skill-less or declare multiple skill dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-workflow-"));
  const source = join(root, "source");
  await mkdir(join(source, "skills", "research"), { recursive: true });
  await mkdir(join(source, "skills", "reporting"), { recursive: true });
  await writeFile(join(source, "PLAYBOOK.md"), "# Skill-less main workflow\n");
  await writeFile(join(source, "skills", "research", "SKILL.md"), "---\nname: research\ndescription: Research.\n---\n");
  await writeFile(join(source, "skills", "reporting", "SKILL.md"), "---\nname: reporting\ndescription: Report.\n---\n");
  await writeFile(join(source, "playbook.json"), JSON.stringify(contract({
    procedure: "PLAYBOOK.md",
    skillDependencies: ["skills/research", "skills/reporting"],
  })));
  const store = new ArtifactStore(join(root, "home"));
  const manifest = await store.seal(source);
  assert.equal(manifest.procedurePath, "PLAYBOOK.md");
  assert.equal(await store.procedure(manifest.digest), "# Skill-less main workflow\n");
  assert.deepEqual(manifest.contract.skillDependencies, ["skills/research", "skills/reporting"]);
});

test("sealing is content-addressed, immutable, and detects mutation", async () => {
  const { source, home } = await fixture();
  const store = new ArtifactStore(home);
  const first = await store.seal(source);
  const second = await store.seal(source);
  assert.equal(first.digest, second.digest);
  assert.equal((await store.contract(first.digest)).name, "research-playbook");
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
    playbookName: base.contract.name,
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
  await writeFile(join(candidateDirectory, "playbook.json"), `${JSON.stringify(contract({ version: "0.1.1" }), null, 2)}\n`);
  const candidate = await artifacts.seal(candidateDirectory);
  const evaluation = await evaluateCandidate(artifacts, run, candidate.digest);

  assert.equal(evaluation.passed, true);
  assert.deepEqual(evaluation.changes, { added: [], modified: ["SKILL.md", "playbook.json"], removed: [] });
  assert.deepEqual(artifactChanges(base, candidate), evaluation.changes);
  assert.equal(evaluation.checks.every((check) => check.passed), true);
});

test("personal registry promotion and rollback preserve lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-registry-"));
  const registry = new ReleaseRegistry(join(root, "registry.json"));
  await registry.promote("research-playbook", "a".repeat(64));
  await registry.promote("research-playbook", "b".repeat(64));
  const rolledBack = await registry.rollback("research-playbook");
  assert.equal(rolledBack.digest, "a".repeat(64));
  assert.equal(rolledBack.previousDigest, "b".repeat(64));
});

test("automatic resolution honors personal-over-team precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-resolution-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-candidates-"));
  const valid = join(root, "review-process-run123");
  const invalid = join(root, "unfinished");
  await mkdir(valid);
  await mkdir(invalid);
  await writeFile(join(valid, "playbook.json"), JSON.stringify(contract({ name: "review-process" })));
  await writeCandidateMetadata(valid, { baseDigest: "a".repeat(64), runId: "12345678-1234-1234-1234-123456789abc", workflow: "automatic" });

  const candidates = await listProjectCandidates(root);
  assert.deepEqual(candidates.map((candidate) => candidate.directoryName), ["review-process-run123", "unfinished"]);
  assert.equal(candidates[0]?.contract?.name, "review-process");
  assert.equal(candidates[0]?.metadata?.baseDigest, "a".repeat(64));
  assert.equal(candidates[0]?.metadata?.workflow, "automatic");
  assert.match(candidates[1]?.error ?? "", /missing playbook.json/);
});

test("project candidates resolve by contract name or exact directory without requiring approval", () => {
  const parsed = validateContract(contract({ name: "review-process" }));
  const candidates = [
    { directoryName: "review-process-run123", sourcePath: "/one", contract: parsed },
    { directoryName: "review-process-run456", sourcePath: "/two", contract: parsed },
    { directoryName: "broken", sourcePath: "/broken", error: "missing playbook.json" },
  ];

  assert.equal(selectProjectCandidate([candidates[0]!], "review-process")?.sourcePath, "/one");
  assert.equal(selectProjectCandidate(candidates, "review-process-run456")?.sourcePath, "/two");
  assert.throws(
    () => selectProjectCandidate(candidates, "review-process"),
    /Choose a candidate directory: review-process-run123, review-process-run456/,
  );
  assert.throws(() => selectProjectCandidate(candidates, "broken"), /missing playbook.json/);
});

test("candidate provenance is not included in sealed artifacts", async () => {
  const { source, home } = await fixture();
  await writeCandidateMetadata(source, { baseDigest: "a".repeat(64), runId: "12345678-1234-1234-1234-123456789abc" });
  const manifest = await new ArtifactStore(home).seal(source);
  assert.equal(manifest.files.some((file) => file.path === CANDIDATE_METADATA_FILE), false);
});

test("equivalent learning proposals are suppressed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-proposals-"));
  const proposals = new ProposalStore(root);
  const input = {
    name: "research-playbook",
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
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-proposal-status-"));
  const proposals = new ProposalStore(root);
  const proposal = await proposals.create({
    name: "research-playbook",
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

test("run assignment remains pinned while registry changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-runs-"));
  const runs = new RunStore(root);
  const run = await runs.create({
    playbookName: "research-playbook",
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
  assert.equal((await runs.activeForSession("session"))[0]?.status, "review");
});

test("success predicates and effect policy fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-outcome-"));
  const parsed = validateContract(contract());
  assert.equal((await evaluatePredicates(parsed, root))[0]?.passed, false);
  await mkdir(join(root, "results"));
  await writeFile(join(root, "results", "report.md"), "report\n");
  assert.equal((await evaluatePredicates(parsed, root))[0]?.passed, true);
  assert.equal(decide(parsed, "write", { path: "x" }).decision, "deny");
  assert.equal(decide(parsed, "bash", { command: "sudo rm -rf /tmp/x" }).decision, "require_approval");
  assert.equal(decide(parsed, "bash", { command: "rm -r -f /tmp/x" }).decision, "require_approval");
  const adHoc = validateContract(contract({ allowedEffectClasses: ["*"] }));
  assert.equal(decide(adHoc, "bash", { command: "terraform apply plan.tfplan" }).decision, "require_approval");
  assert.equal(decide(adHoc, "bash", { command: "aws cloudformation deploy --stack-name app" }).decision, "require_approval");
});

test("run artifacts cannot resolve through symlinks outside the run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-playbooks-outside-"));
  await writeFile(join(outside, "report.md"), "external report\n");
  await symlink(outside, join(root, "results"));
  const parsed = validateContract(contract());

  const [result] = await evaluatePredicates(parsed, root);
  assert.equal(result?.passed, false);
  assert.match(result?.reason ?? "", /resolves outside allowed root/);
  await assert.rejects(hashRunArtifact(root, "results/report.md"), /resolves outside allowed root/);
});

test("draft command evidence is run-bounded, outcome-aware, aggregated, and redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-trajectory-"));
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
  const root = await mkdtemp(join(tmpdir(), "pi-playbooks-ledger-"));
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
