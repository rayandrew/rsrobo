import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Gate = { status: "pass" | "fail" | "skipped"; command?: string; output: string };

// The test command comes from the notes: a bullet like `- test: \`make test\`` under Commands.
// AGENTS.md is the notes file; CLAUDE.md only imports it, and is read as a fallback for older notes.
export function testCommand(dir: string): string | undefined {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const f = join(dir, name);
    if (!existsSync(f)) continue;
    const m = /^- test(?: \([^)]*\))?: `([^`]+)`/m.exec(readFileSync(f, "utf8"));
    if (m) return m[1];
  }
  return undefined;
}

// Runs the repository's test command on the patched checkout with an empty environment, so no token
// from the job leaks into PR code. ponytail: this still runs PR code on the job's disk; fix policy
// limits push and stacked to my own repositories.
export function runGate(dir: string, timeoutMin = 20): Gate {
  const command = testCommand(dir);
  if (!command) return { status: "skipped", output: "no test command in notes" };
  const home = mkdtempSync(join(tmpdir(), "rsrobo-gate-"));
  const r = spawnSync("env", ["-i", `PATH=${process.env.PATH}`, `HOME=${home}`, "sh", "-c", command], {
    cwd: dir,
    encoding: "utf8",
    timeout: timeoutMin * 60_000,
    maxBuffer: 64 << 20,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-6000);
  return { status: r.status === 0 ? "pass" : "fail", command, output };
}
