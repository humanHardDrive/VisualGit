/**
 * Moving between changesets with the keyboard: along a branch (←/→), and
 * between lanes (↑/↓).
 */

import type { Model } from "./infer.ts";
import type { Layout } from "./layout.ts";

/** The changeset before `hash`: its first parent, which leaves a branch at the changeset it was created from. */
export function previousOf(m: Model, hash: string): string | null {
  const p = m.commits.get(hash)?.parents[0];
  return p && m.commits.has(p) ? p : null;
}

/** The next changeset on the same branch lane. */
export function nextOf(m: Model, hash: string): string | null {
  const b = m.branches[m.owner.get(hash)!];
  return b.commits[b.commits.indexOf(hash) + 1] ?? null;
}

/**
 * The changeset on the nearest row above (`dir` -1) or below (1) that has
 * changesets, closest in time to `hash` (the earlier one on a tie). Rows with
 * no changesets are skipped. Null at the top or bottom.
 */
export function laneNeighbour(m: Model, layout: Layout, hash: string, dir: -1 | 1): string | null {
  const col = m.index.get(hash);
  const owner = m.owner.get(hash);
  if (col === undefined || owner === undefined) return null;
  const byRow = new Map<number, string[]>();
  for (const span of layout.spans) {
    const commits = m.branches[span.branch].commits;
    if (commits.length) byRow.set(span.row, [...(byRow.get(span.row) ?? []), ...commits]);
  }
  for (let row = layout.spans[owner].row + dir; row >= 0 && row < layout.rows; row += dir) {
    const candidates = byRow.get(row);
    if (!candidates) continue;
    let best: string | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const at = m.index.get(c)!;
      const d = Math.abs(at - col);
      if (d < bestD || (d === bestD && at < m.index.get(best!)!)) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }
  return null;
}
