export function errorMessage(error: unknown, fallback = "Unknown error"): string {
  const seen = new Set<object>();

  const read = (value: unknown, depth: number): string => {
    if (typeof value === "string") return value.trim();
    if (depth > 4 || value === null || typeof value !== "object") return "";
    if (seen.has(value)) return "";
    seen.add(value);

    const record = value as Record<string, unknown>;
    for (const key of ["stderr", "stdout", "message"]) {
      const detail = read(record[key], depth + 1);
      if (detail) return detail;
    }
    for (const key of ["error", "cause"]) {
      const detail = read(record[key], depth + 1);
      if (detail) return detail;
    }
    return "";
  };

  return read(error, 0) || fallback;
}
