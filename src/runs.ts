import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, exists, readJson, resolveExistingInside } from "./io.js";
import type { PlaybookContract, PlaybookRun, PredicateResult, RunReleaseScope, ToolAttestation } from "./types.js";

export interface StartRunInput {
  playbookName: string;
  artifactDigest: string;
  releaseScope: RunReleaseScope;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  branchRootEntryId?: string;
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

  async create(input: StartRunInput): Promise<PlaybookRun> {
    const now = new Date().toISOString();
    const run: PlaybookRun = {
      schemaVersion: 1,
      runId: randomUUID(),
      assignmentId: randomUUID(),
      playbookName: input.playbookName,
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
    if (input.branchRootEntryId) run.branchRootEntryId = input.branchRootEntryId;
    await atomicWriteJson(this.path(run.runId), run);
    return run;
  }

  async read(runId: string): Promise<PlaybookRun> {
    const run = await readJson<PlaybookRun>(this.path(runId));
    if (run.schemaVersion !== 1 || run.runId !== runId) throw new Error(`Invalid run record: ${runId}`);
    return run;
  }

  async save(run: PlaybookRun): Promise<void> {
    run.updatedAt = new Date().toISOString();
    await atomicWriteJson(this.path(run.runId), run);
  }

  async list(): Promise<PlaybookRun[]> {
    if (!await exists(this.root)) return [];
    const files = (await readdir(this.root)).filter((name) => name.endsWith(".json"));
    return Promise.all(files.map((name) => readJson<PlaybookRun>(join(this.root, name))));
  }

  async activeForSession(sessionId: string): Promise<PlaybookRun[]> {
    return (await this.list()).filter((run) => run.sessionId === sessionId && (run.status === "running" || run.status === "paused" || run.status === "review"));
  }

  async attach(run: PlaybookRun, sessionId: string, sessionFile?: string): Promise<void> {
    run.sessionId = sessionId;
    if (sessionFile) run.sessionFile = sessionFile;
    else delete run.sessionFile;
    await this.save(run);
  }
}

export async function evaluatePredicates(contract: PlaybookContract, cwd: string): Promise<PredicateResult[]> {
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
