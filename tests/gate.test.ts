import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGate, testCommand } from "../src/gate.ts";

test("gate reads the test command from notes and runs it without the job environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsrobo-"));
  assert.equal(runGate(dir).status, "skipped");
  writeFileSync(
    join(dir, "CLAUDE.md"),
    '# x\n\n## Commands\n- build: `make`\n- test (C++): `test -z "$SECRET" && echo ok`\n',
  );
  assert.equal(testCommand(dir), 'test -z "$SECRET" && echo ok');
  process.env.SECRET = "leak";
  const g = runGate(dir, 1);
  assert.equal(g.status, "pass");
  assert.match(g.output, /ok/);
  writeFileSync(join(dir, "CLAUDE.md"), "- test: `exit 3`\n");
  assert.equal(runGate(dir, 1).status, "fail");
});
