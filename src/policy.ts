import { createHash } from "node:crypto";
import { canonicalJson } from "./io.js";
import type { EnforcementLevel, RunbookContract, ToolAttestation } from "./types.js";

export const POLICY_VERSION = "0.0.2";

export interface ToolMetadata {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo?: { source?: string };
}

export interface ApprovalDetails {
  purpose: string[];
  risks: string[];
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "require_approval";
  effectClass: string;
  enforcementLevel: EnforcementLevel;
  reason: string;
  approvalDetails?: ApprovalDetails;
}

export function hashArguments(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function fingerprintTool(tool: ToolMetadata): string {
  return createHash("sha256").update(canonicalJson({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    source: tool.sourceInfo?.source ?? "unknown",
  })).digest("hex");
}

export function attestTools(required: string[], tools: ToolMetadata[]): ToolAttestation[] {
  return required.map((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Required tool is unavailable: ${name}`);
    return { name, fingerprint: fingerprintTool(tool) };
  });
}

export function verifyToolAttestations(attestations: ToolAttestation[], tools: ToolMetadata[]): string | undefined {
  for (const attestation of attestations) {
    const current = tools.find((tool) => tool.name === attestation.name);
    if (!current) return `required tool disappeared: ${attestation.name}`;
    if (fingerprintTool(current) !== attestation.fingerprint) return `required tool changed: ${attestation.name}`;
  }
  return undefined;
}

export function effectClassFor(toolName: string): string {
  if (["read", "grep", "find", "ls"].includes(toolName)) return "filesystem.read";
  if (["write", "edit"].includes(toolName)) return "filesystem.write";
  if (toolName === "bash") return "process.exec";
  if (toolName.startsWith("runbook_")) return "governance";
  return `tool:${toolName}`;
}

interface HighRiskMatch {
  label: string;
  pattern: RegExp;
  purpose: string;
  risk: string;
}

const HIGH_RISK_COMMANDS: HighRiskMatch[] = [
  { label: "privilege elevation (sudo)", pattern: /\bsudo\b/i, purpose: "Run part of the command with elevated operating-system privileges.", risk: "Elevated privileges can modify system-wide files, services, permissions, or other users' data." },
  { label: "file deletion (rm)", pattern: /\brm\b/i, purpose: "Delete the files or directories named by the command.", risk: "Deleted data may be difficult or impossible to recover, especially with recursive or forced deletion." },
  { label: "permission change (chmod)", pattern: /\bchmod\b/i, purpose: "Change filesystem permission bits.", risk: "Incorrect permissions can expose sensitive data, make files executable, or break applications." },
  { label: "ownership change (chown)", pattern: /\bchown\b/i, purpose: "Change filesystem ownership.", risk: "Incorrect ownership can grant unintended access or prevent services and users from accessing files." },
  { label: "Git publication (git push)", pattern: /\bgit\s+push\b/i, purpose: "Publish local Git refs and commits to a remote repository.", risk: "This changes shared remote history and may expose commits or trigger CI, releases, and deployments." },
  { label: "package publication (npm publish)", pattern: /\bnpm\s+publish\b/i, purpose: "Publish a package version to an npm registry.", risk: "Publication is externally visible, may expose packaged files, and a released version generally cannot be reused." },
  { label: "Docker resource removal", pattern: /\bdocker\s+(?:rm|system\s+prune)\b/i, purpose: "Remove Docker containers or prune Docker-managed resources.", risk: "Containers, images, networks, caches, or attached data may be removed and active workloads may stop." },
  { label: "Terraform infrastructure change", pattern: /\bterraform\s+(?:apply|destroy)\b/i, purpose: "Apply Terraform changes to managed infrastructure.", risk: "Infrastructure may be created, replaced, or destroyed, causing downtime, data loss, or cost changes." },
  { label: "Pulumi infrastructure change", pattern: /\bpulumi\s+(?:up|destroy)\b/i, purpose: "Apply Pulumi changes to managed infrastructure.", risk: "Infrastructure may be created, replaced, or destroyed, causing downtime, data loss, or cost changes." },
  { label: "Kubernetes cluster change", pattern: /\bkubectl\s+(?:apply|create|delete|patch|replace|rollout)\b/i, purpose: "Change resources or workloads in a Kubernetes cluster.", risk: "The selected cluster may experience configuration changes, workload restarts, downtime, or data loss." },
  { label: "Helm release change", pattern: /\bhelm\s+(?:install|upgrade|uninstall)\b/i, purpose: "Install, upgrade, or remove a Helm release in a Kubernetes cluster.", risk: "Cluster workloads and configuration may change or stop, potentially causing downtime or data loss." },
  { label: "AWS remote change", pattern: /\baws\s+(?:cloudformation\s+(?:deploy|create|update|delete)|ecs\s+update-service|s3\s+(?:cp|mv|rm|sync)|lambda\s+(?:create|update|delete)|deploy)\b/i, purpose: "Change data, services, or infrastructure in the selected AWS account and region.", risk: "Remote resources or data may be overwritten or deleted, services may restart, and cloud charges may change." },
  { label: "Google Cloud deployment", pattern: /\bgcloud\s+(?:app\s+deploy|run\s+deploy|functions\s+deploy)\b/i, purpose: "Deploy an application or function to the selected Google Cloud project.", risk: "The deployment changes a remote service and may expose code, replace a live version, cause downtime, or incur charges." },
  { label: "Serverless deployment", pattern: /\bserverless\s+deploy\b/i, purpose: "Deploy the Serverless application to its configured cloud account and stage.", risk: "Remote infrastructure and code will change and may become externally accessible or incur charges." },
  { label: "Fly.io deployment", pattern: /\bfly\s+deploy\b/i, purpose: "Deploy the application to its configured Fly.io target.", risk: "A live remote service will change and may restart, become externally accessible, or incur charges." },
];

function highRiskDetails(toolName: string, input: Record<string, unknown>): { reason: string; details: ApprovalDetails } | undefined {
  if (toolName === "write" || toolName === "edit") {
    const path = String(input.path ?? "");
    if (/(^|[/\\])(?:\.env|\.git|\.ssh)(?:$|[/\\])|package-lock\.json$/.test(path)) {
      return {
        reason: `writing protected path ${path}`,
        details: {
          purpose: [`Modify the protected file or directory at ${path}.`],
          risks: ["Protected paths may contain credentials, repository metadata, security configuration, or dependency integrity data; an incorrect change can expose secrets or break the project."],
        },
      };
    }
  }
  if (toolName === "bash") {
    const command = String(input.command ?? "");
    const matches = HIGH_RISK_COMMANDS.filter(({ pattern }) => pattern.test(command));
    if (matches.length > 0) {
      return {
        reason: `detected ${matches.map(({ label }) => label).join(", ")}`,
        details: {
          purpose: [...new Set(matches.map(({ purpose }) => purpose))],
          risks: [...new Set(matches.map(({ risk }) => risk))],
        },
      };
    }
  }
  return undefined;
}

export function decide(contract: RunbookContract, toolName: string, input: Record<string, unknown>): PolicyDecision {
  const effectClass = effectClassFor(toolName);
  const allowed = contract.allowedEffectClasses.includes("*") || contract.allowedEffectClasses.includes(effectClass);
  const enforcementLevel: EnforcementLevel = toolName.startsWith("runbook_") ? "guarded" : "observed";
  if (!allowed) return { decision: "deny", effectClass, enforcementLevel, reason: `${effectClass} is not declared by the runbook` };
  const highRisk = highRiskDetails(toolName, input);
  if (highRisk) return { decision: "require_approval", effectClass, enforcementLevel, reason: highRisk.reason, approvalDetails: highRisk.details };
  return { decision: "allow", effectClass, enforcementLevel, reason: `${effectClass} is declared` };
}
