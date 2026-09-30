import assert from "node:assert/strict";
import { test } from "node:test";
import { type Env, poll } from "../src/index.ts";

// A fake GitHub: records every request, answers from a small table, so poll() runs without the network.
function fakeGitHub(comments: { id: number; body: string; user: { login: string } }[]) {
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
          reason: "mention",
          updated_at: "2026-09-30T00:00:00Z",
          subject: { type: "PullRequest", url: pr, latest_comment_url: `${pr}/comment/${comments.at(-1)?.id}` },
          repository: { full_name: "o/r" },
        },
      ]);
    }
    if (url.includes("/comment/")) return json(comments.find((c) => url.endsWith(`/${c.id}`)));
    if (url.endsWith("/issues/7/comments?per_page=100")) return json(comments);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return calls;
}

const seen = new Map<string, string>();
const env: Env = {
  SEEN: {
    get: async (k: string) => seen.get(k) ?? null,
    put: async (k: string, v: string) => void seen.set(k, v),
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
  assert.match(
    bodyOf((x) => x.method === "POST" && x.url.endsWith("/issues/7/comments")),
    /Only @me can start a run/,
  );
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
