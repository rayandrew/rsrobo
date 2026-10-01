import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Engine, runAgent } from "./agent.ts";
import { commentableLines, inDiff, parseHunks } from "./diff.ts";
import type { Pr } from "./github.ts";
import { type Finding, permalinkWhere, type Result } from "./review.ts";

export type Via = "patch" | "suggest" | "stacked" | "push";

// The latest saved review for this PR: the notes repo first, then the local work dir.
export function loadFindings(pr: Pr, notesDir: string | undefined, workDir: string): Result {
  const dir = notesDir && join(notesDir, "reviews", pr.owner, pr.repo, String(pr.number));
  if (dir && existsSync(dir)) {
    const latest = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .pop();
    if (latest) return JSON.parse(readFileSync(join(dir, latest), "utf8"));
  }
  const local = join(workDir, ".rsrobo", "review.json");
  if (existsSync(local)) return JSON.parse(readFileSync(local, "utf8"));
  throw new Error(`no saved review for ${pr.owner}/${pr.repo}#${pr.number}; run review first`);
}

export function pick(r: Result, spec: string): Finding[] {
  if (spec === "all") return r.findings;
  const known = r.findings.map((f) => f.n).join(", ");
  return spec
    .split(",")
    .map((n) => r.findings.find((f) => f.n === Number(n)) ?? fail(`no finding #${n}; known: ${known}`));
}

// Lets the model edit the checkout for one finding and returns the resulting diff against the PR head.
export function runFix(
  dir: string,
  pr: Pr,
  f: Finding,
  o: { engine: Engine; budgetUsd: number; promptsDir: string },
): { patch: string; note: string } {
  const prompt = [
    readFileSync(join(o.promptsDir, "fix.md"), "utf8"),
    `<finding file="${f.file}" lines="${f.line_start}-${f.line_end}" severity="${f.severity}">`,
    f.title,
    f.problem,
    ...f.evidence,
    `Fix: ${f.fix}`,
    f.suggested_patch ? `Suggested patch from the review, check it before you use it:\n${f.suggested_patch}` : "",
    "</finding>",
  ]
    .filter(Boolean)
    .join("\n");
  const out = runAgent(dir, prompt, { engine: o.engine, effort: "high", budgetUsd: o.budgetUsd, tools: "edit" });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  git("add", "-A", "--", ".", ":!.rsrobo", ":!CLAUDE.md", ":!AGENTS.md", ":!.claude", ":!.pi", ":!.agents");
  const patch = git("diff", "--cached");
  git("reset", "-q");
  return { patch, note: out.text };
}

export type Suggestion = {
  path: string;
  start_line?: number;
  line: number;
  side: "RIGHT";
  start_side?: "RIGHT";
  body: string;
};

// One GitHub suggestion per hunk, only where the hunk's old lines all sit inside the PR diff and the
// hunk is small enough to read as one change (Anthropic's plugin uses the same bar). The rest stays a patch.
export const MAX_SUGGESTION_LINES = 15;

export function suggestions(prPatch: string, fixPatch: string): { comments: Suggestion[]; leftover: number } {
  const lines = commentableLines(prPatch);
  const comments: Suggestion[] = [];
  let leftover = 0;
  for (const h of parseHunks(fixPatch)) {
    const end = h.oldStart + h.oldCount - 1;
    const fits = h.oldCount > 0 && h.newLines.length <= MAX_SUGGESTION_LINES && inDiff(lines, h.file, h.oldStart, end);
    if (!fits) {
      leftover++;
      continue;
    }
    comments.push({
      path: h.file,
      ...(end > h.oldStart ? { start_line: h.oldStart, start_side: "RIGHT" as const } : {}),
      line: end,
      side: "RIGHT",
      body: `\`\`\`suggestion\n${h.newLines.join("\n")}\n\`\`\``,
    });
  }
  return { comments, leftover };
}

// The patch came from `git diff` on the checkout, so it applies by construction; the check guards later edits.
export function patchApplies(dir: string, patch: string): boolean {
  if (!patch.trim()) return false;
  const r = spawnSync("git", ["-C", dir, "apply", "--check", "-"], { input: patch, encoding: "utf8" });
  return r.status === 0;
}

export const fixMd = (pr: Pr, f: Finding, patch: string, note: string, applies: boolean) => {
  const stat = patch.trim()
    ? `${patch.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length} changed lines, ${applies ? "applies cleanly" : "does not apply"}.`
    : "";
  return [
    `**Fix for ${f.severity} ${f.title}** at ${permalinkWhere(pr, f)}`,
    [note, stat].filter(Boolean).join(" "),
    patch.trim() ? `\`\`\`diff\n${patch.trim()}\n\`\`\`` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export type Author = { name: string; email: string };

// Applies the patch on the checkout, commits it as `author` with a clean message, and delivers it: `push` onto the PR's own
// branch, `stacked` onto a new branch in the base repository with a PR against the PR branch. Returns the URL.
export function deliverCommit(
  dir: string,
  pr: Pr,
  f: Finding,
  n: number,
  patch: string,
  via: "stacked" | "push",
  token: string,
  author: Author,
): string {
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
  execFileSync("git", ["-C", dir, "apply", "--index", "-"], { input: patch });
  const branch = via === "push" ? pr.head_ref : `rsrobo/fix-${pr.number}-${n}`;
  const remote = via === "push" ? pr.head_repo : `${pr.owner}/${pr.repo}`;
  git("checkout", "-q", "-B", branch);
  git("-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-q", "-m", `fix: ${f.title}`);
  git("push", "-q", `https://x-access-token:${token}@github.com/${remote}.git`, `HEAD:refs/heads/${branch}`);
  if (via === "push") return `${pr.html_url}/commits/${git("rev-parse", "HEAD").trim()}`;
  const body = `Applies finding ${n} from the rsrobo review of #${pr.number}: ${f.title}.\n\n${f.problem}\n\nFix: ${f.fix}`;
  return execFileSync(
    "gh",
    [
      "pr",
      "create",
      "-R",
      `${pr.owner}/${pr.repo}`,
      "--base",
      pr.head_ref,
      "--head",
      branch,
      "--title",
      `fix: ${f.title}`,
      "--body",
      body,
    ],
    { encoding: "utf8", env: { ...process.env, GH_TOKEN: token } },
  ).trim();
}

function fail(msg: string): never {
  throw new Error(msg);
}
