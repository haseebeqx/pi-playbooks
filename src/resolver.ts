import type { ArtifactStore } from "./artifacts.js";
import { isApplicable } from "./contract.js";
import type { ReleaseRegistry } from "./registry.js";
import type { RunbookContract, ReleaseScope, RunReleaseScope } from "./types.js";

export interface ResolvedRelease {
  name: string;
  digest: string;
  scope: RunReleaseScope;
  contract: RunbookContract;
}

export async function resolveNamed(
  name: string,
  artifacts: ArtifactStore,
  personal: ReleaseRegistry,
  team?: ReleaseRegistry,
): Promise<ResolvedRelease | undefined> {
  const personalPointer = await personal.resolve(name);
  if (personalPointer) return { name, digest: personalPointer.digest, scope: "personal", contract: await artifacts.contract(personalPointer.digest) };
  const teamPointer = await team?.resolve(name);
  if (teamPointer) return { name, digest: teamPointer.digest, scope: "team", contract: await artifacts.contract(teamPointer.digest) };
  return undefined;
}

async function applicableAtScope(
  scope: ReleaseScope,
  releases: Record<string, { digest: string }>,
  cwd: string,
  artifacts: ArtifactStore,
): Promise<ResolvedRelease[]> {
  const matches: ResolvedRelease[] = [];
  for (const [name, pointer] of Object.entries(releases)) {
    const contract = await artifacts.contract(pointer.digest);
    if (contract.invocation === "auto" && (await isApplicable(contract, cwd)).matches) {
      matches.push({ name, digest: pointer.digest, scope, contract });
    }
  }
  return matches;
}

function selectAtPriority(candidates: ResolvedRelease[]): { match?: ResolvedRelease; conflicts: ResolvedRelease[] } {
  const only = candidates[0];
  if (candidates.length === 1 && only) return { match: only, conflicts: [] };
  return { conflicts: candidates };
}

export async function resolveAutomatic(
  cwd: string,
  artifacts: ArtifactStore,
  personal: ReleaseRegistry,
  team?: ReleaseRegistry,
): Promise<{ match?: ResolvedRelease; conflicts: ResolvedRelease[] }> {
  const personalMatches = await applicableAtScope("personal", (await personal.read()).releases, cwd, artifacts);
  if (personalMatches.length > 0) return selectAtPriority(personalMatches);
  const teamMatches = await applicableAtScope("team", (await team?.read())?.releases ?? {}, cwd, artifacts);
  return selectAtPriority(teamMatches);
}
