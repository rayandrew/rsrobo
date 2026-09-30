import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Row = {
  month: string;
  repo: string;
  model: string;
  runs: number;
  cost: number;
  seconds: number;
  findings: number;
};

// Monthly totals per repo and model from the saved review JSONs under <notes>/reviews.
export function ledger(notesDir: string): Row[] {
  const root = join(notesDir, "reviews");
  if (!existsSync(root)) return [];
  const rows = new Map<string, Row>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".json")) {
        const m = /(\d{4}-\d{2})-\d{2}-\d{2}-\d{2}-[0-9a-f]{7}\.json$/.exec(name);
        const r = JSON.parse(readFileSync(p, "utf8")) as {
          pr: string;
          model: string;
          cost_usd: number;
          seconds: number;
          findings: unknown[];
        };
        const repo = /github\.com\/([^/]+\/[^/]+)/.exec(r.pr)?.[1] ?? "?";
        const key = `${m?.[1] ?? "?"}|${repo}|${r.model}`;
        const row = rows.get(key) ?? {
          month: m?.[1] ?? "?",
          repo,
          model: r.model,
          runs: 0,
          cost: 0,
          seconds: 0,
          findings: 0,
        };
        row.runs++;
        row.cost += r.cost_usd ?? 0;
        row.seconds += r.seconds ?? 0;
        row.findings += r.findings?.length ?? 0;
        rows.set(key, row);
      }
    }
  };
  walk(root);
  return [...rows.values()].sort(
    (a, b) => b.month.localeCompare(a.month) || a.repo.localeCompare(b.repo) || a.model.localeCompare(b.model),
  );
}

export function ledgerMd(rows: Row[]): string {
  const head = ["Month", "Repo", "Model", "Runs", "Findings", "Cost", "Time"];
  const body = rows.map(
    (r) =>
      `| ${r.month} | ${r.repo} | \`${r.model}\` | ${r.runs} | ${r.findings} | $${r.cost.toFixed(2)} | ${Math.round(r.seconds / 60)} min |`,
  );
  const byMonth = new Map<string, number>();
  for (const r of rows) byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + r.cost);
  const totals = [...byMonth.entries()].map(([m, c]) => `- ${m}: $${c.toFixed(2)}`).join("\n");
  return `# Review ledger\n\nGenerated from \`reviews/**/*.json\`. Subscription runs bill no dollars; the cost is what the API would charge.\n\n${totals}\n\n| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${body.join("\n")}\n`;
}
