import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { validateContract } from "./contract.js";
import { atomicWriteJson, canonicalJson, exists, readJson, replaceDirectory, resolveInside } from "./io.js";
import type { ArtifactFile, ArtifactManifest, RunbookContract } from "./types.js";
import { CANDIDATE_METADATA_FILE } from "./candidates.js";

const OMIT_NAMES = new Set([".git", ".DS_Store", CANDIDATE_METADATA_FILE]);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listFiles(root: string): Promise<ArtifactFile[]> {
  const output: ArtifactFile[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (OMIT_NAMES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Symlinks cannot be sealed: ${path}`);
      if (info.isDirectory()) {
        await visit(absolute);
      } else if (info.isFile()) {
        const bytes = await readFile(absolute);
        output.push({ path, sha256: sha256(bytes), size: bytes.byteLength, executable: (info.mode & 0o111) !== 0 });
      } else {
        throw new Error(`Unsupported artifact entry: ${path}`);
      }
    }
  }
  await visit(root);
  return output;
}

function digestFiles(files: ArtifactFile[]): string {
  return sha256(canonicalJson(files));
}

async function copyContent(source: string, destination: string, files: ArtifactFile[]): Promise<void> {
  for (const file of files) {
    const sourcePath = resolveInside(source, file.path);
    const destinationPath = resolveInside(destination, file.path);
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
    await chmod(destinationPath, file.executable ? 0o555 : 0o444);
  }
}

async function resolveProcedurePath(source: string, contract: RunbookContract): Promise<string> {
  const candidates = contract.procedure ? [contract.procedure] : ["RUNBOOK.md", "SKILL.md"];
  for (const candidate of candidates) {
    const path = resolveInside(source, candidate);
    if (!await exists(path)) continue;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Runbook procedure must be a regular file: ${candidate}`);
    return candidate;
  }
  throw new Error(contract.procedure
    ? `Declared procedure is missing: ${contract.procedure}`
    : "Runbook source needs RUNBOOK.md or SKILL.md");
}

async function validateSkillDependencies(source: string, contract: RunbookContract): Promise<void> {
  for (const dependency of contract.skillDependencies ?? []) {
    const root = resolveInside(source, dependency);
    if (!await exists(root) || !(await lstat(root)).isDirectory()) {
      throw new Error(`Skill dependency must be a directory: ${dependency}`);
    }
    const skill = resolveInside(root, "SKILL.md");
    if (!await exists(skill) || !(await lstat(skill)).isFile()) {
      throw new Error(`Skill dependency is missing SKILL.md: ${dependency}`);
    }
  }
}

export class ArtifactStore {
  readonly artifactsRoot: string;

  constructor(readonly home: string) {
    this.artifactsRoot = join(home, "artifacts");
  }

  artifactRoot(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid artifact digest");
    return join(this.artifactsRoot, digest);
  }

  contentRoot(digest: string): string {
    return join(this.artifactRoot(digest), "content");
  }

  async seal(sourceDirectory: string): Promise<ArtifactManifest> {
    const source = resolve(sourceDirectory);
    if (!(await stat(source)).isDirectory()) throw new Error("Runbook source must be a directory");
    const contractPath = join(source, "runbook.json");
    if (!await exists(contractPath)) throw new Error("Runbook source is missing runbook.json");
    const contract = validateContract(await readJson<unknown>(contractPath));
    const procedurePath = await resolveProcedurePath(source, contract);
    await validateSkillDependencies(source, contract);
    const files = await listFiles(source);
    const digest = digestFiles(files);
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      digest,
      sealedAt: new Date().toISOString(),
      contract,
      procedurePath,
      files,
    };
    const destination = this.artifactRoot(digest);
    if (await exists(destination)) {
      await this.verify(digest);
      return await this.manifest(digest);
    }

    await mkdir(this.artifactsRoot, { recursive: true });
    const temporary = join(this.artifactsRoot, `.seal-${basename(source)}-${randomUUID()}`);
    await mkdir(join(temporary, "content"), { recursive: true });
    await copyContent(source, join(temporary, "content"), files);
    await atomicWriteJson(join(temporary, "manifest.json"), manifest);
    await replaceDirectory(temporary, destination);
    await this.verify(digest);
    return manifest;
  }

  async manifest(digest: string): Promise<ArtifactManifest> {
    await this.verify(digest);
    const value = await readJson<ArtifactManifest>(join(this.artifactRoot(digest), "manifest.json"));
    if (value.digest !== digest) throw new Error("Manifest digest does not match artifact location");
    value.contract = validateContract(value.contract);
    if (!value.procedurePath) {
      const fallback = [value.contract.procedure, "RUNBOOK.md", "SKILL.md"]
        .filter((path): path is string => Boolean(path))
        .find((path) => value.files.some((file) => file.path === path));
      if (fallback) value.procedurePath = fallback;
    }
    if (!value.procedurePath || !value.files.some((file) => file.path === value.procedurePath)) {
      throw new Error("Artifact manifest has no valid procedure path");
    }
    return value;
  }

  async contract(digest: string): Promise<RunbookContract> {
    return (await this.manifest(digest)).contract;
  }

  async procedure(digest: string): Promise<string> {
    await this.verify(digest);
    const manifest = await this.manifest(digest);
    return readFile(resolveInside(this.contentRoot(digest), manifest.procedurePath), "utf8");
  }

  async materializeForRevision(digest: string, destinationDirectory: string): Promise<void> {
    await this.verify(digest);
    const destination = resolve(destinationDirectory);
    if (await exists(destination)) throw new Error(`Revision directory already exists: ${destination}`);
    const manifest = await this.manifest(digest);
    await mkdir(destination, { recursive: true });
    for (const file of manifest.files) {
      const target = resolveInside(destination, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolveInside(this.contentRoot(digest), file.path), target);
      await chmod(target, file.executable ? 0o755 : 0o644);
    }
  }

  async verify(digest: string): Promise<void> {
    const manifest = await this.manifestUnchecked(digest);
    const content = this.contentRoot(digest);
    const actual = await listFiles(content);
    const actualDigest = digestFiles(actual);
    if (actualDigest !== digest || canonicalJson(actual) !== canonicalJson(manifest.files)) {
      throw new Error(`Artifact integrity check failed for ${digest}`);
    }

    const contentContract = validateContract(await readJson<unknown>(join(content, "runbook.json")));
    const manifestContract = validateContract(manifest.contract);
    const procedurePath = await resolveProcedurePath(content, contentContract);
    await validateSkillDependencies(content, contentContract);
    if (canonicalJson(contentContract) !== canonicalJson(manifestContract) || manifest.procedurePath !== procedurePath) {
      throw new Error(`Artifact manifest does not match sealed content for ${digest}`);
    }
  }

  private async manifestUnchecked(digest: string): Promise<ArtifactManifest> {
    const manifest = await readJson<ArtifactManifest>(join(this.artifactRoot(digest), "manifest.json"));
    if (manifest.schemaVersion !== 1 || manifest.digest !== digest) throw new Error("Invalid artifact manifest");
    return manifest;
  }
}

export { digestFiles, listFiles, sha256 };
