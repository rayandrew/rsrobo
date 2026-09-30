import { execFileSync } from "node:child_process";
import { commentableLines, inDiff } from "./diff.ts";
import type { Pr } from "./github.ts";
import { type Finding, type Result, render } from "./review.ts";

export type PostMode = "pending" | "inbox" | "comment";

const MARKER = (pr: Pr) => `<!-- rsrobo ${pr.owner}/${pr.repo}#${pr.number} -->`;

// GH_TOKEN selects the identity: my token for pending reviews and the inbox, the bot token for public comments.
function gh(token: string, args: string[], input?: unknown): unknown {
  const flags = input ? ["--input", "-"] : [];
  const out = execFileSync("gh", ["api", ...flags, ...args], {
    encoding: "utf8",
    input: input ? JSON.stringify(input) : undefined,
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 16 << 20,
  });
  return out ? JSON.parse(out) : null;
}

// Pending review under my account: inline comments for findings inside the diff, the rest in the body.
export function postPending(pr: Pr, r: Result, patch: string, token: string, minSeverity = "P3"): string {
  const base = `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`;
  const mine = (gh(token, [base]) as { id: number; state: string; user: { login: string } }[]).filter(
    (v) => v.state === "PENDING",
  );
  for (const v of mine) gh(token, ["-X", "DELETE", `${base}/${v.id}`]);

  const lines = commentableLines(patch);
  const shown = r.findings.filter((f) => f.severity <= minSeverity);
  const inline = shown.filter((f) => inDiff(lines, f.file, f.line_start, f.line_end));
  const rest = shown.filter((f) => !inline.includes(f));
  const comments = inline.map((f) => ({
    path: f.file,
    line: f.line_end,
    side: "RIGHT",
    ...(f.line_end > f.line_start ? { start_line: f.line_start, start_side: "RIGHT" } : {}),
    body: findingBody(f),
  }));
  const body = render(pr, { ...r, findings: rest });
  const res = gh(token, ["-X", "POST", base], { commit_id: pr.head, body, comments }) as { html_url: string };
  return res.html_url;
}

// One open issue per PR in the private notes repo, body replaced on every run; closing it archives that PR.
// ponytail: the issue list can lag a few seconds after a create, so two runs seconds apart may make a duplicate.
export function postInbox(pr: Pr, r: Result, token: string, inboxRepo: string): string {
  const title = `${pr.owner}/${pr.repo}#${pr.number}: ${pr.title}`;
  const body = `${MARKER(pr)}\n${pr.html_url}\n\n${render(pr, r)}`;
  const open = gh(token, ["--paginate", `repos/${inboxRepo}/issues?labels=rsrobo&state=open&per_page=100`]) as {
    number: number;
    body: string;
    html_url: string;
  }[];
  const mine = open.find((i) => i.body?.startsWith(MARKER(pr)));
  if (mine) {
    gh(token, ["-X", "PATCH", `repos/${inboxRepo}/issues/${mine.number}`], { title, body });
    return mine.html_url;
  }
  const res = gh(token, ["-X", "POST", `repos/${inboxRepo}/issues`], { title, body, labels: ["rsrobo"] }) as {
    html_url: string;
  };
  return res.html_url;
}

// One sticky public comment as the bot, edited in place.
export function postComment(pr: Pr, r: Result, token: string, botLogin: string): string {
  const base = `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`;
  const body = `${MARKER(pr)}\n${render(pr, r)}\n\n<sub>AI-generated review, requested by the PR reviewer.</sub>`;
  const all = gh(token, ["--paginate", base]) as {
    id: number;
    body: string;
    user: { login: string };
    html_url: string;
  }[];
  const mine = all.find((c) => c.user.login === botLogin && c.body.startsWith(MARKER(pr)));
  if (mine) {
    gh(token, ["-X", "PATCH", `repos/${pr.owner}/${pr.repo}/issues/comments/${mine.id}`], { body });
    return mine.html_url;
  }
  const res = gh(token, ["-X", "POST", base], { body }) as { html_url: string };
  return res.html_url;
}

function findingBody(f: Finding): string {
  const patch = f.suggested_patch ? `\n\n\`\`\`diff\n${f.suggested_patch.trim()}\n\`\`\`` : "";
  return `**${f.severity} · ${f.title}**\n\n${f.body}${patch}`;
}
