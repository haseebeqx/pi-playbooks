import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerFact } from "./types.js";

export class FactLedger {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  append(input: Omit<LedgerFact, "factId" | "timestamp">): Promise<LedgerFact> {
    const fact: LedgerFact = {
      factId: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };
    const operation = this.writeTail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a", 0o600);
      try {
        await handle.write(`${JSON.stringify(fact)}\n`, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.writeTail = operation.catch(() => undefined);
    return operation.then(() => fact);
  }

  async readAll(): Promise<LedgerFact[]> {
    await this.writeTail;
    try {
      const text = await readFile(this.path, "utf8");
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerFact);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
