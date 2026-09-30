import { parseCommand } from "../../src/commands.ts";

export type Env = {
  SEEN: KVNamespace;
  BOT_TOKEN: string;
  USER_TOKEN: string;
  BOT_LOGIN: string;
  HUB_REPO: string;
  HUB_REF: string;
  INBOX_REPO: string;
  ALLOWED_COMMENTERS: string;
  ALLOWED_REPOS: string;
};

type Notification = {
  id: string;
  reason: string;
  updated_at: string;
  subject: { type: string; url: string; latest_comment_url: string | null };
  repository: { full_name: string };
};

type Comment = { id: number; body: string; html_url: string; user: { login: string } };

const SEEN_TTL = 60 * 60 * 24 * 30;

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(poll(env));
  },
};

export async function poll(env: Env) {
  const notes = (await gh(env.BOT_TOKEN, "/notifications?participating=true")) as Notification[];
  for (const n of notes) {
    // Issues take only `ask`; the rest needs a pull request. handle() sorts that out.
    if (n.subject.type !== "PullRequest" && n.subject.type !== "Issue") continue;
    if (n.reason === "mention") {
      const comment = await findMention(env, n);
      if (comment && !(await env.SEEN.get(`comment:${comment.id}`))) {
        await handle(env, n, comment);
        await env.SEEN.put(`comment:${comment.id}`, "1", { expirationTtl: SEEN_TTL });
      }
    } else if (n.reason === "review_requested") {
      // A review request from the PR page (own repos only; the bot must be a collaborator) means `review` with defaults.
      const key = `request:${n.subject.url}:${n.updated_at}`;
      if (
        !(await env.SEEN.get(key)) &&
        env.ALLOWED_REPOS.split(",").some((g) => glob(g, n.repository.full_name)) &&
        (await requestedByAllowed(env, n))
      ) {
        await dispatch(env, { repo: n.repository.full_name, pr: String(n.subject.url.split("/").pop()) });
      }
      await env.SEEN.put(key, "1", { expirationTtl: SEEN_TTL });
    } else continue;
    await gh(env.BOT_TOKEN, `/notifications/threads/${n.id}`, "PATCH");
  }
}

// The latest comment is usually the mention. If not, look at comments since the thread changed.
async function findMention(env: Env, n: Notification): Promise<Comment | null> {
  const mention = new RegExp(`@${env.BOT_LOGIN}\\b`, "i");
  if (n.subject.latest_comment_url) {
    const c = (await gh(env.BOT_TOKEN, n.subject.latest_comment_url)) as Comment;
    if (mention.test(c.body)) return c;
  }
  const since = new Date(Date.parse(n.updated_at) - 10 * 60 * 1000).toISOString();
  const prUrl = n.subject.url.replace("/pulls/", "/issues/");
  const recent = (await gh(env.BOT_TOKEN, `${prUrl}/comments?since=${since}`)) as Comment[];
  return recent.reverse().find((c) => mention.test(c.body)) ?? null;
}

// The notification does not say who asked; the PR timeline does. Only an allowed commenter may request the bot.
async function requestedByAllowed(env: Env, n: Notification): Promise<boolean> {
  const url = `${n.subject.url.replace("/pulls/", "/issues/")}/timeline?per_page=100`;
  const events = (await gh(env.BOT_TOKEN, url)) as {
    event: string;
    review_requester?: { login: string };
    requested_reviewer?: { login: string };
  }[];
  const last = events
    .filter((e) => e.event === "review_requested" && e.requested_reviewer?.login === env.BOT_LOGIN)
    .pop();
  const ok = !!last && env.ALLOWED_COMMENTERS.split(",").includes(last.review_requester?.login ?? "");
  if (last && !ok) {
    const repo = n.repository.full_name;
    const pr = n.subject.url.split("/").pop();
    await inbox(
      env,
      `rsrobo: review request from @${last.review_requester?.login} on ${repo}#${pr}`,
      `https://github.com/${repo}/pull/${pr}\n\nTo run it, comment \`@${env.BOT_LOGIN} review\` on the PR.`,
    );
  }
  return ok;
}

async function handle(env: Env, n: Notification, c: Comment) {
  const repo = n.repository.full_name;
  const pr = n.subject.url.split("/").pop();
  // Someone else asked: say so once on the PR, and put the request in my inbox with the command to approve it.
  if (!env.ALLOWED_COMMENTERS.split(",").includes(c.user.login)) {
    const command = c.body
      .slice(c.body.search(new RegExp(`@${env.BOT_LOGIN}`, "i")))
      .split("\n")[0]
      .trim();
    await gh(env.BOT_TOKEN, `${n.subject.url.replace("/pulls/", "/issues/")}/comments`, "POST", {
      body: `Thanks @${c.user.login}. Only @${env.ALLOWED_COMMENTERS.split(",")[0]} can start a run of this bot; they have been notified and can approve it.`,
    });
    await inbox(
      env,
      `rsrobo: request from @${c.user.login} on ${repo}#${pr}`,
      `${c.html_url}\n\nThey wrote:\n\n> ${command}\n\nTo run it, comment this on the PR:\n\n\`\`\`\n${command}\n\`\`\``,
    );
    return;
  }
  if (!env.ALLOWED_REPOS.split(",").some((g) => glob(g, repo))) return;

  let spec: ReturnType<typeof parseCommand>;
  try {
    spec = parseCommand(c.body, env.BOT_LOGIN);
  } catch (e) {
    await inbox(env, `rsrobo: bad command on ${repo}#${pr}`, `${c.html_url}\n\n${(e as Error).message}`);
    return;
  }
  if (!spec) return;
  // `approve [key=value ...]`: run the most recent request someone else made on this PR. My keys replace theirs,
  // so `approve model=sonnet effort=medium` caps what they asked for.
  if (spec.task === "approve") {
    const all = (await gh(
      env.BOT_TOKEN,
      `${n.subject.url.replace("/pulls/", "/issues/")}/comments?per_page=100`,
    )) as Comment[];
    const mention = new RegExp(`@${env.BOT_LOGIN}\\b`, "i");
    const theirs = all
      .filter((x) => x.id < c.id && mention.test(x.body) && !env.ALLOWED_COMMENTERS.split(",").includes(x.user.login))
      .pop();
    let want: ReturnType<typeof parseCommand> = null;
    try {
      want = theirs ? parseCommand(theirs.body, env.BOT_LOGIN) : null;
    } catch (e) {
      await inbox(env, `rsrobo: cannot approve on ${repo}#${pr}`, `${theirs?.html_url}\n\n${(e as Error).message}`);
      return;
    }
    if (!want) {
      await inbox(
        env,
        `rsrobo: nothing to approve on ${repo}#${pr}`,
        `${c.html_url}\n\nNo request from someone else was found.`,
      );
      return;
    }
    await run(env, n, c, { ...want, args: { ...want.args, ...spec.args } });
    return;
  }
  await run(env, n, c, spec);
}

async function run(env: Env, n: Notification, c: Comment, spec: NonNullable<ReturnType<typeof parseCommand>>) {
  const repo = n.repository.full_name;
  const pr = n.subject.url.split("/").pop();
  if (spec.task === "fix") {
    if (!/^(all|\d+(,\d+)*)$/.test(spec.text)) {
      await inbox(env, `rsrobo: bad fix command on ${repo}#${pr}`, `${c.html_url}\n\nUse \`fix 2,3\` or \`fix all\`.`);
      return;
    }
    const inputs: Record<string, string> = { repo, pr: String(pr), task: "fix", findings: spec.text };
    for (const k of ["model", "budget", "via", "platform"]) if (spec.args[k]) inputs[k] = spec.args[k];
    await dispatch(env, inputs);
    return;
  }
  if (spec.task === "ask") {
    if (!spec.text) {
      await inbox(env, `rsrobo: empty question on ${repo}#${pr}`, `${c.html_url}\n\nWrite the question after \`ask\`.`);
      return;
    }
    const inputs: Record<string, string> = {
      repo,
      pr: String(pr),
      task: "ask",
      question: spec.text,
      requester: c.user.login,
    };
    if (spec.args.model) inputs.model = spec.args.model;
    await dispatch(env, inputs);
    return;
  }
  if (n.subject.type === "Issue") {
    await inbox(env, `rsrobo: ${spec.task} needs a pull request`, `${c.html_url}\n\nOn an issue only \`ask\` works.`);
    return;
  }
  if (spec.task === "init-notes") {
    await dispatch(env, { repo, pr: String(pr), task: "init-notes" });
    return;
  }
  if (spec.task !== "review") {
    await inbox(
      env,
      `rsrobo: unsupported task on ${repo}#${pr}`,
      `${c.html_url}\n\n\`${spec.task}\` is not implemented yet.`,
    );
    return;
  }
  const inputs: Record<string, string> = { repo, pr: String(pr), requester: c.user.login };
  for (const k of ["post", "model", "budget", "focus", "effort"]) if (spec.args[k]) inputs[k] = spec.args[k];
  if (spec.text) inputs.focus = [inputs.focus, spec.text].filter(Boolean).join("; ");
  await dispatch(env, inputs);
}

async function dispatch(env: Env, inputs: Record<string, string>) {
  await gh(env.USER_TOKEN, `/repos/${env.HUB_REPO}/actions/workflows/review.yml/dispatches`, "POST", {
    ref: env.HUB_REF,
    inputs,
  });
}

async function inbox(env: Env, title: string, body: string) {
  await gh(env.USER_TOKEN, `/repos/${env.INBOX_REPO}/issues`, "POST", { title, body, labels: ["rsrobo"] });
}

async function gh(token: string, path: string, method = "GET", body?: unknown): Promise<unknown> {
  const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `token ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "rsrobo-poller",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 205 ? null : res.json();
}

const glob = (pattern: string, s: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`).test(s);
