import type { Pr } from "./github.ts";
import { type Finding, permalinkWhere, type Result } from "./review.ts";

export type Run = { alias: string; result: Result };

// Two findings are the same defect when they sit in the same file and their line ranges are within `slack` lines.
const same = (a: Finding, b: Finding, slack = 5) =>
  a.file === b.file && a.line_start <= b.line_end + slack && b.line_start <= a.line_end + slack;

export function compareMd(pr: Pr, runs: Run[]): string {
  const head = ["Model", "Findings", "P0/P1", "Cost", "Time"];
  const rows = runs.map((r) => [
    `\`${r.result.model}\``,
    String(r.result.findings.length),
    String(r.result.findings.filter((f) => f.severity <= "P1").length),
    `$${r.result.cost_usd.toFixed(2)}`,
    `${Math.round(r.result.seconds / 60)} min`,
  ]);
  const out = [`**Compare** ${runs.length} models on ${pr.owner}/${pr.repo}#${pr.number}.`, table(head, rows)];

  // Group findings across runs by location; each group lists which model reported it.
  const groups: { lead: Finding; by: Map<string, Finding> }[] = [];
  for (const r of runs) {
    for (const f of r.result.findings) {
      const g = groups.find((g) => same(g.lead, f));
      if (g) g.by.set(r.alias, f);
      else groups.push({ lead: f, by: new Map([[r.alias, f]]) });
    }
  }
  groups.sort((a, b) => b.by.size - a.by.size || a.lead.severity.localeCompare(b.lead.severity));
  if (groups.length) {
    out.push(
      table(
        ["Where", "Finding", ...runs.map((r) => r.alias)],
        groups.map((g) => [
          permalinkWhere(pr, g.lead),
          g.lead.title,
          ...runs.map((r) => (g.by.has(r.alias) ? (g.by.get(r.alias)?.severity ?? "") : "")),
        ]),
      ),
    );
  }
  for (const r of runs) {
    const body = r.result.findings.map((f) => `- ${f.severity} ${f.title} at ${permalinkWhere(pr, f)}`).join("\n");
    out.push(
      `<details><summary>${r.alias}: ${r.result.findings.length} findings</summary>\n\n${body || "none"}\n\n</details>`,
    );
  }
  return out.join("\n\n");
}

const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
    "\n",
  );
