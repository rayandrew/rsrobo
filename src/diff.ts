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
