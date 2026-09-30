import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Result } from "./review.ts";

// A benchmark case: a past PR and the defects a reviewer must find in it. Lives in <notes>/bench/cases.json.
export type Case = { pr: string; expect: Pick<Finding, "file" | "line_start" | "line_end" | "title">[] };
export type CaseScore = {
  pr: string;
  found: number;
  expected: number;
  extra: number;
  cost_usd: number;
  seconds: number;
};
export type BenchRun = { date: string; model: string; effort: string; cases: CaseScore[] };

const same = (
  a: Pick<Finding, "file" | "line_start" | "line_end">,
  b: Pick<Finding, "file" | "line_start" | "line_end">,
) => a.file === b.file && a.line_start <= b.line_end + 5 && b.line_start <= a.line_end + 5;

export function score(c: Case, r: Result): CaseScore {
  const found = c.expect.filter((e) => r.findings.some((f) => same(e, f))).length;
  const extra = r.findings.filter((f) => !c.expect.some((e) => same(e, f))).length;
  return { pr: c.pr, found, expected: c.expect.length, extra, cost_usd: r.cost_usd, seconds: r.seconds };
}

export function loadCases(notesDir: string): Case[] {
  const f = join(notesDir, "bench", "cases.json");
  if (!existsSync(f))
    throw new Error(
      `no ${f}; add cases as [{ "pr": "owner/repo#N", "expect": [{ "file", "line_start", "line_end", "title" }] }]`,
    );
  return JSON.parse(readFileSync(f, "utf8"));
}

export function saveRun(notesDir: string, run: BenchRun): string {
  const dir = join(notesDir, "bench", "runs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${run.date.replace(/[:T]/g, "-").slice(0, 16)}-${run.model.replace(/[^\w.-]/g, "_")}.json`);
  writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
  return file;
}

export function lastRun(notesDir: string, model: string, before: string): BenchRun | undefined {
  const dir = join(notesDir, "bench", "runs");
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(`-${model.replace(/[^\w.-]/g, "_")}.json`))
    .sort();
  for (const f of files.reverse()) {
    const run: BenchRun = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (run.date < before) return run;
  }
  return undefined;
}

// Recall, extra findings, cost and time per case, with the change against the last run of the same model.
export function benchMd(run: BenchRun, prev?: BenchRun): string {
  const total = (r: BenchRun) => ({
    found: r.cases.reduce((s, c) => s + c.found, 0),
    expected: r.cases.reduce((s, c) => s + c.expected, 0),
    extra: r.cases.reduce((s, c) => s + c.extra, 0),
    cost: r.cases.reduce((s, c) => s + c.cost_usd, 0),
    seconds: r.cases.reduce((s, c) => s + c.seconds, 0),
  });
  const t = total(run);
  const p = prev && total(prev);
  const delta = (a: number, b?: number, unit = "") =>
    b === undefined ? "" : ` (${a - b >= 0 ? "+" : ""}${(a - b).toFixed(unit === "$" ? 2 : 0)}${unit})`;
  const rows = run.cases.map((c) => [
    c.pr,
    `${c.found}/${c.expected}`,
    String(c.extra),
    `$${c.cost_usd.toFixed(2)}`,
    `${c.seconds}s`,
  ]);
  rows.push([
    "total",
    `${t.found}/${t.expected}${delta(t.found, p?.found)}`,
    `${t.extra}${delta(t.extra, p?.extra)}`,
    `$${t.cost.toFixed(2)}${delta(t.cost, p?.cost, "$")}`,
    `${t.seconds}s${delta(t.seconds, p?.seconds, "s")}`,
  ]);
  const head = ["PR", "Found", "Extra", "Cost", "Time"];
  return [
    `**Bench** \`${run.model}\` at ${run.effort} effort, ${run.date.slice(0, 16)}${prev ? `, against ${prev.date.slice(0, 16)}` : ""}.`,
    [
      `| ${head.join(" | ")} |`,
      `|${head.map(() => "---").join("|")}|`,
      ...rows.map((r) => `| ${r.join(" | ")} |`),
    ].join("\n"),
    "Found: expected defects the review reported at the same place. Extra: findings outside the expected set; read them, some are real.",
  ].join("\n\n");
}
