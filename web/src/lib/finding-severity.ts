import type { Finding, Severity } from "./types";

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function filterAndSortFindings(
  findings: readonly Finding[],
  severity: "all" | Severity,
  timeDirection: "asc" | "desc",
): Finding[] {
  return findings
    .filter((finding) => severity === "all" || finding.severity === severity)
    .sort((a, b) => {
      const severityCompared = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
      if (severityCompared !== 0) return severityCompared;
      const timeCompared = Date.parse(a.ts) - Date.parse(b.ts);
      if (timeCompared !== 0) return timeDirection === "asc" ? timeCompared : -timeCompared;
      return b.id.localeCompare(a.id, undefined, { numeric: true });
    });
}
