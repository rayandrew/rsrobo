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
  files: PrFile[];
};

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
    files,
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
  git("checkout", "-q", pr.head);
  mkdirSync(join(dir, ".rsrobo"), { recursive: true });
  writeFileSync(join(dir, ".rsrobo", "diff.patch"), git("diff", `${pr.base}...${pr.head}`));
  return dir;
}

export const permalink = (pr: Pr, file: string, from: number, to: number) =>
  `https://github.com/${pr.owner}/${pr.repo}/blob/${pr.head}/${file}#L${from}-L${to}`;
