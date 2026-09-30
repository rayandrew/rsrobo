import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/commands.ts";

const bot = "rsrobo";

test("plain review", () => {
  assert.deepEqual(parseCommand("@rsrobo review", bot), { task: "review", args: {}, text: "" });
});

test("keys and free text", () => {
  const s = parseCommand("hey\n@rsrobo review model=sonnet focus=security,io check MPI buffers in io/", bot);
  assert.equal(s?.args.model, "sonnet");
  assert.equal(s?.args.focus, "security,io");
  assert.equal(s?.text, "check MPI buffers in io/");
});

test("no mention", () => {
  assert.equal(parseCommand("nothing here", bot), null);
});

test("rejects unknown key, url, path escape, unknown task", () => {
  assert.throws(() => parseCommand("@rsrobo review base_url=x", bot), /unknown key/);
  assert.throws(() => parseCommand("@rsrobo review model=https://evil", bot), /bad value/);
  assert.throws(() => parseCommand("@rsrobo review files=../../etc", bot), /bad value/);
  assert.throws(() => parseCommand("@rsrobo deploy", bot), /unknown task/);
});

test("provider/model values pass, including openrouter tilde aliases", () => {
  assert.equal(
    parseCommand("@rsrobo review model=openrouter/~google/gemini-pro-latest", bot)?.args.model,
    "openrouter/~google/gemini-pro-latest",
  );
  assert.equal(
    parseCommand("@rsrobo review model=freeinference/kimi-k2.7-code", bot)?.args.model,
    "freeinference/kimi-k2.7-code",
  );
});

test("approve is a task", () => {
  assert.equal(parseCommand("@rsrobo approve", bot)?.task, "approve");
});
