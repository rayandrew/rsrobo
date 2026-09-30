import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pr } from "./github.ts";
import { linkify } from "./review.ts";

const KB_TOOLS = ["mcp__rkb__rkb_search", "mcp__rkb__rkb_show"];

// Answers a question about the default-branch checkout. Read-only; returns markdown with linked code refs.
export function askRepo(
  dir: string,
  owner: string,
  repo: string,
  question: string,
  o: { model: string; budgetUsd: number; effort: string; promptsDir: string; kbDir?: string; issue?: number },
): { md: string; cost_usd: number; seconds: number } {
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const prompt = [
    readFileSync(join(o.promptsDir, "ask.md"), "utf8"),
    o.issue ? issueContext(owner, repo, o.issue) : "",
    `<question repo="${owner}/${repo}">\n${question}\n</question>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const t0 = Date.now();
  const r = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--no-session-persistence",
      "--setting-sources",
      "project",
      "--tools",
      "Read,Grep,Glob",
      "--permission-prompts",
      "none",
      "--model",
      o.model,
      "--effort",
      o.effort,
      "--max-budget-usd",
      String(o.budgetUsd),
      ...(o.kbDir
        ? [
            "--strict-mcp-config",
            "--mcp-config",
            JSON.stringify({ mcpServers: { rkb: { command: "rkb", args: ["mcp"] } } }),
            "--allowedTools",
            ...KB_TOOLS,
          ]
        : []),
    ],
    {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 << 20,
      env: o.kbDir ? { ...process.env, RKB_HOME: o.kbDir, RKB_PROJECT: repo } : process.env,
    },
  );
  if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  if (out.is_error) throw new Error(`ask failed: ${out.result}`);
  const fake = { owner, repo, head } as Pr;
  return {
    md: linkify(fake, fullPaths(dir, String(out.result).trim())),
    cost_usd: out.total_cost_usd,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// A reference with a bare file name becomes the full path when exactly one tracked file has that name.
export function fullPaths(dir: string, text: string): string {
  const tracked = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" }).split("\n");
  return text.replace(/`([\w@./-]+\.[A-Za-z0-9]+):(\d+(?:-\d+)?)`/g, (m, file: string, lines: string) => {
    if (tracked.includes(file)) return m;
    const hits = tracked.filter((t) => t.endsWith(`/${file}`));
    return hits.length === 1 ? `\`${hits[0]}:${lines}\`` : m;
  });
}

type Issue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  pull_request?: unknown;
};

// The issue the question was asked on, and open issues and PRs whose title shares its words: what "this" and
// "duplicates" refer to. Both are untrusted text and are wrapped as data.
export function issueContext(owner: string, repo: string, number: number): string {
  const gh = (args: string[]) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8" }));
  const i = gh([`repos/${owner}/${repo}/issues/${number}`]) as Issue;
  const words = [...new Set(i.title.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])]
    .filter((w) => !STOP.has(w))
    .slice(0, 6);
  // Keyword hits carry a body excerpt. GitHub search requires every word and has no OR, so widen step by step:
  // all words, the three longest, each alone. Then every open issue and PR title, so the model can judge
  // similarity itself; that beats keywords up to a few hundred items and costs about a cent.
  const similar: Issue[] = [];
  for (const set of [words.slice(0, 6), words.slice(0, 3), ...words.slice(0, 3).map((w) => [w])]) {
    if (!set.length || similar.length >= 5) break;
    try {
      const q = `repo:${owner}/${repo} is:open ${set.join(" ")}`;
      const items = (gh(["-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "per_page=10"]) as { items: Issue[] })
        .items;
      for (const x of items) if (x.number !== number && !similar.some((y) => y.number === x.number)) similar.push(x);
    } catch {}
  }
  const list = similar.map(
    (x) =>
      `- #${x.number} ${x.title} (${x.pull_request ? "PR" : "issue"}) ${x.html_url}\n  ${(x.body ?? "").replace(/\s+/g, " ").slice(0, 200)}`,
  );
  let titles: string[] = [];
  try {
    titles = (gh(["--paginate", "--slurp", `repos/${owner}/${repo}/issues?state=open&per_page=100`]) as Issue[][])
      .flat()
      .filter((x) => x.number !== number)
      .slice(0, 300)
      .map((x) => `- #${x.number} ${x.title}${x.pull_request ? " (PR)" : ""}`);
  } catch {}
  if (titles.length) list.push(`\nAll open items, title only:`, ...titles);
  return [
    `<issue number="${number}" state="${i.state}">`,
    `<title>${i.title}</title>`,
    `<body>\n${(i.body ?? "").slice(0, 6000)}\n</body>`,
    "</issue>",
    `<similar count="${list.length}">\n${list.join("\n") || "none found by title words"}\n</similar>`,
  ].join("\n");
}

const STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "when",
  "have",
  "should",
  "would",
  "could",
  "does",
  "into",
  "there",
  "their",
  "about",
  "after",
  "before",
  "support",
  "feature",
  "issue",
  "error",
  "bug",
]);
