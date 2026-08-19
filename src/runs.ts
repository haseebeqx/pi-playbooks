import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, exists, readJson, resolveExistingInside } from "./io.js";
import type { RunbookContract, RunbookRun, PredicateResult, RunReleaseScope, ToolAttestation } from "./types.js";

export interface StartRunInput {
  runbookName: string;
  artifactDigest: string;
  releaseScope: RunReleaseScope;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  originalPrompt: string;
  toolAttestations: ToolAttestation[];
}

export class RunStore {
  readonly root: string;

  constructor(readonly home: string) {
    this.root = join(home, "runs");
  }

  path(runId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid run ID");
    return join(this.root, `${runId}.json`);
  }

  async create(input: StartRunInput): Promise<RunbookRun> {
    const now = new Date().toISOString();
    const run: RunbookRun = {
      schemaVersion: 1,
      runId: randomUUID(),
      assignmentId: randomUUID(),
      runbookName: input.runbookName,
      artifactDigest: input.artifactDigest,
      releaseScope: input.releaseScope,
      status: "running",
      cwd: input.cwd,
      sessionId: input.sessionId,
      originalPrompt: input.originalPrompt,
      startedAt: now,
      updatedAt: now,
      toolAttestations: input.toolAttestations,
    };
    if (input.sessionFile) run.sessionFile = input.sessionFile;
    await atomicWriteJson(this.path(run.runId), run);
    return run;
  }

  async read(runId: string): Promise<RunbookRun> {
    const run = await readJson<RunbookRun>(this.path(runId));
    if (run.schemaVersion !== 1 || run.runId !== runId) throw new Error(`Invalid run record: ${runId}`);
    return run;
  }

  async save(run: RunbookRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await atomicWriteJson(this.path(run.runId), run);
  }

  async list(): Promise<RunbookRun[]> {
    if (!await exists(this.root)) return [];
    const files = (await readdir(this.root)).filter((name) => name.endsWith(".json"));
    return Promise.all(files.map((name) => readJson<RunbookRun>(join(this.root, name))));
  }

  async activeForAssignments(runIds: readonly string[], sessionId: string): Promise<RunbookRun | undefined> {
    const runId = runIds.at(-1);
    if (!runId) return undefined;
    let run: RunbookRun;
    try {
      run = await this.read(runId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message === "Invalid run ID") return undefined;
      throw error;
    }
    if (run.sessionId !== sessionId) return undefined;
    return run.status === "running" || run.status === "paused" || run.status === "review" ? run : undefined;
  }

}

export async function evaluatePredicates(contract: RunbookContract, cwd: string): Promise<PredicateResult[]> {
  const results: PredicateResult[] = [];
  for (const predicate of contract.successPredicates ?? []) {
    try {
      const path = await resolveExistingInside(cwd, predicate.path);
      const info = await stat(path);
      if (predicate.type === "artifact_exists") {
        results.push({ predicate, passed: true, reason: `${predicate.path} exists` });
      } else {
        const nonempty = info.isFile() ? info.size > 0 : (await readdir(path)).length > 0;
        results.push({ predicate, passed: nonempty, reason: nonempty ? `${predicate.path} is non-empty` : `${predicate.path} is empty` });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        results.push({ predicate, passed: false, reason: `${predicate.path} does not exist` });
      } else if ((error as Error).message.startsWith("Path ")) {
        results.push({ predicate, passed: false, reason: (error as Error).message });
      } else {
        throw error;
      }
    }
  }
  return results;
}

export async function hashRunArtifact(cwd: string, path: string): Promise<{ path: string; sha256: string; size: number }> {
  const absolute = await resolveExistingInside(cwd, path);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error(`Checkpoint artifact is not a file: ${path}`);
  const bytes = await readFile(absolute);
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}
