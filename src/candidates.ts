import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateContract } from "./contract.js";
import { atomicWriteJson, exists, readJson } from "./io.js";
import type { PlaybookContract } from "./types.js";

export const CANDIDATE_METADATA_FILE = ".pi-playbook-candidate.json";

export interface CandidateMetadata {
  schemaVersion: 1;
  baseDigest: string;
  runId: string;
}

export interface ProjectCandidate {
  directoryName: string;
  sourcePath: string;
  contract?: PlaybookContract;
  metadata?: CandidateMetadata;
  error?: string;
}

export async function writeCandidateMetadata(sourcePath: string, metadata: Omit<CandidateMetadata, "schemaVersion">): Promise<void> {
  await atomicWriteJson(join(sourcePath, CANDIDATE_METADATA_FILE), { schemaVersion: 1, ...metadata });
}

async function readCandidateMetadata(sourcePath: string): Promise<CandidateMetadata | undefined> {
  const path = join(sourcePath, CANDIDATE_METADATA_FILE);
  if (!await exists(path)) return undefined;
  const metadata = await readJson<CandidateMetadata>(path);
  if (metadata.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(metadata.baseDigest) || !/^[a-f0-9-]{36}$/.test(metadata.runId)) {
    throw new Error(`invalid ${CANDIDATE_METADATA_FILE}`);
  }
  return metadata;
}

export function selectProjectCandidate(candidates: ProjectCandidate[], selector: string): ProjectCandidate | undefined {
  const exactDirectory = candidates.find((candidate) => candidate.directoryName === selector);
  if (exactDirectory) {
    if (!exactDirectory.contract) throw new Error(`Candidate ${selector} is invalid: ${exactDirectory.error ?? "unknown error"}`);
    return exactDirectory;
  }
  const matches = candidates.filter((candidate) => candidate.contract?.name === selector);
  if (matches.length > 1) {
    const choices = matches.map((candidate) => candidate.directoryName).join(", ");
    throw new Error(`Multiple local candidates are named ${selector}. Choose a candidate directory: ${choices}.`);
  }
  return matches[0];
}

/** Discover editable candidate workspaces without sealing or activating them. */
export async function listProjectCandidates(root: string): Promise<ProjectCandidate[]> {
  if (!await exists(root)) return [];
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));

  return Promise.all(entries.map(async (entry): Promise<ProjectCandidate> => {
    const sourcePath = join(root, entry.name);
    const contractPath = join(sourcePath, "playbook.json");
    try {
      if (!await exists(contractPath)) throw new Error("missing playbook.json");
      const info = await lstat(contractPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("playbook.json must be a regular file");
      const metadata = await readCandidateMetadata(sourcePath);
      return {
        directoryName: entry.name,
        sourcePath,
        contract: validateContract(await readJson<unknown>(contractPath)),
        ...(metadata ? { metadata } : {}),
      };
    } catch (error) {
      return {
        directoryName: entry.name,
        sourcePath,
        error: (error as Error).message,
      };
    }
  }));
}
