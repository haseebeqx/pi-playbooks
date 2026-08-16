import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface CommandEvidence {
  command: string;
  commandHash: string;
  attempts: number;
  succeeded: number;
  failed: number;
  unknown: number;
  firstObservedOrder: number;
}

interface ObservedCall {
  id: string;
  command: string;
  commandHash: string;
  order: number;
}

const SENSITIVE_NAME = "(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)";
const ASSIGNMENT_PATTERN = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*${SENSITIVE_NAME}[A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\\s]+)`, "gi");
const FLAG_PATTERN = new RegExp(`(--?[A-Za-z0-9_-]*${SENSITIVE_NAME}[A-Za-z0-9_-]*)(?:=|\\s+)(?:"[^"]*"|'[^']*'|[^\\s]+)`, "gi");

/** Minimize obvious inline credentials before command text is shown to the drafting model. */
export function redactCommand(command: string): string {
  return command
    .replace(ASSIGNMENT_PATTERN, "$1=<redacted>")
    .replace(FLAG_PATTERN, "$1=<redacted>")
    .slice(0, 2_000);
}

/**
 * Extract only bash command/outcome evidence from Pi's session trace for the run window.
 * Raw outputs and non-command tool arguments are deliberately excluded.
 */
export async function commandEvidenceFromSession(
  sessionFile: string | undefined,
  startedAt: string,
  endedAt: string | undefined,
): Promise<CommandEvidence[]> {
  if (!sessionFile) return [];
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : Number.POSITIVE_INFINITY;
  const calls: ObservedCall[] = [];
  const outcomes = new Map<string, "succeeded" | "failed">();

  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const timestamp = Date.parse(String(entry.timestamp ?? ""));
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== "object") continue;
        const call = item as Record<string, unknown>;
        if (call.type !== "toolCall" || call.name !== "bash" || typeof call.id !== "string") continue;
        const args = call.arguments;
        if (!args || typeof args !== "object") continue;
        const command = (args as Record<string, unknown>).command;
        if (typeof command !== "string" || !command.trim()) continue;
        calls.push({
          id: call.id,
          command: redactCommand(command),
          commandHash: createHash("sha256").update(command).digest("hex"),
          order: calls.length + 1,
        });
      }
    } else if (message.role === "toolResult" && message.toolName === "bash" && typeof message.toolCallId === "string") {
      outcomes.set(message.toolCallId, message.isError === true ? "failed" : "succeeded");
    }
  }

  const grouped = new Map<string, CommandEvidence>();
  for (const call of calls) {
    const key = call.commandHash;
    const evidence = grouped.get(key) ?? {
      command: call.command,
      commandHash: call.commandHash,
      attempts: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
      firstObservedOrder: call.order,
    };
    evidence.attempts += 1;
    const outcome = outcomes.get(call.id);
    if (outcome === "succeeded") evidence.succeeded += 1;
    else if (outcome === "failed") evidence.failed += 1;
    else evidence.unknown += 1;
    grouped.set(key, evidence);
  }

  const ordered = [...grouped.values()]
    .sort((left, right) => left.firstObservedOrder - right.firstObservedOrder);
  const result: CommandEvidence[] = [];
  let commandCharacterBudget = 20_000;
  for (const evidence of ordered) {
    if (result.length >= 50 || evidence.command.length > commandCharacterBudget) break;
    result.push(evidence);
    commandCharacterBudget -= evidence.command.length;
  }
  return result;
}
