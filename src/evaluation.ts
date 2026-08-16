import type { ArtifactStore } from "./artifacts.js";
import type { ArtifactManifest, PlaybookRun } from "./types.js";

export interface ArtifactChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface CandidateEvaluation {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; reason: string }>;
  changes: ArtifactChanges;
}

export function artifactChanges(base: ArtifactManifest, candidate: ArtifactManifest): ArtifactChanges {
  const before = new Map(base.files.map((file) => [file.path, file]));
  const after = new Map(candidate.files.map((file) => [file.path, file]));
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const modified = [...after.entries()]
    .filter(([path, file]) => {
      const previous = before.get(path);
      return previous && (previous.sha256 !== file.sha256 || previous.executable !== file.executable);
    })
    .map(([path]) => path)
    .sort();
  return { added, modified, removed };
}

export async function evaluateCandidate(
  artifacts: ArtifactStore,
  run: PlaybookRun,
  candidateDigest: string,
): Promise<CandidateEvaluation> {
  await artifacts.verify(run.artifactDigest);
  await artifacts.verify(candidateDigest);
  const [base, candidate] = await Promise.all([
    artifacts.manifest(run.artifactDigest),
    artifacts.manifest(candidateDigest),
  ]);
  const changes = artifactChanges(base, candidate);
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "abandoned";
  const checks = [
    {
      name: "terminal evidence run",
      passed: terminal,
      reason: terminal ? `evidence run is ${run.status}` : `evidence run is still ${run.status}`,
    },
    {
      name: "base lineage",
      passed: base.digest === run.artifactDigest,
      reason: base.digest === run.artifactDigest ? "candidate was derived from the assigned base" : "base digest does not match the evidence run",
    },
    {
      name: "playbook identity",
      passed: candidate.contract.name === run.playbookName,
      reason: candidate.contract.name === run.playbookName
        ? `candidate remains ${run.playbookName}`
        : `candidate changed name from ${run.playbookName} to ${candidate.contract.name}`,
    },
    {
      name: "material change",
      passed: candidate.digest !== base.digest,
      reason: candidate.digest !== base.digest ? "candidate differs from its base" : "candidate is byte-identical to its base",
    },
    {
      name: "source version updated",
      passed: candidate.contract.version !== base.contract.version,
      reason: candidate.contract.version !== base.contract.version
        ? `source version changed from ${base.contract.version} to ${candidate.contract.version}`
        : `source version remains ${base.contract.version}`,
    },
    {
      name: "procedure retained",
      passed: candidate.files.some((file) => file.path === candidate.procedurePath && file.size > 0),
      reason: candidate.files.some((file) => file.path === candidate.procedurePath && file.size > 0)
        ? `procedure ${candidate.procedurePath} is non-empty`
        : "candidate procedure is missing or empty",
    },
  ];
  return { passed: checks.every((check) => check.passed), checks, changes };
}
