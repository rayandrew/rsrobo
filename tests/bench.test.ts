import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BenchRun, benchMd, lastRun, saveRun, score } from "../src/bench.ts";
import { ledger, ledgerMd } from "../src/ledger.ts";
import type { Result } from "../src/review.ts";

const res = (findings: { file: string; line_start: number }[], cost = 1): Result => ({
  map: "",
  changes: [],
  skipped: [],
  lessons: [],
  findings: findings.map((f) => ({
    ...f,
    line_end: f.line_start + 2,
    severity: "P1",
    title: "t",
    problem: "",
    evidence: [],
    fix: "",
  })),
  model: "m",
  effort: "high",
  cost_usd: cost,
  seconds: 30,
  files: 1,
});

test("score counts expected defects found at the same place and extras", () => {
  const c = {
    pr: "o/r#1",
    expect: [
      { file: "a.py", line_start: 10, line_end: 12, title: "x" },
      { file: "b.py", line_start: 1, line_end: 1, title: "y" },
    ],
  };
  const s = score(
    c,
    res([
      { file: "a.py", line_start: 13 },
      { file: "c.py", line_start: 1 },
    ]),
  );
  assert.deepEqual([s.found, s.expected, s.extra], [1, 2, 1]);
});

test("bench runs save, find the previous run of the same model, and render deltas", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsrobo-"));
  const a: BenchRun = {
    date: "2026-09-01T10:00",
    model: "m",
    effort: "high",
    cases: [{ pr: "o/r#1", found: 1, expected: 2, extra: 3, cost_usd: 1, seconds: 30 }],
  };
  const b: BenchRun = { ...a, date: "2026-09-02T10:00", cases: [{ ...a.cases[0], found: 2, extra: 1 }] };
  saveRun(dir, a);
  saveRun(dir, b);
  assert.equal(lastRun(dir, "m", b.date)?.date, a.date);
  assert.equal(lastRun(dir, "other", b.date), undefined);
  assert.match(benchMd(b, a), /\| total \| 2\/2 \(\+1\) \| 1 \(-2\) \|/);
});

test("ledger sums saved reviews per month, repo and model", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsrobo-"));
  const d = join(dir, "reviews", "o", "r", "7");
  mkdirSync(d, { recursive: true });
  const row = (model: string, cost: number) =>
    JSON.stringify({ pr: "https://github.com/o/r/pull/7", model, cost_usd: cost, seconds: 60, findings: [1, 2] });
  writeFileSync(join(d, "2026-09-30-10-00-aaaaaaa.json"), row("m", 1));
  writeFileSync(join(d, "2026-09-30-11-00-aaaaaaa.json"), row("m", 2));
  writeFileSync(join(d, "2026-08-01-11-00-aaaaaaa.json"), row("n", 5));
  const rows = ledger(dir);
  assert.deepEqual(
    rows.map((r) => [r.month, r.model, r.runs, r.cost]),
    [
      ["2026-09", "m", 2, 3],
      ["2026-08", "n", 1, 5],
    ],
  );
  assert.match(ledgerMd(rows), /- 2026-09: \$3\.00\n- 2026-08: \$5\.00/);
});
