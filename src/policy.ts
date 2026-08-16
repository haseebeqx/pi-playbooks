import { createHash } from "node:crypto";
import { canonicalJson } from "./io.js";
import type { EnforcementLevel, PlaybookContract, ToolAttestation } from "./types.js";

export const POLICY_VERSION = "0.0.1";

export interface ToolMetadata {
  name: string;
  description: string;
  parameters: unknown;
  sourceInfo?: { source?: string };
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "require_approval";
  effectClass: string;
  enforcementLevel: EnforcementLevel;
  reason: string;
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
  if (toolName.startsWith("playbook_")) return "governance";
  return `tool:${toolName}`;
}

function isHighRisk(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === "write" || toolName === "edit") {
    const path = String(input.path ?? "");
    return /(^|[/\\])(?:\.env|\.git|\.ssh)(?:$|[/\\])|package-lock\.json$/.test(path);
  }
  if (toolName === "bash") {
    const command = String(input.command ?? "");
    return /\b(?:sudo|rm|chmod|chown|git\s+push|npm\s+publish|docker\s+(?:rm|system\s+prune)|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy)|kubectl\s+(?:apply|create|delete|patch|replace|rollout)|helm\s+(?:install|upgrade|uninstall)|aws\s+(?:cloudformation\s+(?:deploy|create|update|delete)|ecs\s+update-service|s3\s+(?:cp|mv|rm|sync)|lambda\s+(?:create|update|delete)|deploy)|gcloud\s+(?:app\s+deploy|run\s+deploy|functions\s+deploy)|serverless\s+deploy|fly\s+deploy)\b/i.test(command);
  }
  return false;
}

export function decide(contract: PlaybookContract, toolName: string, input: Record<string, unknown>): PolicyDecision {
  const effectClass = effectClassFor(toolName);
  const allowed = contract.allowedEffectClasses.includes("*") || contract.allowedEffectClasses.includes(effectClass);
  const enforcementLevel: EnforcementLevel = toolName.startsWith("playbook_") ? "guarded" : "observed";
  if (!allowed) return { decision: "deny", effectClass, enforcementLevel, reason: `${effectClass} is not declared by the playbook` };
  if (isHighRisk(toolName, input)) return { decision: "require_approval", effectClass, enforcementLevel, reason: "high-risk operation requires one-action approval" };
  return { decision: "allow", effectClass, enforcementLevel, reason: `${effectClass} is declared` };
}
