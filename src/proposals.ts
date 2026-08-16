import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, atomicWriteJson, exists, readJson } from "./io.js";
import type { CandidateProposal } from "./types.js";

export interface CreateProposalInput {
  name: string;
  candidateDigest: string;
  baseDigest?: string;
  evidenceRunIds: string[];
  evidenceWatermark?: string;
  rationale: string;
}

export function assertProposalIsProposed(proposal: CandidateProposal, action: "promote" | "reject"): void {
  if (proposal.status !== "proposed") {
    throw new Error(`Proposal cannot be ${action === "promote" ? "promoted" : "rejected"}: ${proposal.status}`);
  }
}

export class ProposalStore {
  readonly root: string;

  constructor(readonly home: string) {
    this.root = join(home, "proposals");
  }

  path(proposalId: string): string {
    if (!/^[a-f0-9-]{36}$/.test(proposalId)) throw new Error("Invalid proposal ID");
    return join(this.root, `${proposalId}.json`);
  }

  async create(input: CreateProposalInput): Promise<CandidateProposal> {
    const equivalent = (await this.list()).find((proposal) =>
      proposal.status === "proposed" &&
      proposal.name === input.name &&
      proposal.candidateDigest === input.candidateDigest &&
      proposal.baseDigest === input.baseDigest,
    );
    if (equivalent) return equivalent;
    const now = new Date().toISOString();
    const proposal: CandidateProposal = {
      schemaVersion: 1,
      proposalId: randomUUID(),
      name: input.name,
      candidateDigest: input.candidateDigest,
      evidenceRunIds: [...new Set(input.evidenceRunIds)],
      fingerprint: createHash("sha256").update(canonicalJson({ name: input.name, candidateDigest: input.candidateDigest, baseDigest: input.baseDigest ?? null })).digest("hex"),
      status: "proposed",
      rationale: input.rationale,
      createdAt: now,
      updatedAt: now,
    };
    if (input.baseDigest) proposal.baseDigest = input.baseDigest;
    if (input.evidenceWatermark) proposal.evidenceWatermark = input.evidenceWatermark;
    await atomicWriteJson(this.path(proposal.proposalId), proposal);
    return proposal;
  }

  async read(proposalId: string): Promise<CandidateProposal> {
    const proposal = await readJson<CandidateProposal>(this.path(proposalId));
    if (proposal.schemaVersion !== 1 || proposal.proposalId !== proposalId) throw new Error("Invalid proposal record");
    return proposal;
  }

  async save(proposal: CandidateProposal): Promise<void> {
    proposal.updatedAt = new Date().toISOString();
    await atomicWriteJson(this.path(proposal.proposalId), proposal);
  }

  async list(): Promise<CandidateProposal[]> {
    if (!await exists(this.root)) return [];
    const files = (await readdir(this.root)).filter((file) => file.endsWith(".json"));
    return Promise.all(files.map((file) => readJson<CandidateProposal>(join(this.root, file))));
  }
}
