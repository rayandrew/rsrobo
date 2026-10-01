import type { Pr } from "./github.ts";
import type { Severity } from "./review.ts";

// A repo's commit message rule from config.json: Conventional Commits with the types that repo uses.
export type CommitPolicy = { types: string[]; severity: Severity };

export type CommitIssue = { where: string; subject: string; problem: string; severity: Severity; url: string };

const FORM = /^([a-z]+)(\([^()\s][^()]*\))?(!)?: (.+)$/;

// Why a subject is not a Conventional Commit, or null when it is. Merge and revert subjects that git writes are exempt.
export function subjectProblem(subject: string, types: string[]): string | null {
  if (/^(Merge |Revert ")/.test(subject)) return null;
  if (/^[a-z]+!\(/.test(subject)) return "the `!` goes after the scope: `type(scope)!: description`";
  const m = FORM.exec(subject);
  if (!m) return "not `type(scope): description`";
  if (!types.includes(m[1])) return `unknown type \`${m[1]}\`; this repository uses ${types.join(", ")}`;
  return null;
}

// Checked in code, not by the model: every commit subject of the PR and its title, which a squash merge keeps.
export function checkCommits(pr: Pr, policy: CommitPolicy | undefined): CommitIssue[] {
  if (!policy) return [];
  const out: CommitIssue[] = [];
  const add = (where: string, subject: string, url: string) => {
    const problem = subjectProblem(subject, policy.types);
    if (problem) out.push({ where, subject, problem, severity: policy.severity, url });
  };
  add("PR title", pr.title, pr.html_url);
  for (const c of pr.commits) add(c.sha.slice(0, 7), c.subject, `${pr.html_url}/commits/${c.sha}`);
  return out;
}
