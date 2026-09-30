import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Pr } from "../src/github.ts";
import { type Result, render, saveReview } from "../src/review.ts";

const pr: Pr = {
  owner: "o",
  repo: "r",
  number: 7,
  title: "t",
  body: "",
  base: "b".repeat(40),
  head: "a".repeat(40),
  html_url: "https://github.com/o/r/pull/7",
  files: [],
};
const result: Result = {
  map: "One file.",
  changes: [{ area: "y.py", change: "adds a thing" }],
  skipped: ["gen.pb.go: generated"],
  findings: [
    {
      file: "x.py",
      line_start: 3,
      line_end: 4,
      severity: "P3",
      title: "minor",
      problem: "See `x.py:3-4`.",
      evidence: [],
      fix: "none",
    },
    {
      file: "y.py",
      line_start: 10,
      line_end: 12,
      severity: "P1",
      title: "wrong",
      problem: "w",
      evidence: ["`y.py:10` does a", "`y.py:12` does b"],
      fix: "swap them",
      suggested_patch: "--- a\n+++ b\n",
    },
  ],
  model: "claude-sonnet-5-5",
  effort: "high",
  cost_usd: 0.123,
  seconds: 9,
  files: 2,
};

test("render links, filters, and footer", () => {
  const md = render(pr, result, "P2");
  assert.match(
    md,
    /> \[!CAUTION\]\n> \*\*Needs changes\.\*\* 1 finding in 2 files\. `claude-sonnet-5-5` at high effort, \$0\.12, 0 min\./,
  );
  assert.match(md, /- \[`y\.py:10`\]\(https:[^)]+#L10-L10\) does a\n- \[`y\.py:12`\][^\n]*does b/);
  assert.match(md, /\| `y\.py` \| adds a thing \|/);
  assert.match(md, /Copy-paste text for an agent/);
  assert.match(md, /\| P1 \| \[y\.py:10-12\]\(https:\/\/github\.com\/o\/r\/blob\/a{40}\/y\.py#L10-L12\) \| wrong \|/);
  assert.doesNotMatch(md, /\*\*P3 minor\*\*/);
  assert.match(md, /<summary>Suggested fix<\/summary>[\s\S]*```diff\n--- a\n\+\+\+ b\n```/);
});

test("code refs in prose become links", () => {
  const md = render(pr, result);
  assert.match(md, /See \[`x\.py:3-4`\]\(https:\/\/github\.com\/o\/r\/blob\/a{40}\/x\.py#L3-L4\)\./);
});

test("render with no findings", () => {
  assert.match(render(pr, { ...result, findings: [] }), /> \[!TIP\]\n> \*\*Looks good\.\*\* No findings in 2 files/);
});

test("saveReview writes one md and one json per run in the PR folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsrobo-"));
  const a = saveReview(dir, pr, result, "P3", new Date("2026-09-30T10:00:00Z"));
  saveReview(dir, pr, result, "P3", new Date("2026-09-30T11:00:00Z"));
  assert.match(readFileSync(a, "utf8"), /^https:\/\/github.com\/o\/r\/pull\/7 at a{40}\n\n> \[!CAUTION\]/);
  assert.deepEqual(readdirSync(join(dir, "reviews", "o", "r", "7")).sort(), [
    "2026-09-30-10-00-aaaaaaa.json",
    "2026-09-30-10-00-aaaaaaa.md",
    "2026-09-30-11-00-aaaaaaa.json",
    "2026-09-30-11-00-aaaaaaa.md",
  ]);
});
