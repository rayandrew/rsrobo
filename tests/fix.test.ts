import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestions } from "../src/fix.ts";

const prPatch = `--- a/x.py
+++ b/x.py
@@ -1,4 +1,5 @@
 a
+b
 c
 d
 e
`;

test("suggestions map fix hunks inside the PR diff and drop the rest", () => {
  const fixPatch = `--- a/x.py
+++ b/x.py
@@ -2,2 +2,2 @@
-b
+B
 c
@@ -40,1 +40,1 @@
-far
+away
`;
  const s = suggestions(prPatch, fixPatch);
  assert.equal(s.leftover, 1);
  assert.equal(s.comments.length, 1);
  assert.deepEqual(s.comments[0], {
    path: "x.py",
    start_line: 2,
    start_side: "RIGHT",
    line: 3,
    side: "RIGHT",
    body: "```suggestion\nB\nc\n```",
  });
});
