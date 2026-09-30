import { execFileSync } from "node:child_process";
import type { Pr } from "./github.ts";

type Issue = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  pull_request?: unknown;
};
type PrLite = { number: number; title: string; html_url: string; state: string };

const gh = (path: string) =>
  JSON.parse(
    execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8", maxBuffer: 64 << 20 }),
  ).flat();

// Related work as markdown for the reviewer: issues the PR references, open PRs on the same files, past PRs
// on the same files (from squash-merge subjects in git log), and open issues that name the changed files.
// Read-only and free apart from API calls.
export function relatedReport(pr: Pr, dir: string, limit = 8): string {
  const base = `repos/${pr.owner}/${pr.repo}`;
  const files = pr.files.map((f) => f.filename);
  const out: string[] = [];

  const refs = [...new Set([...pr.body.matchAll(/(?:#|pull\/|issues\/)(\d+)/g)].map((m) => Number(m[1])))]
    .filter((n) => n !== pr.number)
    .slice(0, limit);
  const linked = refs.flatMap((n) => {
    try {
      const i = gh(`${base}/issues/${n}`)[0] as Issue;
      return [
        `- #${i.number} ${i.title} (${i.state}${i.pull_request ? ", PR" : ""}) ${i.html_url}\n  ${(i.body ?? "").replace(/\s+/g, " ").slice(0, 300)}`,
      ];
    } catch {
      return [];
    }
  });
  if (linked.length) out.push(`## Referenced by the PR\n${linked.join("\n")}`);

  const open = (gh(`${base}/pulls?state=open&per_page=30`) as PrLite[]).filter((p) => p.number !== pr.number);
  const overlapping = open.flatMap((p) => {
    const theirs = (gh(`${base}/pulls/${p.number}/files?per_page=100`) as { filename: string }[]).map(
      (f) => f.filename,
    );
    const shared = theirs.filter((f) => files.includes(f));
    return shared.length
      ? [`- #${p.number} ${p.title} ${p.html_url}\n  same files: ${shared.slice(0, 5).join(", ")}`]
      : [];
  });
  if (overlapping.length) out.push(`## Open PRs on the same files\n${overlapping.slice(0, limit).join("\n")}`);

  const past = new Map<number, Set<string>>();
  for (const f of files.slice(0, 40)) {
    let log = "";
    try {
      log = execFileSync("git", ["-C", dir, "log", "-n", "30", "--format=%s", "--first-parent", pr.base, "--", f], {
        encoding: "utf8",
      });
    } catch {
      continue;
    }
    for (const m of log.matchAll(/\(#(\d+)\)|^Merge pull request #(\d+)/gm)) {
      const n = Number(m[1] ?? m[2]);
      if (n !== pr.number) (past.get(n) ?? past.set(n, new Set()).get(n))?.add(f);
    }
  }
  const pastLines = [...past.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, limit)
    .map(([n, fs]) => `- #${n} touched ${fs.size} of these files: ${[...fs].slice(0, 4).join(", ")}`);
  if (pastLines.length) out.push(`## Earlier PRs on the same files\n${pastLines.join("\n")}`);

  const names = [
    ...new Set(
      files.map(
        (f) =>
          f
            .split("/")
            .pop()
            ?.replace(/\.[^.]+$/, "") ?? "",
      ),
    ),
  ]
    .filter((n) => n.length > 3)
    .slice(0, 5);
  const seen = new Set(refs);
  const mentions = names.flatMap((name) => {
    try {
      const q = `repo:${pr.owner}/${pr.repo} is:issue is:open in:title,body "${name}"`;
      const r = JSON.parse(
        execFileSync("gh", ["api", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "per_page=5"], {
          encoding: "utf8",
        }),
      ) as { items: Issue[] };
      return r.items
        .filter((i) => !seen.has(i.number) && seen.add(i.number))
        .map((i) => `- #${i.number} ${i.title} ${i.html_url} (mentions ${name})`);
    } catch {
      return [];
    }
  });
  if (mentions.length) out.push(`## Open issues that name the changed files\n${mentions.slice(0, limit).join("\n")}`);

  return out.length ? out.join("\n\n") : "No related issues or PRs found.";
}
