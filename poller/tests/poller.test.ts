import assert from "node:assert/strict";
import { test } from "node:test";
import { type Env, poll } from "../src/index.ts";

// A fake GitHub: records every request, answers from a small table, so poll() runs without the network.
function fakeGitHub(
  comments: { id: number; body: string; user: { login: string }; html_url?: string }[],
  type = "PullRequest",
  opts: { reason?: string; requester?: string; state?: string; head?: string } = {},
) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const pr = "https://api.github.com/repos/o/r/pulls/7";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.endsWith("/notifications?participating=true")) {
      return json([
        {
          id: "1",
          reason: opts.reason ?? "mention",
          updated_at: "2026-09-30T00:00:00Z",
          subject: { type, url: pr, latest_comment_url: `${pr}/comment/${comments.at(-1)?.id}` },
          repository: { full_name: "o/r" },
        },
      ]);
    }
    if (url.includes("/comment/")) return json(comments.find((c) => url.endsWith(`/${c.id}`)));
    if (url.endsWith("/issues/7/comments?per_page=100")) return json(comments);
    if (url.endsWith("/issues/7/timeline?per_page=100"))
      return json([
        {
          event: "review_requested",
          requested_reviewer: { login: "rsrobo" },
          review_requester: { login: opts.requester },
        },
      ]);
    if (url === pr) return json({ state: opts.state ?? "open", head: { sha: opts.head ?? "h1" } });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return calls;
}

const seen = new Map<string, string>();
const env: Env = {
  SEEN: {
    get: async (k: string) => seen.get(k) ?? null,
    put: async (k: string, v: string) => void seen.set(k, v),
    delete: async (k: string) => void seen.delete(k),
  } as unknown as KVNamespace,
  BOT_TOKEN: "b",
  USER_TOKEN: "u",
  BOT_LOGIN: "rsrobo",
  HUB_REPO: "me/hub",
  HUB_REF: "trunk",
  INBOX_REPO: "me/notes",
  ALLOWED_COMMENTERS: "me",
  ALLOWED_REPOS: "*/*",
};
const watched = () => (JSON.parse(seen.get("watches") ?? "{}") as Record<string, { head: string }>)["o/r#7"];
const dispatches = (calls: { url: string; body?: unknown }[]) =>
  calls.filter((c) => c.url.endsWith("/dispatches")).map((c) => (c.body as { inputs: unknown }).inputs);

test("my mention dispatches the workflow with the parsed keys", async () => {
  seen.clear();
  const c = [
    { id: 1, body: "@rsrobo review model=luna effort=medium look at io/", user: { login: "me" }, html_url: "" },
  ];
  const calls = fakeGitHub(c);
  await poll(env);
  assert.deepEqual(dispatches(calls), [
    { repo: "o/r", pr: "7", requester: "me", model: "luna", effort: "medium", focus: "look at io/" },
  ]);
  assert.ok(calls.some((x) => x.method === "PATCH" && x.url.endsWith("/notifications/threads/1")));
  await poll(env);
  assert.equal(dispatches(calls).length, 1, "a seen comment does not run twice");
});

test("someone else's mention gets a reply and an inbox issue, no run", async () => {
  seen.clear();
  const c = [{ id: 2, body: "@rsrobo review model=opus", user: { login: "stranger" }, html_url: "https://x/2" }];
  const calls = fakeGitHub(c);
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  const bodyOf = (pred: (x: { method: string; url: string }) => boolean) => {
    const hit = calls.find(pred);
    if (!hit) throw new Error("request not made");
    return (hit.body as { body: string }).body;
  };
  const reply = bodyOf((x) => x.method === "POST" && x.url.endsWith("/issues/7/comments"));
  assert.match(reply, /Only @me can start a run of this bot, for the first review and for every later one/);
  assert.match(reply, /\| @me \| `@rsrobo approve all` \| runs this request and trusts @stranger on this PR/);
  assert.match(reply, /\| anyone \| .*re-request review \| asks for a run; @me is notified/);
  assert.match(
    bodyOf((x) => x.method === "POST" && x.url.endsWith("/repos/me/notes/issues")),
    /@rsrobo review model=opus/,
  );
});

test("approve runs their request with my overrides", async () => {
  seen.clear();
  const c = [
    { id: 3, body: "@rsrobo review model=opus effort=high focus=security", user: { login: "stranger" }, html_url: "" },
    { id: 4, body: "@rsrobo approve model=sonnet effort=medium", user: { login: "me" }, html_url: "" },
  ];
  const calls = fakeGitHub(c);
  await poll(env);
  assert.deepEqual(dispatches(calls), [
    { repo: "o/r", pr: "7", requester: "me", model: "sonnet", effort: "medium", focus: "security" },
  ]);
});

test("ask on an issue dispatches the question; review on an issue goes to the inbox", async () => {
  seen.clear();
  let calls = fakeGitHub(
    [{ id: 5, body: "@rsrobo ask is retry implemented?", user: { login: "me" }, html_url: "" }],
    "Issue",
  );
  await poll(env);
  assert.deepEqual(dispatches(calls), [
    { repo: "o/r", pr: "7", task: "ask", question: "is retry implemented?", requester: "me" },
  ]);
  seen.clear();
  calls = fakeGitHub([{ id: 6, body: "@rsrobo review", user: { login: "me" }, html_url: "" }], "Issue");
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  assert.ok(calls.some((x) => x.url.endsWith("/repos/me/notes/issues")));
});

test("a stranger's ask on an issue waits for my approve; no model runs before", async () => {
  seen.clear();
  const c = [
    { id: 7, body: "@rsrobo ask is this implemented?", user: { login: "stranger" }, html_url: "https://x/7" },
    { id: 8, body: "@rsrobo approve model=haiku", user: { login: "me" }, html_url: "" },
  ];
  const calls = fakeGitHub(c, "Issue");
  await poll(env);
  assert.deepEqual(dispatches(calls), [
    { repo: "o/r", pr: "7", task: "ask", question: "is this implemented?", requester: "me", model: "haiku" },
  ]);
});

test("summarize and triage dispatch as their own tasks", async () => {
  seen.clear();
  const calls = fakeGitHub([{ id: 9, body: "@rsrobo triage", user: { login: "me" }, html_url: "" }], "Issue");
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", task: "triage", requester: "me" }]);
});

test("assess start is a pending review; assess finish and publish dispatch publish", async () => {
  seen.clear();
  let calls = fakeGitHub([{ id: 10, body: "@rsrobo assess start effort=medium", user: { login: "me" }, html_url: "" }]);
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", post: "pending", requester: "me", effort: "medium" }]);
  seen.clear();
  calls = fakeGitHub([{ id: 11, body: "@rsrobo assess finish", user: { login: "me" }, html_url: "" }]);
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", task: "publish", requester: "me" }]);
});

test("approve all trusts the requester on this PR; revoke takes it back; a closed PR ends it", async () => {
  seen.clear();
  let calls = fakeGitHub([
    { id: 20, body: "@rsrobo review", user: { login: "stranger" }, html_url: "https://x/20" },
    { id: 21, body: "@rsrobo approve all model=sonnet", user: { login: "me" }, html_url: "" },
  ]);
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", requester: "me", model: "sonnet" }]);
  assert.ok(seen.has("trust:o/r#7:stranger"));
  // Trusted: their next request runs as them, with no reply and no inbox issue.
  calls = fakeGitHub([{ id: 22, body: "@rsrobo review effort=medium", user: { login: "stranger" }, html_url: "" }]);
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", requester: "stranger", effort: "medium" }]);
  assert.ok(!calls.some((x) => x.method === "POST" && x.url.endsWith("/issues/7/comments")));
  // Another person on the same PR still waits.
  calls = fakeGitHub([{ id: 23, body: "@rsrobo review", user: { login: "other" }, html_url: "https://x/23" }]);
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  // A closed PR ends the trust.
  calls = fakeGitHub([{ id: 24, body: "@rsrobo review", user: { login: "stranger" }, html_url: "" }], "PullRequest", {
    state: "closed",
  });
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  // revoke
  calls = fakeGitHub([{ id: 25, body: "@rsrobo revoke user=stranger", user: { login: "me" }, html_url: "" }]);
  await poll(env);
  assert.ok(!seen.has("trust:o/r#7:stranger"));
  calls = fakeGitHub([{ id: 26, body: "@rsrobo review", user: { login: "stranger" }, html_url: "https://x/26" }]);
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
});

test("a review request from someone else waits for me; mine runs; approve with nothing waiting means review", async () => {
  seen.clear();
  let calls = fakeGitHub([], "PullRequest", { reason: "review_requested", requester: "stranger" });
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  assert.ok(calls.some((x) => x.method === "POST" && x.url.endsWith("/issues/7/comments")));
  assert.ok(calls.some((x) => x.method === "POST" && x.url.endsWith("/repos/me/notes/issues")));
  // approve runs the waiting request, a review, with my options.
  calls = fakeGitHub([{ id: 30, body: "@rsrobo approve budget=1", user: { login: "me" }, html_url: "" }]);
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", requester: "me", budget: "1" }]);
  // My own review request runs at once.
  seen.clear();
  calls = fakeGitHub([], "PullRequest", { reason: "review_requested", requester: "me" });
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", requester: "me" }]);
});

test("a second request on the same PR gets no second reply while the first waits", async () => {
  seen.clear();
  let calls = fakeGitHub([{ id: 40, body: "@rsrobo review", user: { login: "stranger" }, html_url: "https://x/40" }]);
  await poll(env);
  assert.equal(calls.filter((x) => x.method === "POST" && x.url.endsWith("/issues/7/comments")).length, 1);
  calls = fakeGitHub([{ id: 41, body: "@rsrobo fix 1", user: { login: "stranger" }, html_url: "https://x/41" }]);
  await poll(env);
  assert.equal(calls.filter((x) => x.method === "POST" && x.url.endsWith("/issues/7/comments")).length, 0);
  assert.equal(
    JSON.parse(seen.get("pending:o/r#7") ?? "{}").body,
    "@rsrobo fix 1",
    "the newest request is the one approve runs",
  );
});

test("approve watch reviews the PR again after each push, once per push, until it closes", async () => {
  seen.clear();
  let calls = fakeGitHub([
    { id: 50, body: "@rsrobo review", user: { login: "stranger" }, html_url: "https://x/50" },
    { id: 51, body: "@rsrobo approve watch", user: { login: "me" }, html_url: "" },
  ]);
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", requester: "me" }]);
  assert.equal(watched().head, "h1");
  // Same head: nothing. The stranger's own request still waits.
  calls = fakeGitHub([{ id: 52, body: "@rsrobo review", user: { login: "stranger" }, html_url: "https://x/52" }]);
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  // A push: one review, then quiet at that head.
  calls = fakeGitHub([], "PullRequest", { reason: "subscribed", head: "h2" });
  await poll(env);
  assert.deepEqual(dispatches(calls), [{ repo: "o/r", pr: "7", requester: "me" }]);
  calls = fakeGitHub([], "PullRequest", { reason: "subscribed", head: "h2" });
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  // Closed: the watch ends.
  calls = fakeGitHub([], "PullRequest", { reason: "subscribed", head: "h3", state: "closed" });
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  assert.ok(!watched());
});

test("watch and unwatch on their own; approve all watch does both", async () => {
  seen.clear();
  let calls = fakeGitHub([{ id: 60, body: "@rsrobo watch", user: { login: "me" }, html_url: "" }]);
  await poll(env);
  assert.equal(dispatches(calls).length, 0);
  assert.ok(watched());
  calls = fakeGitHub([{ id: 61, body: "@rsrobo unwatch", user: { login: "me" }, html_url: "" }]);
  await poll(env);
  assert.ok(!watched());
  calls = fakeGitHub([
    { id: 62, body: "@rsrobo review", user: { login: "stranger" }, html_url: "https://x/62" },
    { id: 63, body: "@rsrobo approve all watch", user: { login: "me" }, html_url: "" },
  ]);
  await poll(env);
  assert.equal(dispatches(calls).length, 1);
  assert.ok(watched());
  assert.ok(seen.has("trust:o/r#7:stranger"));
  // A stranger cannot watch.
  calls = fakeGitHub([{ id: 64, body: "@rsrobo watch", user: { login: "stranger" }, html_url: "https://x/64" }]);
  await poll(env);
  assert.ok(!calls.some((x) => x.url.endsWith("/dispatches")));
});
