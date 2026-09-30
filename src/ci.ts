import { execFileSync } from "node:child_process";
import type { Pr } from "./github.ts";

type CheckRun = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  app: { slug: string };
  output: { title: string | null; summary: string | null; text: string | null };
};

const gh = (path: string) =>
  execFileSync("gh", ["api", "--allow-escape-sequences", path], { encoding: "utf8", maxBuffer: 64 << 20 });
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

// Failed checks on the PR head as markdown for the reviewer: the tail of each Actions job log, or the check's own summary.
// Read-only and free; nothing from the PR runs.
export function ciReport(pr: Pr, tailLines = 120): string {
  const runs: CheckRun[] = JSON.parse(
    gh(`repos/${pr.owner}/${pr.repo}/commits/${pr.head}/check-runs?per_page=100`),
  ).check_runs;
  const failed = runs.filter(
    (r) => r.status === "completed" && r.conclusion && !["success", "skipped", "neutral"].includes(r.conclusion),
  );
  const pending = runs.filter((r) => r.status !== "completed").length;
  if (!runs.length) return "No CI checks on the head commit.";
  const out = [`${runs.length} checks on the head commit, ${failed.length} failed, ${pending} still running.`];
  for (const r of failed) {
    let detail = "";
    if (r.app.slug === "github-actions") {
      try {
        detail = tail(gh(`repos/${pr.owner}/${pr.repo}/actions/jobs/${r.id}/logs`), tailLines);
      } catch {
        detail = "(log not available)";
      }
    } else detail = [r.output.title, r.output.summary, r.output.text].filter(Boolean).join("\n").slice(0, 4000);
    out.push(`## ${r.name} (${r.conclusion})\n${r.html_url}\n\n\`\`\`text\n${detail}\n\`\`\``);
  }
  return out.join("\n\n");
}

// Keep the error lines and the last lines; drop the timestamp prefix Actions adds.
function tail(log: string, n: number): string {
  const lines = log
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.replace(/^\S+T\S+Z /, ""));
  const errors = lines.filter((l) => /##\[error\]|error:|FAILED|Error/.test(l)).slice(0, 40);
  const last = lines.slice(-n);
  return [...new Set([...errors, ...last])].join("\n").slice(-12000);
}
