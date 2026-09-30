import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Pr, permalink } from "./github.ts";

export type Severity = "P0" | "P1" | "P2" | "P3";

export type Finding = {
  file: string;
  line_start: number;
  line_end: number;
  severity: Severity;
  title: string;
  body: string;
  suggested_patch?: string;
};

export type Review = { map: string; findings: Finding[]; skipped: string[] };

export type Result = Review & { alias: string; cost_usd: number; seconds: number; files: number };

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["map", "findings", "skipped"],
  properties: {
    map: { type: "string" },
    skipped: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line_start", "line_end", "severity", "title", "body"],
        properties: {
          file: { type: "string", description: "Path relative to the repo root" },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          title: { type: "string", description: "One line, under 80 characters" },
          body: { type: "string", description: "One short paragraph: what is wrong, the evidence, the fix" },
          suggested_patch: { type: "string", description: "Unified diff, only when the fix is small and complete" },
        },
      },
    },
  },
};

export type Options = {
  model: string;
  verifyModel: string;
  budgetUsd: number;
  effort: string;
  focus?: string;
  notesDir?: string;
  skillsDir?: string;
  promptsDir: string;
};

// The PR head must not configure the reviewer (prompt injection), so its own
// CLAUDE.md, AGENTS.md and .claude/ are removed and the overlay from rsrobo-notes takes their place.
export function prepare(dir: string, pr: Pr, notesDir?: string) {
  for (const f of ["CLAUDE.md", "AGENTS.md", ".claude"]) rmSync(join(dir, f), { recursive: true, force: true });
  const overlay = notesDir && join(notesDir, pr.owner, pr.repo);
  if (overlay && existsSync(overlay)) cpSync(overlay, dir, { recursive: true });
}

export function buildPrompt(pr: Pr, o: Options): string {
  const files = pr.files.map((f) => `- ${f.filename} (${f.status}, ${f.changes} lines)`).join("\n");
  return [
    readFileSync(join(o.promptsDir, "review.md"), "utf8"),
    o.focus && `Focus on: ${o.focus}.`,
    `<pr repo="${pr.owner}/${pr.repo}" number="${pr.number}" base="${pr.base}" head="${pr.head}">`,
    `<title>${pr.title}</title>`,
    `<body>\n${pr.body}\n</body>`,
    `<changed_files count="${pr.files.length}">\n${files}\n</changed_files>`,
    `</pr>`,
    `The full diff is in \`.rsrobo/diff.patch\`.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function runReview(dir: string, pr: Pr, o: Options): Result {
  const agents = {
    verify: {
      description: "Confirms or rejects one candidate finding by reading the code",
      prompt: readFileSync(join(o.promptsDir, "verify.md"), "utf8"),
      tools: ["Read", "Grep", "Glob"],
      model: o.verifyModel,
    },
  };
  const t0 = Date.now();
  const r = spawnSync(
    "claude",
    [
      "-p",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--tools",
      "Read,Grep,Glob,Agent",
      "--permission-prompts",
      "none",
      "--model",
      o.model,
      "--effort",
      o.effort,
      "--max-budget-usd",
      String(o.budgetUsd),
      "--agents",
      JSON.stringify(agents),
      "--json-schema",
      JSON.stringify(reviewSchema),
      ...(o.skillsDir ? ["--add-dir", o.skillsDir] : []),
      buildPrompt(pr, o),
    ],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20 },
  );
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  if (out.is_error || !out.structured_output)
    throw new Error(`review failed (${out.terminal_reason ?? out.subtype}): ${out.result}`);
  const review: Review = out.structured_output;
  review.findings.sort((a, b) => a.severity.localeCompare(b.severity));
  return {
    ...review,
    alias: o.model,
    cost_usd: out.total_cost_usd,
    seconds: Math.round((Date.now() - t0) / 1000),
    files: pr.files.length,
  };
}

export function render(pr: Pr, r: Result, minSeverity: Severity = "P3"): string {
  const shown = r.findings.filter((f) => f.severity <= minSeverity);
  const counts = (["P0", "P1", "P2", "P3"] as Severity[])
    .map((s) => [s, shown.filter((f) => f.severity === s).length])
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  const out = [
    "## rsrobo review",
    shown.length ? `**${shown.length} finding${shown.length === 1 ? "" : "s"}** (${counts})` : "No findings.",
  ];
  for (const f of shown) {
    out.push(
      `### ${f.severity} · ${f.title}\n[\`${f.file}:${f.line_start}-${f.line_end}\`](${permalink(pr, f.file, f.line_start, f.line_end)})\n\n${f.body}`,
    );
    if (f.suggested_patch) out.push(`\`\`\`diff\n${f.suggested_patch.trim()}\n\`\`\``);
  }
  const details = [`**Map.** ${r.map}`];
  if (r.skipped.length) details.push(`**Skipped.** ${r.skipped.join("; ")}`);
  out.push(`<details><summary>Details</summary>\n\n${details.join("\n\n")}\n\n</details>`);
  out.push(`<sub>${r.alias} · $${r.cost_usd.toFixed(2)} · ${r.files} files · ${r.seconds}s</sub>`);
  return out.join("\n\n");
}
