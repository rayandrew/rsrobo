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
// `approve all` and `watch` last this long at most on one PR; a closed PR ends them earlier.
const TRUST_TTL = 60 * 60 * 24 * 30;

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(poll(env).catch((e) => console.error(`poll failed: ${(e as Error).message}`)));
  },
};

export async function poll(env: Env) {
  await pollNotifications(env);
  await pollWatched(env);
}

// A watched PR gets an incremental review after every push. GitHub sends no notification for a push, so the
// poller reads each watched PR's head once a minute. The record holds the last head it dispatched for.
type Watch = { repo: string; pr: string; url: string; head: string };

async function pollWatched(env: Env) {
  const { keys } = await env.SEEN.list({ prefix: "watch:" });
  for (const k of keys) {
    const w = JSON.parse((await env.SEEN.get(k.name)) ?? "null") as Watch | null;
    if (!w) continue;
    let pr: { state: string; head: { sha: string } };
    try {
      pr = (await gh(env.BOT_TOKEN, w.url)) as typeof pr;
    } catch (e) {
      console.error(`watch ${k.name}: ${(e as Error).message}`);
      continue;
    }
    if (pr.state !== "open") {
      await env.SEEN.delete(k.name);
      console.log(`watch ended, PR closed: ${k.name}`);
      continue;
    }
    if (pr.head.sha === w.head) continue;
    console.log(`watch ${k.name}: new head ${pr.head.sha.slice(0, 7)}`);
    await env.SEEN.put(k.name, JSON.stringify({ ...w, head: pr.head.sha }), { expirationTtl: TRUST_TTL });
    await dispatch(env, { repo: w.repo, pr: w.pr, requester: owner(env) });
  }
}

async function pollNotifications(env: Env) {
  const notes = (await gh(env.BOT_TOKEN, "/notifications?participating=true")) as Notification[];
  console.log(
    `notifications: ${notes.length}${notes.map((n) => ` [${n.reason} ${n.subject.type} ${n.repository.full_name}]`).join("")}`,
  );
  for (const n of notes) {
    // Issues take only `ask`; the rest needs a pull request. handle() sorts that out.
    if (n.subject.type !== "PullRequest" && n.subject.type !== "Issue") continue;
    if (n.reason === "mention") {
      const comment = await findMention(env, n);
      console.log(`mention on ${n.subject.url}: comment ${comment?.id ?? "none"} by ${comment?.user.login ?? "-"}`);
      if (comment && !(await env.SEEN.get(`comment:${comment.id}`))) {
        await handle(env, n, comment);
        await env.SEEN.put(`comment:${comment.id}`, "1", { expirationTtl: SEEN_TTL });
      }
    } else if (n.reason === "review_requested") {
      const key = `request:${n.subject.url}:${n.updated_at}`;
      if (!(await env.SEEN.get(key)) && env.ALLOWED_REPOS.split(",").some((g) => glob(g, n.repository.full_name))) {
        await handleRequest(env, n);
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

const owners = (env: Env) => env.ALLOWED_COMMENTERS.split(",");
const owner = (env: Env) => owners(env)[0];
const issueUrl = (n: Notification) => n.subject.url.replace("/pulls/", "/issues/");
const prKey = (n: Notification) => `${n.repository.full_name}#${n.subject.url.split("/").pop()}`;

// Someone I trusted with `approve all` on this PR, while the PR is open.
async function trusted(env: Env, n: Notification, login: string): Promise<boolean> {
  if (!(await env.SEEN.get(`trust:${prKey(n)}:${login}`))) return false;
  const pr = (await gh(env.BOT_TOKEN, n.subject.url)) as { state?: string };
  return pr.state === "open";
}

// A request from someone else that waits for me: who asked and what, so `approve` can run it.
type Pending = { login: string; body: string; html_url: string };

// A review request from the PR page. The notification does not say who asked; the PR timeline does.
async function handleRequest(env: Env, n: Notification) {
  const events = (await gh(env.BOT_TOKEN, `${issueUrl(n)}/timeline?per_page=100`)) as {
    event: string;
    review_requester?: { login: string };
    requested_reviewer?: { login: string };
  }[];
  const last = events
    .filter((e) => e.event === "review_requested" && e.requested_reviewer?.login === env.BOT_LOGIN)
    .pop();
  const login = last?.review_requester?.login;
  console.log(`review request on ${n.subject.url} by ${login ?? "-"}`);
  if (!login) return;
  const repo = n.repository.full_name;
  const pr = String(n.subject.url.split("/").pop());
  if (owners(env).includes(login) || (await trusted(env, n, login))) {
    await dispatch(env, { repo, pr, requester: login });
    return;
  }
  await waitForMe(env, n, {
    login,
    body: `@${env.BOT_LOGIN} review`,
    html_url: `https://github.com/${repo}/pull/${pr}`,
  });
}

// Reply once on the PR, with the commands each side can use, and put the request in my inbox.
// The @mention of me in the reply is what notifies me; an issue my own token opens does not.
async function waitForMe(env: Env, n: Notification, p: Pending) {
  await env.SEEN.put(`pending:${prKey(n)}`, JSON.stringify(p), { expirationTtl: SEEN_TTL });
  const me = owner(env);
  const bot = env.BOT_LOGIN;
  if (await env.SEEN.get(`waiting:${prKey(n)}`)) {
    console.log(`request by ${p.login} on ${prKey(n)} replaces the waiting one; no second reply`);
    return;
  }
  const reply = [
    `Thanks @${p.login}. Only @${me} can start a run of this bot, for the first review and for every later one. They have been notified.`,
    "",
    "| Who | Comment | What happens |",
    "|---|---|---|",
    `| @${me} | \`@${bot} approve\` | runs this request as asked |`,
    `| @${me} | \`@${bot} approve model=haiku budget=1\` | runs it with changed options |`,
    `| @${me} | \`@${bot} approve all\` | runs this request and trusts @${p.login} on this PR for later ones |`,
    `| @${me} | \`@${bot} approve watch\` | runs this request and reviews this PR again after every push |`,
    `| @${me} | \`@${bot} approve all watch\` | both |`,
    `| @${me} | \`@${bot} review\`, \`@${bot} assess start\`, \`@${bot} fix 2\`, \`@${bot} ask <question>\` | runs a command directly |`,
    `| anyone | \`@${bot} review\`, \`@${bot} fix 2\`, \`@${bot} ask <question>\`, or re-request review | asks for a run; @${me} is notified and decides |`,
    "",
    `Any later review on this PR also needs @${me}, unless they say \`approve all\` or \`approve watch\`.`,
  ].join("\n");
  try {
    await gh(env.BOT_TOKEN, `${issueUrl(n)}/comments`, "POST", { body: reply });
    await env.SEEN.put(`waiting:${prKey(n)}`, "1", { expirationTtl: SEEN_TTL });
  } catch (e) {
    console.error(`reply on ${prKey(n)} failed: ${(e as Error).message}`);
  }
  try {
    await inbox(
      env,
      `rsrobo: request from @${p.login} on ${prKey(n)}`,
      `${p.html_url}\n\nThey asked:\n\n> ${p.body}\n\nTo run it, comment on the PR:\n\n\`\`\`\n@${bot} approve\n\`\`\`\n\n\`@${bot} approve all\` also trusts @${p.login} on this PR. \`@${bot} revoke\` takes that back.`,
    );
  } catch (e) {
    console.error(`inbox for ${prKey(n)} failed: ${(e as Error).message}`);
  }
}

// The request that waits on this PR: the one `waitForMe` stored, or, when the poller never saw it (a comment
// from before a deploy, two comments in one poll), the latest mention by someone else before `c`.
async function waitingRequest(env: Env, n: Notification, c: Comment): Promise<Pending | null> {
  const stored = JSON.parse((await env.SEEN.get(`pending:${prKey(n)}`)) ?? "null") as Pending | null;
  if (stored) return stored;
  const all = (await gh(env.BOT_TOKEN, `${issueUrl(n)}/comments?per_page=100`)) as Comment[];
  const mention = new RegExp(`@${env.BOT_LOGIN}\\b`, "i");
  const theirs = all.filter((x) => x.id < c.id && mention.test(x.body) && !owners(env).includes(x.user.login)).pop();
  return theirs ? { login: theirs.user.login, body: theirs.body, html_url: theirs.html_url } : null;
}

// Start or stop the watch on a PR. The head stored is the current one, so the review that starts now does not
// count as a push; the first new push does.
async function watch(env: Env, n: Notification, on: boolean) {
  const key = `watch:${prKey(n)}`;
  if (!on) {
    await env.SEEN.delete(key);
    console.log(`watch off: ${prKey(n)}`);
    return;
  }
  const pr = (await gh(env.BOT_TOKEN, n.subject.url)) as { head: { sha: string } };
  const w: Watch = {
    repo: n.repository.full_name,
    pr: String(n.subject.url.split("/").pop()),
    url: n.subject.url,
    head: pr.head.sha,
  };
  await env.SEEN.put(key, JSON.stringify(w), { expirationTtl: TRUST_TTL });
  console.log(`watch on: ${prKey(n)} at ${w.head.slice(0, 7)}`);
}

async function handle(env: Env, n: Notification, c: Comment) {
  const repo = n.repository.full_name;
  const pr = n.subject.url.split("/").pop();
  if (!env.ALLOWED_REPOS.split(",").some((g) => glob(g, repo))) return;
  const mine = owners(env).includes(c.user.login);
  if (!mine && !(await trusted(env, n, c.user.login))) {
    const command = c.body
      .slice(c.body.search(new RegExp(`@${env.BOT_LOGIN}`, "i")))
      .split("\n")[0]
      .trim();
    await waitForMe(env, n, { login: c.user.login, body: command, html_url: c.html_url });
    return;
  }

  let spec: ReturnType<typeof parseCommand>;
  try {
    spec = parseCommand(c.body, env.BOT_LOGIN);
  } catch (e) {
    await inbox(env, `rsrobo: bad command on ${repo}#${pr}`, `${c.html_url}\n\n${(e as Error).message}`);
    return;
  }
  if (!spec) return;
  if (!mine && ["approve", "revoke", "watch", "unwatch"].includes(spec.task)) {
    await inbox(
      env,
      `rsrobo: ${spec.task} by @${c.user.login} on ${repo}#${pr}`,
      `${c.html_url}\n\nOnly I can do that.`,
    );
    return;
  }
  // `watch` and `unwatch`: review this PR again after every push, or stop that.
  if (spec.task === "watch" || spec.task === "unwatch") {
    if (n.subject.type !== "PullRequest") {
      await inbox(env, `rsrobo: ${spec.task} needs a pull request`, c.html_url);
      return;
    }
    await watch(env, n, spec.task === "watch");
    return;
  }
  // `revoke [user=<login>]`: take back `approve all` for that person on this PR.
  if (spec.task === "revoke") {
    const pending = await waitingRequest(env, n, c);
    const who = spec.args.user ?? pending?.login;
    if (!who) {
      await inbox(env, `rsrobo: revoke on ${repo}#${pr} names nobody`, `${c.html_url}\n\nUse \`revoke user=<login>\`.`);
      return;
    }
    await env.SEEN.delete(`trust:${prKey(n)}:${who}`);
    console.log(`trust revoked for ${who} on ${prKey(n)}`);
    return;
  }
  // `approve [all] [user=<login>] [key=value ...]`: run the request that waits on this PR. My keys replace theirs,
  // so `approve model=sonnet effort=medium` caps what they asked for. `all` also trusts them here from now on.
  if (spec.task === "approve") {
    const pending = await waitingRequest(env, n, c);
    const who = spec.args.user ?? pending?.login;
    const words = spec.text.split(/\s+/);
    if (words.includes("all") && who) {
      await env.SEEN.put(`trust:${prKey(n)}:${who}`, "1", { expirationTtl: TRUST_TTL });
      console.log(`trust granted to ${who} on ${prKey(n)}`);
    }
    if (words.includes("watch")) await watch(env, n, true);
    const { user: _user, ...overrides } = spec.args;
    let want: ReturnType<typeof parseCommand> = null;
    try {
      want = pending ? parseCommand(pending.body, env.BOT_LOGIN) : null;
    } catch (e) {
      await inbox(env, `rsrobo: cannot approve on ${repo}#${pr}`, `${pending?.html_url}\n\n${(e as Error).message}`);
      return;
    }
    await env.SEEN.delete(`pending:${prKey(n)}`);
    await env.SEEN.delete(`waiting:${prKey(n)}`);
    await run(
      env,
      n,
      c,
      want ? { ...want, args: { ...want.args, ...overrides } } : { task: "review", args: overrides, text: "" },
    );
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
    const inputs: Record<string, string> = {
      repo,
      pr: String(pr),
      task: "fix",
      findings: spec.text,
      requester: c.user.login,
    };
    for (const k of ["model", "budget", "via", "platform", "as"]) if (spec.args[k]) inputs[k] = spec.args[k];
    await dispatch(env, inputs);
    return;
  }
  // `assess start` is a review that stays a private draft under my name; `assess finish` publishes that draft as the bot.
  if (spec.task === "assess") {
    const phase = spec.text.split(/\s+/)[0] || "start";
    if (phase === "finish") {
      await dispatch(env, { repo, pr: String(pr), task: "publish", requester: c.user.login });
      return;
    }
    if (phase !== "start") {
      await inbox(
        env,
        `rsrobo: bad assess command on ${repo}#${pr}`,
        `${c.html_url}\n\nUse \`assess start\` or \`assess finish\`.`,
      );
      return;
    }
    const inputs: Record<string, string> = { repo, pr: String(pr), post: "pending", requester: c.user.login };
    for (const k of ["model", "budget", "focus", "effort"]) if (spec.args[k]) inputs[k] = spec.args[k];
    const rest = spec.text.split(/\s+/).slice(1).join(" ");
    if (rest) inputs.focus = [inputs.focus, rest].filter(Boolean).join("; ");
    await dispatch(env, inputs);
    return;
  }
  if (spec.task === "publish") {
    await dispatch(env, { repo, pr: String(pr), task: "publish", requester: c.user.login });
    return;
  }
  if (spec.task === "summarize" || spec.task === "triage") {
    const inputs: Record<string, string> = { repo, pr: String(pr), task: spec.task, requester: c.user.login };
    if (spec.args.model) inputs.model = spec.args.model;
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
    await inbox(
      env,
      `rsrobo: ${spec.task} needs a pull request`,
      `${c.html_url}\n\nOn an issue only \`ask\`, \`triage\` and \`summarize\` work.`,
    );
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
  console.log(`dispatch: ${JSON.stringify(inputs)}`);
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
