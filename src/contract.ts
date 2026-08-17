import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApplicabilityContract, RunbookContract } from "./types.js";
import { CONTRACT_SCHEMA_VERSION } from "./types.js";
import { exists, resolveInside } from "./io.js";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EFFECT_PATTERN = /^(?:\*|filesystem\.(?:read|write)|process\.exec|network|governance|tool:[a-zA-Z0-9_-]+)$/;

function strings(value: unknown, label: string, required = true): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (value.startsWith("/") || value.split(/[\\/]/).includes("..")) throw new Error(`${label} must stay inside the run directory`);
  return value;
}

export function validateContract(value: unknown): RunbookContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runbook.json must contain an object");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== CONTRACT_SCHEMA_VERSION) throw new Error(`schemaVersion must be ${CONTRACT_SCHEMA_VERSION}`);
  if (typeof input.name !== "string" || !NAME_PATTERN.test(input.name)) throw new Error("name must use lowercase letters, numbers, and single hyphens");
  if (typeof input.version !== "string" || !input.version.trim()) throw new Error("version is required");
  if (typeof input.description !== "string" || !input.description.trim()) throw new Error("description is required");
  if (input.invocation !== "explicit" && input.invocation !== "auto") throw new Error("invocation must be explicit or auto");

  const requiredCapabilities = strings(input.requiredCapabilities, "requiredCapabilities");
  const allowedEffectClasses = strings(input.allowedEffectClasses, "allowedEffectClasses");
  const procedure = input.procedure === undefined ? undefined : safeRelativePath(input.procedure, "procedure");
  const skillDependencies = input.skillDependencies === undefined
    ? undefined
    : strings(input.skillDependencies, "skillDependencies").map((path) => safeRelativePath(path, "skillDependencies entry"));
  for (const effect of allowedEffectClasses) {
    if (!EFFECT_PATTERN.test(effect)) throw new Error(`Unsupported effect class: ${effect}`);
  }

  let applicability: ApplicabilityContract | undefined;
  if (input.applicability !== undefined) {
    if (!input.applicability || typeof input.applicability !== "object" || Array.isArray(input.applicability)) {
      throw new Error("applicability must be an object");
    }
    const raw = input.applicability as Record<string, unknown>;
    applicability = {};
    if (raw.cwdGlobs !== undefined) applicability.cwdGlobs = strings(raw.cwdGlobs, "applicability.cwdGlobs");
    if (raw.requiredFiles !== undefined) applicability.requiredFiles = strings(raw.requiredFiles, "applicability.requiredFiles").map((path) => safeRelativePath(path, "requiredFiles entry"));
    if (raw.forbiddenFiles !== undefined) applicability.forbiddenFiles = strings(raw.forbiddenFiles, "applicability.forbiddenFiles").map((path) => safeRelativePath(path, "forbiddenFiles entry"));
  }

  const artifacts = input.artifacts === undefined ? undefined : (() => {
    if (!Array.isArray(input.artifacts)) throw new Error("artifacts must be an array");
    return input.artifacts.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`artifacts[${index}] must be an object`);
      const item = raw as Record<string, unknown>;
      if (typeof item.name !== "string" || !item.name.trim()) throw new Error(`artifacts[${index}].name is required`);
      const result: NonNullable<RunbookContract["artifacts"]>[number] = {
        name: item.name,
        path: safeRelativePath(item.path, `artifacts[${index}].path`),
      };
      if (item.stage !== undefined) {
        if (typeof item.stage !== "string" || !item.stage.trim()) throw new Error(`artifacts[${index}].stage must be a string`);
        result.stage = item.stage;
      }
      if (item.required !== undefined) {
        if (typeof item.required !== "boolean") throw new Error(`artifacts[${index}].required must be boolean`);
        result.required = item.required;
      }
      return result;
    });
  })();

  const successPredicates: RunbookContract["successPredicates"] = input.successPredicates === undefined ? undefined : (() => {
    if (!Array.isArray(input.successPredicates)) throw new Error("successPredicates must be an array");
    return input.successPredicates.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`successPredicates[${index}] must be an object`);
      const item = raw as Record<string, unknown>;
      if (item.type !== "artifact_exists" && item.type !== "artifact_nonempty") throw new Error(`Unsupported success predicate at index ${index}`);
      return { type: item.type, path: safeRelativePath(item.path, `successPredicates[${index}].path`) };
    });
  })();

  let evidencePolicy: RunbookContract["evidencePolicy"];
  if (input.evidencePolicy !== undefined) {
    if (!input.evidencePolicy || typeof input.evidencePolicy !== "object" || Array.isArray(input.evidencePolicy)) throw new Error("evidencePolicy must be an object");
    const raw = input.evidencePolicy as Record<string, unknown>;
    evidencePolicy = {};
    if (raw.retainArgumentValues !== undefined) {
      if (typeof raw.retainArgumentValues !== "boolean") throw new Error("evidencePolicy.retainArgumentValues must be boolean");
      evidencePolicy.retainArgumentValues = raw.retainArgumentValues;
    }
    if (raw.promotionLevels !== undefined) {
      const levels = strings(raw.promotionLevels, "evidencePolicy.promotionLevels");
      const allowed = new Set(["observed", "guarded", "sandboxed", "unmediated"]);
      if (levels.some((level) => !allowed.has(level))) throw new Error("evidencePolicy.promotionLevels contains an unsupported level");
      evidencePolicy.promotionLevels = levels as Array<"observed" | "guarded" | "sandboxed" | "unmediated">;
    }
  }

  let runtime: RunbookContract["runtime"];
  if (input.runtime !== undefined) {
    if (!input.runtime || typeof input.runtime !== "object" || Array.isArray(input.runtime)) throw new Error("runtime must be an object");
    const raw = input.runtime as Record<string, unknown>;
    runtime = {};
    if (raw.minPiVersion !== undefined) {
      if (typeof raw.minPiVersion !== "string" || !raw.minPiVersion.trim()) throw new Error("runtime.minPiVersion must be a string");
      runtime.minPiVersion = raw.minPiVersion;
    }
  }

  const result: RunbookContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    name: input.name,
    version: input.version,
    description: input.description,
    invocation: input.invocation,
    requiredCapabilities,
    allowedEffectClasses,
  };
  if (procedure) result.procedure = procedure;
  if (skillDependencies) result.skillDependencies = skillDependencies;
  if (applicability) result.applicability = applicability;
  if (artifacts) result.artifacts = artifacts;
  if (successPredicates) result.successPredicates = successPredicates;
  if (evidencePolicy) result.evidencePolicy = evidencePolicy;
  if (runtime) result.runtime = runtime;
  return result;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export async function isApplicable(contract: RunbookContract, cwd: string): Promise<{ matches: boolean; reason: string }> {
  const applicability = contract.applicability;
  if (!applicability) return { matches: true, reason: "no applicability restrictions" };
  const normalized = resolve(cwd).replaceAll("\\", "/");
  if (applicability.cwdGlobs?.length && !applicability.cwdGlobs.some((glob) => globToRegExp(glob).test(normalized))) {
    return { matches: false, reason: "cwd did not match" };
  }
  for (const path of applicability.requiredFiles ?? []) {
    if (!await exists(resolveInside(cwd, path))) return { matches: false, reason: `required file missing: ${path}` };
  }
  for (const path of applicability.forbiddenFiles ?? []) {
    if (await exists(resolveInside(cwd, path))) return { matches: false, reason: `forbidden file present: ${path}` };
  }
  return { matches: true, reason: "applicability contract matched" };
}

export async function assertRegularFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}
