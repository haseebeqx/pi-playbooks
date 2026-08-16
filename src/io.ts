import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function resolveInside(root: string, requested: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, requested);
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes allowed root: ${requested}`);
  }
  return target;
}

export async function resolveExistingInside(root: string, requested: string): Promise<string> {
  const lexicalTarget = resolveInside(root, requested);
  const targetInfo = await lstat(lexicalTarget);
  if (targetInfo.isSymbolicLink()) throw new Error(`Path must not be a symbolic link: ${requested}`);

  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexicalTarget)]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`Path resolves outside allowed root: ${requested}`);
  }
  return realTarget;
}

export async function replaceDirectory(temporary: string, destination: string): Promise<void> {
  try {
    await rename(temporary, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" || (error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
      await rm(temporary, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}
