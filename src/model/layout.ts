/**
 * Plastic-style horizontal layout: time flows left → right (one column per
 * commit, parents always left of children), every branch is a horizontal lane,
 * and child branches sit below their parent. Lanes are packed into shared rows
 * when their column spans do not overlap.
 */

import type { Model } from "./infer.ts";

export interface Span {
  branch: number;
  row: number;
  /** Column of the fork point (or first commit for root branches). */
  startCol: number;
  /** Last column the lane occupies, including where it was merged into. */
  endCol: number;
  /** First and last owned commit columns; `null` for empty branches. */
  firstCol: number | null;
  lastCol: number | null;
}

export interface Edge {
  /** Parent commit (source of the arrow). */
  from: string;
  /** Child commit (arrowhead). */
  to: string;
  kind: "merge" | "cross";
}

export interface Layout {
  spans: Span[]; // indexed by branch id
  rows: number;
  cols: number;
  edges: Edge[];
}

/** Rough label width in columns, so names never overlap the next lane. */
const LABEL_CHAR_COLS = 0.27;

export function layoutModel(model: Model): Layout {
  const col = (h: string) => model.index.get(h)!;
  const edges: Edge[] = [];
  const mergedInto = new Map<number, number>(); // branch → furthest column it is merged into

  for (const h of model.order) {
    const c = model.commits.get(h)!;
    const ownerId = model.owner.get(h)!;
    c.parents.forEach((p, i) => {
      if (!model.commits.has(p)) return;
      const pOwner = model.owner.get(p)!;
      if (i === 0) {
        if (pOwner === ownerId || model.branches[ownerId].commits[0] === h) return; // lane line or fork
        edges.push({ from: p, to: h, kind: "cross" });
      } else {
        edges.push({ from: p, to: h, kind: "merge" });
      }
      if (pOwner !== ownerId) mergedInto.set(pOwner, Math.max(mergedInto.get(pOwner) ?? 0, col(h)));
    });
  }

  const spans: Span[] = model.branches.map((b) => {
    const firstCol = b.commits.length ? col(b.commits[0]) : null;
    const lastCol = b.commits.length ? col(b.commits[b.commits.length - 1]) : null;
    const baseCol = b.base !== null ? col(b.base) : null;
    const startCol = baseCol ?? firstCol ?? 0;
    const endCol = Math.max(lastCol ?? startCol + 1, mergedInto.get(b.id) ?? 0);
    return { branch: b.id, row: 0, startCol, endCol, firstCol, lastCol };
  });

  // Depth-first: trunk, then other roots; children by fork column.
  const visit: number[] = [];
  const pushTree = (id: number) => {
    visit.push(id);
    const kids = [...model.branches[id].children].sort((a, b) => spans[a].startCol - spans[b].startCol || a - b);
    for (const k of kids) pushTree(k);
  };
  if (model.trunk !== null) pushTree(model.trunk);
  const roots = model.branches
    .filter((b) => b.parent === null && b.id !== model.trunk)
    .sort((a, b) => spans[a.id].startCol - spans[b.id].startCol);
  for (const r of roots) pushTree(r.id);

  const occupied: [number, number][][] = [];
  const free = (row: number, lo: number, hi: number) =>
    !(occupied[row] ?? []).some(([a, b]) => lo <= b && a <= hi);

  for (const id of visit) {
    const s = spans[id];
    const b = model.branches[id];
    const parentRow = b.parent !== null ? spans[b.parent].row : -1;
    const minRow = id === model.trunk ? 0 : Math.max(parentRow + 1, model.trunk !== null ? 1 : 0);
    const labelEnd = s.startCol + 1 + b.name.length * LABEL_CHAR_COLS;
    const lo = s.startCol - 0.5;
    const hi = Math.max(s.endCol, labelEnd) + 1;
    let row = minRow;
    while (!free(row, lo, hi)) row++;
    s.row = row;
    (occupied[row] ??= []).push([lo, hi]);
  }

  return { spans, rows: occupied.length, cols: model.order.length, edges };
}
