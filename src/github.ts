import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Pr = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  base: string;
  head: string;
  html_url: string;
  head_ref: string;
  head_repo: string;
  author: string;
  people: People;
  files: PrFile[];
};

// Who is involved: commit authors, comment and review authors. Logins, deduplicated, without bots.
export type People = { contributors: string[]; commenters: string[]; reviewers: string[] };

export type PrFile = { filename: string; status: string; changes: number };

const gh = (args: string[]) => execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 << 20 });

export function fetchPr(owner: string, repo: string, number: number): Pr {
  const p = JSON.parse(gh([`repos/${owner}/${repo}/pulls/${number}`]));
  const files = JSON.parse(
    gh(["--paginate", "--slurp", `repos/${owner}/${repo}/pulls/${number}/files?per_page=100`]),
  ).flat();
  return {
    owner,
    repo,
    number,
    title: p.title,
    body: p.body ?? "",
    base: p.base.sha,
    head: p.head.sha,
    html_url: p.html_url,
    head_ref: p.head.ref,
    head_repo: p.head.repo.full_name,
    author: p.user.login,
    people: people(owner, repo, number),
    files,
  };
}

function people(owner: string, repo: string, number: number): People {
  const logins = (path: string, pick: (x: Record<string, { login?: string } | null>) => string | undefined) =>
    [
      ...new Set(
        (JSON.parse(gh(["--paginate", "--slurp", path])).flat() as Record<string, { login?: string } | null>[]).map(
          pick,
        ),
      ),
    ]
      .filter((l): l is string => !!l && !l.endsWith("[bot]"))
      .sort();
  const base = `repos/${owner}/${repo}`;
  return {
    contributors: logins(`${base}/pulls/${number}/commits?per_page=100`, (c) => c.author?.login),
    commenters: [
      ...new Set([
        ...logins(`${base}/issues/${number}/comments?per_page=100`, (c) => c.user?.login),
        ...logins(`${base}/pulls/${number}/comments?per_page=100`, (c) => c.user?.login),
      ]),
    ].sort(),
    reviewers: logins(`${base}/pulls/${number}/reviews?per_page=100`, (r) => r.user?.login),
  };
}

// Clones once per PR under workRoot, checks out the head, writes the diff to .rsrobo/diff.patch.
export function checkout(pr: Pr, workRoot: string): string {
  const dir = join(workRoot, `${pr.owner}__${pr.repo}__${pr.number}`);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 << 20 });
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "-q", "--filter=blob:none", `https://github.com/${pr.owner}/${pr.repo}.git`, dir]);
  }
  git("fetch", "-q", "origin", `pull/${pr.number}/head`, pr.base);
  git("reset", "-q", "--hard");
  git("clean", "-qfd", "-e", ".rsrobo");
  git("checkout", "-q", pr.head);
  mkdirSync(join(dir, ".rsrobo"), { recursive: true });
  writeFileSync(join(dir, ".rsrobo", "diff.patch"), git("diff", `${pr.base}...${pr.head}`));
  return dir;
}

export const permalink = (pr: Pr, file: string, from: number, to: number) =>
  `https://github.com/${pr.owner}/${pr.repo}/blob/${pr.head}/${file}#L${from}-L${to}`;

// Shallow clone of the default branch, for init-notes.
export function cloneDefault(owner: string, repo: string, workRoot: string): string {
  const dir = join(workRoot, `${owner}__${repo}__default`);
  if (existsSync(dir)) execFileSync("git", ["-C", dir, "pull", "-q", "--ff-only"]);
  else {
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "-q", "--depth", "1", `https://github.com/${owner}/${repo}.git`, dir]);
  }
  return dir;
}
