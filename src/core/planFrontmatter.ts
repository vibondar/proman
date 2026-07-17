/**
 * YAML-ish frontmatter for Proman plan documents.
 *
 * ---
 * type: plan
 * title: Optional human title
 * ---
 */
export function extractFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!content.startsWith("---")) {
    return { meta: {}, body: content };
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { meta: {}, body: content };
  }
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const kv = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[kv[1].toLowerCase()] = value;
  }
  return { meta, body: content.slice(match[0].length) };
}

export function isPlanDocument(content: string): boolean {
  const { meta } = extractFrontmatter(content);
  return meta.type?.toLowerCase() === "plan";
}
