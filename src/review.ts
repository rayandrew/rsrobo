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
  problem: string;
  evidence: string[];
  fix: string;
  suggested_patch?: string;
};

export type Change = { area: string; change: string };

export type Review = { map: string; changes: Change[]; findings: Finding[]; skipped: string[] };

export type Result = Review & { model: string; effort: string; cost_usd: number; seconds: number; files: number };

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["map", "changes", "findings", "skipped"],
  properties: {
    map: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["area", "change"],
        properties: { area: { type: "string" }, change: { type: "string" } },
      },
    },
    skipped: { type: "array", items: { type: "string" } },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line_start", "line_end", "severity", "title", "problem", "evidence", "fix"],
        properties: {
          file: { type: "string", description: "Path relative to the repo root" },
          line_start: { type: "integer" },
          line_end: { type: "integer" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          title: { type: "string" },
          problem: { type: "string" },
          evidence: { type: "array", items: { type: "string" } },
          fix: { type: "string" },
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
    model: o.model,
    effort: o.effort,
    cost_usd: out.total_cost_usd,
    seconds: Math.round((Date.now() - t0) / 1000),
    files: pr.files.length,
  };
}

const CODE_REF = /`([\w@./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`/g;

export const linkify = (pr: Pr, text: string) =>
  text.replace(CODE_REF, (m, file, a, b) => `[${m}](${permalink(pr, file, Number(a), Number(b ?? a))})`);

export const shownFindings = (r: Result, minSeverity: Severity) => r.findings.filter((f) => f.severity <= minSeverity);

const LEGEND = "<sub>P0 data loss or security. P1 wrong behavior. P2 needs a maintainer decision. P3 minor.</sub>";

export function verdict(shown: Finding[]): string {
  if (shown.some((f) => f.severity <= "P1")) return "> [!CAUTION]\n> **Needs changes.**";
  if (shown.length) return "> [!WARNING]\n> **Minor issues.**";
  return "> [!TIP]\n> **Looks good.**";
}

// Overview: verdict, findings table, collapsed walkthrough. Used as the review body and the inbox header.
export function overview(pr: Pr, r: Result, shown: Finding[]): string {
  const n = shown.length;
  const out = [
    `${verdict(shown)} ${n === 0 ? "No findings" : `${n} finding${n === 1 ? "" : "s"}`} in ${r.files} files. \`${r.model}\` at ${r.effort} effort, $${r.cost_usd.toFixed(2)}, ${Math.round(r.seconds / 60)} min.`,
  ];
  if (n) {
    out.push(
      table(
        ["Sev", "Where", "Finding"],
        shown.map((f) => [f.severity, where(pr, f), f.title]),
      ),
    );
    out.push(LEGEND);
  }
  const walk = [linkify(pr, r.map)];
  if (r.changes.length)
    walk.push(
      table(
        ["Area", "Change"],
        r.changes.map((c) => [`\`${c.area}\``, c.change]),
      ),
    );
  if (r.skipped.length) walk.push(`Not reviewed: ${r.skipped.join("; ")}.`);
  out.push(`<details><summary>Walkthrough</summary>\n\n${walk.join("\n\n")}\n\n</details>`);
  return out.join("\n\n");
}

// One finding as a comment body: title, problem, evidence bullets, fix, then collapsed patch and agent text.
export function findingMd(pr: Pr, f: Finding, withWhere = true): string {
  const out = [
    `**${f.severity} ${f.title}**${withWhere ? ` at ${where(pr, f)}` : ""}`,
    linkify(pr, f.problem),
    f.evidence.map((e) => `- ${linkify(pr, e)}`).join("\n"),
    `Fix: ${linkify(pr, f.fix)}`,
  ];
  if (f.suggested_patch) {
    out.push(
      `<details><summary>Suggested fix</summary>\n\n\`\`\`diff\n${f.suggested_patch.trim()}\n\`\`\`\n\n</details>`,
    );
  }
  out.push(
    `<details><summary>Copy-paste text for an agent</summary>\n\n\`\`\`text\n${agentText(pr, f)}\n\`\`\`\n\n</details>`,
  );
  return out.join("\n\n");
}

export function render(pr: Pr, r: Result, minSeverity: Severity = "P3"): string {
  const shown = shownFindings(r, minSeverity);
  return [overview(pr, r, shown), ...shown.map((f) => findingMd(pr, f))].join("\n\n---\n\n");
}

const agentText = (pr: Pr, f: Finding) =>
  [
    `Fix this defect in ${pr.owner}/${pr.repo} at commit ${pr.head}, file ${f.file} lines ${f.line_start}-${f.line_end}.`,
    f.problem,
    ...f.evidence,
    `Fix: ${f.fix}`,
    "Change only what the fix needs. Run the relevant tests.",
  ].join("\n");

const table = (head: string[], rows: string[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join(
    "\n",
  );

const where = (pr: Pr, f: Finding) => {
  const name = f.file.split("/").pop();
  const span = f.line_end > f.line_start ? `${f.line_start}-${f.line_end}` : `${f.line_start}`;
  return `[${name}:${span}](${permalink(pr, f.file, f.line_start, f.line_end)})`;
};
