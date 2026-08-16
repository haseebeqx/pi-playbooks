import { join } from "node:path";
import { atomicWriteJson, exists, readJson } from "./io.js";
import type { RegistryData, ReleasePointer } from "./types.js";

const EMPTY_REGISTRY: RegistryData = { schemaVersion: 1, releases: {} };

export class ReleaseRegistry {
  constructor(readonly path: string, readonly writable = true) {}

  async read(): Promise<RegistryData> {
    if (!await exists(this.path)) return structuredClone(EMPTY_REGISTRY);
    const registry = await readJson<RegistryData>(this.path);
    if (registry.schemaVersion !== 1 || !registry.releases || typeof registry.releases !== "object") {
      throw new Error(`Invalid release registry: ${this.path}`);
    }
    return registry;
  }

  async resolve(name: string): Promise<ReleasePointer | undefined> {
    return (await this.read()).releases[name];
  }

  async promote(name: string, digest: string): Promise<ReleasePointer> {
    if (!this.writable) throw new Error("Registry is read-only");
    const registry = await this.read();
    const current = registry.releases[name];
    const pointer: ReleasePointer = {
      digest,
      promotedAt: new Date().toISOString(),
      source: "manual",
    };
    if (current && current.digest !== digest) pointer.previousDigest = current.digest;
    registry.releases[name] = pointer;
    await atomicWriteJson(this.path, registry);
    return pointer;
  }

  async rollback(name: string): Promise<ReleasePointer> {
    if (!this.writable) throw new Error("Registry is read-only");
    const registry = await this.read();
    const current = registry.releases[name];
    if (!current?.previousDigest) throw new Error(`No previous release recorded for ${name}`);
    const pointer: ReleasePointer = {
      digest: current.previousDigest,
      previousDigest: current.digest,
      promotedAt: new Date().toISOString(),
      source: "manual",
    };
    registry.releases[name] = pointer;
    await atomicWriteJson(this.path, registry);
    return pointer;
  }
}

export function personalRegistryPath(home: string): string {
  return join(home, "registry.json");
}
