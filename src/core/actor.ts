/** Normalize @alice / Alice → alice for comparisons. */
export function normalizeActor(name: string | undefined | null): string {
  if (!name || typeof name !== "string") return "";
  return name.trim().replace(/^@+/, "").toLowerCase();
}

export function displayActor(name: string | undefined | null): string {
  const n = (name ?? "").trim().replace(/^@+/, "");
  return n || "unknown";
}

export function actorsEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizeActor(a);
  const nb = normalizeActor(b);
  return Boolean(na) && na === nb;
}
