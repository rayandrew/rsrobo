import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneKb, sensitivity } from "../src/kb.ts";

test("pruneKb keeps allowed lessons and honors folder inheritance", () => {
  const root = mkdtempSync(join(tmpdir(), "kb-"));
  mkdirSync(join(root, "projects", "pub", "t"), { recursive: true });
  mkdirSync(join(root, "general", "x"), { recursive: true });
  writeFileSync(join(root, "projects", "pub", "README.md"), "---\nlabels:\n  sensitivity: public\n---\n# pub\n");
  writeFileSync(join(root, "projects", "pub", "t", "a.md"), "---\nid: a\n---\n# a\n");
  writeFileSync(
    join(root, "projects", "pub", "t", "b.md"),
    "---\nid: b\nlabels:\n  sensitivity: confidential\n---\n# b\n",
  );
  writeFileSync(join(root, "general", "x", "c.md"), "---\nid: c\n---\n# c\n");
  assert.equal(sensitivity(root, "projects/pub/t/a.md"), "public");
  assert.equal(sensitivity(root, "general/x/c.md"), "internal");
  assert.deepEqual(pruneKb(root, ["public"]), { kept: 1, removed: 2 });
  assert.deepEqual(readdirSync(join(root, "projects", "pub", "t")), ["a.md"]);
  assert.deepEqual(readdirSync(join(root, "general", "x")), []);
});
