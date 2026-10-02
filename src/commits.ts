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
  // Lines to delete from the message: AI attribution.
  remove?: string[];
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

// AI attribution in a commit message or a PR body. A co-author is a tool when its email is a tool address or
// its name is a product name. A first name alone (Claude, Devin, Jules) is a person, so it never counts.
const TOOL_EMAIL =
  /@(anthropic\.com|openai\.com|cursor\.(sh|com)|devin\.ai|windsurf\.com|cognition\.ai)\b|copilot@github\.com|\[bot\]/i;
const PRODUCT =
  /\b(claude code|claude (opus|sonnet|haiku)|github copilot|copilot (agent|swe)|chatgpt|openai codex|codex (cli|agent)|cursor agent|gemini (cli|code assist)|devin ai|claude\.ai|anthropic claude)\b/i;
const TRAILER = /^(co-authored-by|assisted-by|generated-by|ai-generated|made-with|authored-with):\s*(.*)$/i;
const BADGE =
  /^(generated|made|written|created|authored|assisted) (with|by) (claude|copilot|chatgpt|codex|gemini|cursor|an? ai|ai)\b|🤖/i;
export const attributionLines = (message: string) =>
  message
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      const t = TRAILER.exec(l);
      return t ? !/co-authored-by/i.test(t[1]) || TOOL_EMAIL.test(t[2]) || PRODUCT.test(t[2]) : BADGE.test(l);
    });

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
  const attribution = (where: string, text: string, url: string) => {
    const remove = attributionLines(text);
    if (remove.length)
      out.push({
        where,
        subject: where === "PR body" ? "" : text.split("\n")[0],
        problem: `AI attribution: ${remove.map((l) => `\`${l.replace(/[|`]/g, " ").slice(0, 60)}\``).join(", ")}`,
        severity: policy.severity,
        url,
        remove,
      });
  };
  attribution("PR body", pr.body, pr.html_url);
  for (const c of pr.commits) attribution(c.sha.slice(0, 7), c.message, `${pr.html_url}/commits/${c.sha}`);
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
    ...issues.filter((c) => !c.remove).map((c) => `- where: ${c.where} | subject: ${c.subject}`),
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
  "To fix: reword each commit with `git rebase -i`, then `git push --force-with-lease`. Edit the PR title and body on GitHub.";

export function commitsAgentText(pr: Pr, issues: CommitIssue[]): string {
  const to = (c: CommitIssue) => (c.suggested ? `"${c.suggested}"` : "a subject of the form type(scope): description");
  const commits = issues.filter((c) => c.where !== "PR title" && c.where !== "PR body");
  const title = issues.find((c) => c.where === "PR title");
  const body = issues.find((c) => c.where === "PR body");
  return [
    `Fix the commit messages on branch ${pr.head_ref} of ${pr.head_repo} (${pr.html_url}).`,
    "Change only the messages. Do not change the code.",
    ...commits.map((c) =>
      c.remove
        ? `${c.where}: delete these lines from the message: ${c.remove.map((l) => `"${l}"`).join(", ")}`
        : `${c.where}: "${c.subject}" -> ${to(c)}`,
    ),
    commits.length && `Run \`git rebase -i ${pr.base.slice(0, 7)}\` and mark each listed commit \`reword\`.`,
    title && `Set the pull request title to ${to(title)}.`,
    body && `Delete these lines from the pull request description: ${body.remove?.map((l) => `"${l}"`).join(", ")}.`,
    commits.length && "Do not push. Tell the user to run `git push --force-with-lease`.",
  ]
    .filter(Boolean)
    .join("\n");
}
