import type { Pr } from "./github.ts";
import type { Severity } from "./review.ts";

// A repo's commit message rule from config.json: Conventional Commits with the types that repo uses.
export type CommitPolicy = { types: string[]; severity: Severity };

export type CommitIssue = {
  where: string;
  subject: string;
  problem: string;
  severity: Severity;
  url: string;
  suggested?: string;
};

// A replacement subject from the model, keyed by `where` of the issue it replaces.
export type CommitSubject = { where: string; subject: string };

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

// What the model reads in .rsrobo/commits.md: the code found these subjects wrong; the model, which knows the diff, words the new ones.
export const commitsBrief = (issues: CommitIssue[], types: string[]) =>
  [
    "These subjects are not Conventional Commits. The tool found them; do not report them as findings.",
    "For each one, write a replacement in `commit_subjects` with the same `where`.",
    `Form: \`type(scope): description\`, lowercase, imperative, under 72 characters, the scope optional. Types: ${types.join(", ")}.`,
    "Choose the type from what that commit changes in the diff.",
    "",
    ...issues.map((c) => `- where: ${c.where} | subject: ${c.subject}`),
  ].join("\n");

// A suggestion is shown only when it passes the same check that found the issue.
export function applySuggestions(issues: CommitIssue[], subjects: CommitSubject[] | undefined, types: string[]) {
  for (const c of issues) {
    const s = subjects?.find((x) => x.where === c.where)?.subject.trim();
    if (s && !s.includes("\n") && subjectProblem(s, types) === null) c.suggested = s;
  }
  return issues;
}

export const REWORD_HOW =
  "To fix: reword each commit with `git rebase -i`, then `git push --force-with-lease`. Edit the PR title on GitHub.";

export function commitsAgentText(pr: Pr, issues: CommitIssue[]): string {
  const to = (c: CommitIssue) => (c.suggested ? `"${c.suggested}"` : "a subject of the form type(scope): description");
  const commits = issues.filter((c) => c.where !== "PR title");
  const title = issues.find((c) => c.where === "PR title");
  return [
    `Reword commit messages on branch ${pr.head_ref} of ${pr.head_repo} (${pr.html_url}) to Conventional Commits.`,
    "Change only the messages. Do not change the code.",
    ...commits.map((c) => `${c.where}: "${c.subject}" -> ${to(c)}`),
    commits.length && `Run \`git rebase -i ${pr.base.slice(0, 7)}\` and mark each listed commit \`reword\`.`,
    title && `Set the pull request title to ${to(title)}.`,
    commits.length && "Do not push. Tell the user to run `git push --force-with-lease`.",
  ]
    .filter(Boolean)
    .join("\n");
}
