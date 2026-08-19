import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseFrontmatter, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { validateContract } from "./contract.js";
import { exists, resolveInside } from "./io.js";
import type { ArtifactManifest, RunbookContract } from "./types.js";
import type { ArtifactStore } from "./artifacts.js";

const OMIT_NAMES = new Set([".git", ".DS_Store"]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface SkillFrontmatter extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
}

async function assertNewDirectory(destination: string): Promise<void> {
  if (await exists(destination)) throw new Error(`Destination already exists: ${destination}`);
}

async function copyDirectory(
  source: string,
  destination: string,
  omitRootFiles: ReadonlySet<string> = new Set(),
): Promise<void> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error("Source must be a regular directory");
  const nested = relative(source, destination);
  if (nested === "" || (!nested.startsWith("..") && !nested.includes(":"))) {
    throw new Error("Destination must not be inside the source directory");
  }

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (OMIT_NAMES.has(entry.name)) continue;
      const sourcePath = join(directory, entry.name);
      const relativePath = relative(source, sourcePath);
      if (!relativePath.includes("/") && !relativePath.includes("\\") && omitRootFiles.has(entry.name)) continue;
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) throw new Error(`Skill conversion does not allow symlinks: ${relativePath}`);
      const target = resolveInside(destination, relativePath);
      if (info.isDirectory()) {
        await mkdir(target, { recursive: true });
        await visit(sourcePath);
      } else if (info.isFile()) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(sourcePath, target);
        await chmod(target, info.mode & 0o777);
      } else {
        throw new Error(`Unsupported skill entry: ${relativePath}`);
      }
    }
  };

  await mkdir(destination, { recursive: true });
  await visit(source);
}

function readSkillIdentity(content: string): { name: string; description: string } {
  const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== "string" || !SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error("Pi skill frontmatter name must be 1-64 lowercase letters, numbers, and single hyphens");
  }
  if (typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw new Error("Pi skill frontmatter description must be a non-empty string of at most 1024 characters");
  }
  return { name, description: description.trim() };
}

/** Convert a loaded Pi Agent Skill file or skill directory into an editable runbook source directory. */
export async function skillToRunbook(sourcePath: string, destinationDirectory: string): Promise<RunbookContract> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationDirectory);
  await assertNewDirectory(destination);
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) {
    throw new Error("Pi skill source must be a regular file or directory");
  }
  const skillPath = sourceInfo.isDirectory() ? join(source, "SKILL.md") : source;
  if (!await exists(skillPath)) throw new Error("Pi skill directory is missing SKILL.md");
  const skillInfo = await lstat(skillPath);
  if (!skillInfo.isFile() || skillInfo.isSymbolicLink()) throw new Error("SKILL.md must be a regular file");
  const skillContent = await readFile(skillPath, "utf8");
  const identity = readSkillIdentity(skillContent);
  const contract = validateContract({
    schemaVersion: 1,
    name: identity.name,
    version: "0.1.0",
    description: identity.description,
    invocation: "explicit",
    procedure: "SKILL.md",
    requiredCapabilities: ["runbook_checkpoint", "runbook_finish"],
    allowedEffectClasses: ["*"],
    evidencePolicy: { retainArgumentValues: false, promotionLevels: ["guarded", "sandboxed"] },
  });

  try {
    if (sourceInfo.isDirectory()) {
      await copyDirectory(source, destination, new Set(["runbook.json"]));
    } else {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), skillContent, "utf8");
    }
    await writeFile(join(destination, "runbook.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    return contract;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Export a sealed runbook as a standalone Pi Agent Skill directory. */
export async function runbookToSkill(
  artifacts: ArtifactStore,
  digest: string,
  destinationDirectory: string,
): Promise<ArtifactManifest> {
  const destination = resolve(destinationDirectory);
  await assertNewDirectory(destination);
  const manifest = await artifacts.manifest(digest);
  const { name, description } = manifest.contract;
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) throw new Error("Runbook name is not a valid Pi skill name");
  if (description.length > 1024) throw new Error("Runbook description exceeds the Pi skill limit of 1024 characters");
  const procedure = await artifacts.procedure(digest);
  const contentRoot = artifacts.contentRoot(digest);

  try {
    await mkdir(destination, { recursive: true });
    for (const file of manifest.files) {
      if (file.path === "runbook.json" || file.path === manifest.procedurePath || file.path === "SKILL.md") continue;
      const target = resolveInside(destination, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolveInside(contentRoot, file.path), target);
      await chmod(target, file.executable ? 0o755 : 0o644);
    }
    const skill = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${stripFrontmatter(procedure).trimStart()}`;
    await writeFile(join(destination, "SKILL.md"), skill.endsWith("\n") ? skill : `${skill}\n`, "utf8");
    return manifest;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
