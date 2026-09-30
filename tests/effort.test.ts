import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand } from "../src/commands.ts";

test("effort key and free text become workflow inputs", () => {
  const s = parseCommand("@rsrobo review effort=medium model=opus look at io/", "rsrobo");
  assert.equal(s?.args.effort, "medium");
  assert.equal(s?.args.model, "opus");
  assert.equal(s?.text, "look at io/");
});
