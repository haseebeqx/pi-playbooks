export function nextSourceVersion(version: string): string {
  const match = /^(.*?)(\d+)$/.exec(version.trim());
  if (!match) return `${version.trim()}.1`;
  return `${match[1]}${Number(match[2]) + 1}`;
}

export function appendAdditionalInstruction(procedure: string, instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  if (!normalized) throw new Error("Additional instruction must not be empty");

  const heading = /^## Additional instructions\s*$/im.exec(procedure);
  if (!heading) {
    const prefix = procedure.endsWith("\n") ? procedure : `${procedure}\n`;
    return `${prefix}\n## Additional instructions\n\n- ${normalized}\n`;
  }

  const sectionStart = heading.index + heading[0].length;
  const remainder = procedure.slice(sectionStart);
  const nextHeading = /\n##\s+/m.exec(remainder);
  const insertionPoint = nextHeading ? sectionStart + nextHeading.index : procedure.length;
  const before = procedure.slice(0, insertionPoint).replace(/\s*$/, "");
  const after = procedure.slice(insertionPoint);
  return `${before}\n\n- ${normalized}\n${after.startsWith("\n") || !after ? after : `\n${after}`}`;
}
