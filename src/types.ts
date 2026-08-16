export const CONTRACT_SCHEMA_VERSION = 1 as const;

export type InvocationMode = "explicit" | "auto";
export type EnforcementLevel = "observed" | "guarded" | "sandboxed" | "unmediated";
export type RunStatus = "running" | "paused" | "review" | "completed" | "failed" | "abandoned";
export type ReleaseScope = "personal" | "team";
export type RunReleaseScope = ReleaseScope | "explicit-digest" | "project-candidate";

export interface ApplicabilityContract {
  cwdGlobs?: string[];
  requiredFiles?: string[];
  forbiddenFiles?: string[];
}

export interface ArtifactDeclaration {
  name: string;
  path: string;
  stage?: string;
  required?: boolean;
}

export type SuccessPredicate =
  | { type: "artifact_exists"; path: string }
  | { type: "artifact_nonempty"; path: string };

export interface EvidencePolicy {
  retainArgumentValues?: boolean;
  promotionLevels?: EnforcementLevel[];
}

export interface PlaybookContract {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  name: string;
  version: string;
  description: string;
  invocation: InvocationMode;
  procedure?: string;
  skillDependencies?: string[];
  applicability?: ApplicabilityContract;
  requiredCapabilities: string[];
  allowedEffectClasses: string[];
  artifacts?: ArtifactDeclaration[];
  successPredicates?: SuccessPredicate[];
  evidencePolicy?: EvidencePolicy;
  runtime?: {
    minPiVersion?: string;
  };
}

export interface ArtifactFile {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  digest: string;
  sealedAt: string;
  contract: PlaybookContract;
  procedurePath: string;
  files: ArtifactFile[];
}

export interface ReleasePointer {
  digest: string;
  previousDigest?: string;
  promotedAt: string;
  source: "manual" | "trial";
}

export interface RegistryData {
  schemaVersion: 1;
  releases: Record<string, ReleasePointer>;
}

export interface ToolAttestation {
  name: string;
  fingerprint: string;
}

export interface PlaybookRun {
  schemaVersion: 1;
  runId: string;
  assignmentId: string;
  playbookName: string;
  artifactDigest: string;
  releaseScope: RunReleaseScope;
  status: RunStatus;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  branchRootEntryId?: string;
  originalPrompt: string;
  startedAt: string;
  updatedAt: string;
  currentStage?: string;
  pendingGate?: {
    id: string;
    prompt: string;
    requestedAt: string;
  };
  toolAttestations: ToolAttestation[];
  completionReview?: {
    outcome: "success" | "failure" | "abandoned";
    summary: string;
    proposedAt: string;
    predicateResults: PredicateResult[];
  };
  completion?: {
    summary: string;
    completedAt: string;
    predicateResults: PredicateResult[];
  };
}

export interface PredicateResult {
  predicate: SuccessPredicate;
  passed: boolean;
  reason: string;
}

export interface CandidateProposal {
  schemaVersion: 1;
  proposalId: string;
  name: string;
  candidateDigest: string;
  baseDigest?: string;
  evidenceRunIds: string[];
  evidenceWatermark?: string;
  fingerprint: string;
  status: "proposed" | "stale" | "rejected" | "promoted";
  rationale: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerFact {
  factId: string;
  timestamp: string;
  type: string;
  runId?: string;
  assignmentId?: string;
  sessionId?: string;
  branchEntryId?: string;
  toolCallId?: string;
  toolName?: string;
  artifactDigest?: string;
  argsHash?: string;
  enforcementLevel?: EnforcementLevel;
  policyVersion?: string;
  reason?: string;
  data?: Record<string, unknown>;
}
