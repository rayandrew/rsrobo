import assert from "node:assert/strict";
import { test } from "node:test";
import { commentableLines, inDiff, parseHunks } from "../src/diff.ts";

const patch = `diff --git a/x.py b/x.py
--- a/x.py
+++ b/x.py
@@ -1,3 +1,4 @@
 a
+b
 c
-d
+e
@@ -10,2 +11,2 @@
 k
+l
diff --git a/new.py b/new.py
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+one
+two
`;

test("hunk lines on the right side", () => {
  const m = commentableLines(patch);
  assert.deepEqual([...(m.get("x.py") ?? [])], [1, 2, 3, 4, 11, 12]);
  assert.deepEqual([...(m.get("new.py") ?? [])], [1, 2]);
  assert.ok(inDiff(m, "x.py", 2, 4));
  assert.ok(!inDiff(m, "x.py", 4, 11));
  assert.ok(!inDiff(m, "missing.py", 1, 1));
});

test("parseHunks reads old range and new text", () => {
  const fix = `--- a/x.py
+++ b/x.py
@@ -2,3 +2,3 @@
 b
-c
+C
 e
@@ -11,0 +12,1 @@
+new
`;
  const h = parseHunks(fix);
  assert.deepEqual(h[0], { file: "x.py", oldStart: 2, oldCount: 3, newLines: ["b", "C", "e"] });
  assert.deepEqual(h[1], { file: "x.py", oldStart: 11, oldCount: 0, newLines: ["new"] });
});
