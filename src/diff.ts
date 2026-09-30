// Lines on the RIGHT side of each file that appear in a diff hunk. GitHub
// rejects a review whose inline comment targets a line outside the hunks.
export function commentableLines(patch: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file = "";
  let line = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      out.set(file, new Set());
    } else if (raw.startsWith("@@")) {
      line = Number(/\+(\d+)/.exec(raw)?.[1] ?? 0);
    } else if (raw.startsWith("+") || raw.startsWith(" ")) {
      out.get(file)?.add(line);
      line++;
    }
  }
  return out;
}

export function inDiff(lines: Map<string, Set<number>>, file: string, from: number, to: number): boolean {
  const s = lines.get(file);
  if (!s) return false;
  for (let i = from; i <= to; i++) if (!s.has(i)) return false;
  return true;
}

export type Hunk = { file: string; oldStart: number; oldCount: number; newLines: string[] };

// Hunks of a unified diff with the new-side text, for turning a fix into suggestion blocks.
export function parseHunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let file = "";
  let h: Hunk | null = null;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) file = raw.slice(4).replace(/^b\//, "");
    else if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) continue;
      h = { file, oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newLines: [] };
      out.push(h);
    } else if (h && (raw.startsWith("+") || raw.startsWith(" "))) h.newLines.push(raw.slice(1));
    else if (h && raw.startsWith("\\")) continue;
    else if (h && !raw.startsWith("-")) h = null;
  }
  return out;
}
