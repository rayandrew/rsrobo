import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Engine, runAgent } from "./agent.ts";
import type { Pr } from "./github.ts";
import { linkify } from "./review.ts";

// Answers a question about the default-branch checkout. Read-only; returns markdown with linked code refs.
export function askRepo(
  dir: string,
  owner: string,
  repo: string,
  question: string,
  o: {
    engine: Engine;
    budgetUsd: number;
    effort: string;
    promptsDir: string;
    kbDir?: string;
    issue?: number;
    mode?: "ask" | "summarize" | "triage";
  },
): { md: string; cost_usd: number; seconds: number; issue?: { number: number; title: string } } {
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const mode = o.mode ?? "ask";
  const labels = mode === "triage" ? repoLabels(owner, repo) : [];
  const prompt = [
    readFileSync(join(o.promptsDir, `${mode}.md`), "utf8"),
    o.issue ? issueContext(owner, repo, o.issue) : "",
    mode === "summarize" && o.issue ? prDiff(owner, repo, o.issue) : "",
    mode === "triage" ? `<labels>\n${labels.map((l) => `- ${l}`).join("\n") || "none"}\n</labels>` : "",
    `<question repo="${owner}/${repo}">\n${question}\n</question>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const t0 = Date.now();
  const out = runAgent(dir, prompt, {
    engine: o.engine,
    effort: o.effort,
    budgetUsd: o.budgetUsd,
    tools: "read",
    kb: o.kbDir ? { dir: o.kbDir, project: repo } : undefined,
  });
  const fake = { owner, repo, head } as Pr;
  const issue = o.issue ? issueTitle(owner, repo, o.issue) : undefined;
  return {
    issue,
    md: linkify(fake, fullPaths(dir, mode === "triage" ? enforceLabels(out.text, labels) : out.text)),
    cost_usd: out.cost_usd,
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

// The PR diff for summarize, capped so a huge PR still fits; the model greps the checkout for the rest.
function prDiff(owner: string, repo: string, number: number, maxBytes = 120_000): string {
  try {
    const diff = execFileSync("gh", ["pr", "diff", String(number), "-R", `${owner}/${repo}`], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    const cut = diff.length > maxBytes;
    return `<diff truncated="${cut}">\n${diff.slice(0, maxBytes)}\n</diff>`;
  } catch {
    return "";
  }
}

// The repository's own label names, so triage suggests names that exist.
function repoLabels(owner: string, repo: string): string[] {
  try {
    const labels = JSON.parse(
      execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${owner}/${repo}/labels?per_page=100`], {
        encoding: "utf8",
      }),
    ).flat() as { name: string }[];
    return labels.map((l) => l.name);
  } catch {
    return [];
  }
}

// Keeps only labels the repository has in the `| Labels | ... |` row, matched exactly, case-insensitive.
export function enforceLabels(text: string, labels: string[]): string {
  const byLower = new Map(labels.map((l) => [l.toLowerCase(), l]));
  return text.replace(/^(\| Labels \| )(.*?)( \|)$/m, (_, pre, cell, post) => {
    const kept = cell
      .split(",")
      .map((x: string) => byLower.get(x.trim().replace(/^`|`$/g, "").toLowerCase()))
      .filter((x: string | undefined): x is string => !!x);
    return `${pre}${kept.length ? [...new Set(kept)].join(", ") : "none"}${post}`;
  });
}

export type Decor = {
  mode: "ask" | "summarize" | "triage";
  question: string;
  model: string;
  cost_usd: number;
  seconds: number;
  requester?: string;
  issue?: { number: number; title: string };
};

// The same shape as a review: a colored header block, the body, sources collapsed, one footer line.
// Drops any preamble before the first line that carries content.
export function decorate(text: string, d: Decor): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^(\||\*\*|Yes|No|Partly|Unknown|Not found|`|\[)/.test(l.trim()));
  const body = (start > 0 ? lines.slice(start) : lines)
    .join("\n")
    .replace(/^(\*\*[^*]+\*\*)\s+- /gm, "$1\n- ")
    .trim();
  const [main, sources] = splitSources(body);
  const ref = d.issue ? ` on #${d.issue.number} ${d.issue.title}` : "";
  const header = {
    ask: () => `> [!NOTE]\n> **Answer**${ref}: ${d.question}`,
    summarize: () => `> [!NOTE]\n> **Summary**${ref}`,
    triage: () => {
      const sev = /\| Severity \| (P\d)/.exec(main)?.[1];
      const kind = sev === "P0" || sev === "P1" ? "CAUTION" : sev === "P2" ? "WARNING" : "NOTE";
      return `> [!${kind}]\n> **Triage**${ref}`;
    },
  }[d.mode]();
  const out = [header, main];
  if (sources) out.push(`<details><summary>Sources</summary>\n\n${sources}\n\n</details>`);
  out.push(
    `<sub>rsrobo ${d.mode} · \`${d.model}\` · $${d.cost_usd.toFixed(2)} · ${d.seconds}s${d.requester ? ` · asked by @${d.requester}` : ""}</sub>`,
  );
  return out.join("\n\n");
}

function splitSources(body: string): [string, string] {
  const i = body.search(/^Sources:/m);
  if (i < 0) return [body, ""];
  return [
    body.slice(0, i).trim(),
    body
      .slice(i)
      .replace(/^Sources:\s*/, "")
      .trim(),
  ];
}

function issueTitle(owner: string, repo: string, number: number): { number: number; title: string } | undefined {
  try {
    const i = JSON.parse(execFileSync("gh", ["api", `repos/${owner}/${repo}/issues/${number}`], { encoding: "utf8" }));
    return { number, title: i.title };
  } catch {
    return undefined;
  }
}
