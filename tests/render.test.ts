import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pr } from "../src/github.ts";
import { type Result, render } from "../src/review.ts";

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
  skipped: ["gen.pb.go: generated"],
  findings: [
    { file: "x.py", line_start: 3, line_end: 4, severity: "P3", title: "minor", body: "m" },
    {
      file: "y.py",
      line_start: 10,
      line_end: 12,
      severity: "P1",
      title: "wrong",
      body: "w",
      suggested_patch: "--- a\n+++ b\n",
    },
  ],
  alias: "sonnet",
  cost_usd: 0.123,
  seconds: 9,
  files: 2,
};

test("render links, filters, and footer", () => {
  const md = render(pr, result, "P2");
  assert.match(md, /\*\*1 finding\*\* \(1 P1\)/);
  assert.match(md, new RegExp(`https://github.com/o/r/blob/${"a".repeat(40)}/y.py#L10-L12`));
  assert.doesNotMatch(md, /minor/);
  assert.match(md, /```diff\n--- a\n\+\+\+ b\n```/);
  assert.match(md, /<sub>sonnet · \$0.12 · 2 files · 9s<\/sub>/);
});

test("render with no findings", () => {
  assert.match(render(pr, { ...result, findings: [] }), /No findings\./);
});
