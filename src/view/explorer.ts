/**
 * Canvas renderer for the branch explorer: lanes, changesets, branch-creation
 * connectors and merge arrows, with pan/zoom and hit testing.
 */

import { pendingChangesOn, uncommittedHead, type Branch, type Model } from "../model/infer.ts";
import type { Edge, Layout, Span } from "../model/layout.ts";

export const COL = 30;
export const ROW = 64;
const PAD = 48;
/** Height of the timeline across the top, in screen pixels (it doesn't scale; its labels follow the columns). */
export const TIMELINE_H = 24;
const BAND_TOP = 22;
const BAND_H = 26;
const NODE_R = 6;
const EMPTY_W = 40;
/** The checked-out changeset is drawn larger, with a home symbol inside. */
const HEAD_R = 9;
/** Radius of the circle that marks a release (tagged changeset). */
const RELEASE_R = HEAD_R + 6;

const TRUNK_COLOR = "#2f81f7";
const PALETTE = ["#a371f7", "#e3a008", "#f0603c", "#1fb5d4", "#e85aad", "#f08c2e", "#6e7bf2", "#b0882f", "#0ea5e9", "#cf5be0"];

export type Selection = { kind: "commit"; hash: string } | { kind: "branch"; id: number };

/** Search hits drawn highlighted; everything else is dimmed. */
export interface Matches {
  commits: Set<string>;
  branches: Set<number>;
}

export interface View {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * How a local branch stands against its own remote branch: "↑3" (three
 * changesets the remote branch doesn't have yet, even if they're on the
 * remote under another branch), "↓2" (two it has that this branch doesn't),
 * both, "not pushed" (never pushed), or null when it's up to date or there's
 * no remote to compare with.
 */
export function pushLabel(model: Model, b: Branch): string | null {
  if (!model.hasRemotes || !b.refs.some((r) => r.startsWith("refs/heads/"))) return null;
  if (!b.remote) return b.unpushed ? `not pushed · ↑${b.unpushed}` : "not pushed";
  const parts = [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

export function branchColor(model: Model, id: number): string {
  return id === model.trunk ? TRUNK_COLOR : PALETTE[id % PALETTE.length];
}

const colX = (col: number) => PAD + col * COL;
const rowTop = (row: number) => PAD + row * ROW;
const rowMid = (row: number) => rowTop(row) + BAND_TOP + BAND_H / 2;

interface Theme {
  text: string;
  muted: string;
  accent: string;
  merge: string;
  fork: string;
  nodeStroke: string;
  canvas: string;
  match: string;
  unpushed: string;
  panel: string;
  border: string;
  grid: string;
}

export interface ExplorerEvents {
  onSelect(sel: Selection | null): void;
  /** Right-click on a changeset or branch, after it has been selected. */
  onContextMenu(sel: Selection): void;
  /** Double-click on the hollow HEAD marker over uncommitted work. */
  onOpenPending(): void;
  /** Double-click on a committed changeset. */
  onOpenChangeset(hash: string): void;
  /** Double-click on a branch's lane (not on one of its changesets). */
  onOpenBranch(id: number): void;
  /** Right-click on a merge arrow (or another cross-lane link): `from` is its source, `to` its destination. */
  onArrowMenu(edge: Edge): void;
}

export class Explorer {
  private readonly canvas: HTMLCanvasElement;
  private readonly tooltip: HTMLElement;
  private readonly events: ExplorerEvents;
  private readonly ctx: CanvasRenderingContext2D;
  private model?: Model;
  private layout?: Layout;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private selection: Selection | null = null;
  /** A second changeset, Ctrl/⌘-clicked alongside the selected one, to compare them. */
  private second: string | null = null;
  private hovered: string | null = null;
  /** The arrow under the pointer, drawn thicker so it's clear it can be right-clicked. */
  private hoveredEdge: Edge | null = null;
  /** Branch whose empty lane carries the HEAD marker, if HEAD's branch has no changesets yet. */
  private headLane: number | null = null;
  /** Branch with an empty "pending changes" changeset after its latest one (which then carries the HEAD marker). */
  private pendingLane: number | null = null;
  private matches: Matches | null = null;
  /**
   * A "fit" or "latest" asked for while the canvas was hidden (zero size, e.g.
   * a repository opened from the Workspace view). Placement needs the real
   * size, so it waits until the canvas is shown.
   */
  private pendingPlacement: "fit" | "latest" | null = null;
  private frame = 0;
  private theme!: Theme;

  constructor(canvas: HTMLCanvasElement, tooltip: HTMLElement, events: ExplorerEvents) {
    this.canvas = canvas;
    this.tooltip = tooltip;
    this.events = events;
    this.ctx = canvas.getContext("2d")!;
    this.readTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      this.readTheme();
      this.redraw();
    });
    new ResizeObserver(() => this.redraw()).observe(canvas);
    this.bindInput();
  }

  /**
   * `view`: "keep" leaves pan/zoom alone (reload), a saved `View` restores a
   * repository's previous position, "latest" jumps to the newest changesets.
   */
  setData(model: Model, layout: Layout, view: "keep" | "latest" | View) {
    this.model = model;
    this.layout = layout;
    this.headLane = uncommittedHead(model)?.id ?? null;
    this.pendingLane = pendingChangesOn(model)?.id ?? null;
    if (this.selection?.kind === "commit" && !model.commits.has(this.selection.hash)) this.selection = null;
    if (this.selection?.kind === "branch" && !model.branches[this.selection.id]) this.selection = null;
    if (this.selection?.kind !== "commit" || (this.second && !model.commits.has(this.second))) this.second = null;
    if (view === "latest") this.latest();
    else if (view !== "keep") {
      ({ scale: this.scale, tx: this.tx, ty: this.ty } = view);
      this.pendingPlacement = null;
    }
    this.redraw();
  }

  /** Carries out a placement that was waiting for the canvas to be shown. */
  private settle() {
    const p = this.pendingPlacement;
    if (!p || this.canvas.clientWidth === 0 || this.canvas.clientHeight === 0) return;
    this.pendingPlacement = null;
    if (p === "fit") this.fit();
    else this.latest();
  }

  clear() {
    this.model = undefined;
    this.layout = undefined;
    this.selection = null;
    this.second = null;
    this.matches = null;
    this.pendingPlacement = null;
    this.redraw();
  }

  /** Highlights search hits; null ends the search. */
  setMatches(matches: Matches | null) {
    this.matches = matches;
    this.redraw();
  }

  getView(): View {
    return { scale: this.scale, tx: this.tx, ty: this.ty };
  }

  /** The two selected changesets, the selected one first, when a second has been Ctrl/⌘-clicked. */
  selectedPair(): [string, string] | null {
    return this.selection?.kind === "commit" && this.second ? [this.selection.hash, this.second] : null;
  }

  /**
   * Selecting one of the two selected changesets keeps both (it becomes the
   * first); selecting anything else drops the second.
   */
  select(sel: Selection | null, reveal = false) {
    const prev = this.selection?.kind === "commit" ? this.selection.hash : null;
    if (sel?.kind === "commit" && this.second && sel.hash === this.second && prev) this.second = prev;
    else if (sel?.kind !== "commit" || sel.hash !== prev) this.second = null;
    this.selection = sel;
    if (reveal) this.settle(); // place the view before scrolling to the selection
    if (reveal && sel && this.model && this.layout) {
      if (sel.kind === "commit") {
        // Only scroll when the changeset is off screen, so stepping through history doesn't jump around.
        const { x, y } = this.commitPos(sel.hash);
        const sx = x * this.scale + this.tx;
        const sy = y * this.scale + this.ty;
        const margin = 60;
        const visible =
          sx >= margin && sx <= this.canvas.clientWidth - margin && sy >= margin && sy <= this.canvas.clientHeight - margin;
        if (!visible) this.centerOn(x, y);
      } else {
        const { left, right } = this.bandExtent(this.layout.spans[sel.id]);
        const w = this.canvas.clientWidth / this.scale;
        const cx = right - left > w * 0.8 ? right - w * 0.4 : (left + right) / 2;
        this.centerOn(cx, rowMid(this.layout.spans[sel.id].row));
      }
    }
    this.redraw();
  }

  zoomBy(factor: number) {
    this.zoomAt(factor, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
  }

  fit() {
    if (!this.layout) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) {
      this.pendingPlacement = "fit";
      return;
    }
    this.pendingPlacement = null;
    const worldW = colX(this.layout.cols) + PAD;
    const worldH = rowTop(this.layout.rows) + PAD;
    // The timeline covers the top: fit what's below it.
    const below = Math.max(1, h - TIMELINE_H);
    this.scale = clamp(Math.min(w / worldW, below / worldH, 1.5), 0.04, 3);
    this.tx = (w - worldW * this.scale) / 2;
    this.ty = TIMELINE_H + Math.max(0, (below - worldH * this.scale) / 2);
    this.redraw();
  }

  /** Scrolls to the newest changesets, like Plastic opening on recent work. */
  latest() {
    if (!this.layout) return;
    const w = this.canvas.clientWidth;
    if (w === 0) {
      this.pendingPlacement = "latest";
      return;
    }
    this.pendingPlacement = null;
    this.scale = this.scale < 0.5 ? 1 : this.scale;
    const worldRight = colX(Math.max(0, this.layout.cols - 1)) + 220;
    this.tx = Math.min(0, w - worldRight * this.scale);
    this.ty = 0;
    this.redraw();
  }

  redraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  // ---- geometry ----------------------------------------------------------

  private bandExtent(s: Span) {
    if (s.firstCol === null || s.lastCol === null) {
      const left = colX(s.startCol) + COL * 0.6;
      return { left, right: left + EMPTY_W };
    }
    return { left: colX(s.firstCol) - 12, right: colX(s.pendingCol ?? s.lastCol) + 12 };
  }

  private commitPos(hash: string) {
    const col = this.model!.index.get(hash)!;
    const row = this.layout!.spans[this.model!.owner.get(hash)!].row;
    return { x: colX(col), y: rowMid(row) };
  }

  private centerOn(wx: number, wy: number) {
    this.tx = this.canvas.clientWidth / 2 - wx * this.scale;
    this.ty = Math.min(0, this.canvas.clientHeight / 2 - wy * this.scale);
  }

  private zoomAt(factor: number, sx: number, sy: number) {
    const next = clamp(this.scale * factor, 0.04, 3);
    const wx = (sx - this.tx) / this.scale;
    const wy = (sy - this.ty) / this.scale;
    this.scale = next;
    this.tx = sx - wx * next;
    this.ty = sy - wy * next;
    this.redraw();
  }

  private hitTest(sx: number, sy: number): Selection | null {
    const model = this.model;
    const layout = this.layout;
    if (!model || !layout || sy < TIMELINE_H) return null;
    const wx = (sx - this.tx) / this.scale;
    const wy = (sy - this.ty) / this.scale;
    const col = Math.round((wx - PAD) / COL);
    const row = Math.floor((wy - PAD) / ROW);
    if (col >= 0 && col < model.order.length) {
      const h = model.order[col];
      const p = this.commitPos(h);
      const radius = model.tags.has(h) ? RELEASE_R : (this.isHeadCommit(h) ? HEAD_R : NODE_R) + 4 / this.scale;
      if (Math.hypot(p.x - wx, p.y - wy) <= radius) return { kind: "commit", hash: h };
    }
    for (const s of layout.spans) {
      if (s.row !== row) continue;
      const { left, right } = this.bandExtent(s);
      const labelRight = left + this.labelWidth(model.branches[s.branch]);
      if (wx >= left && wx <= Math.max(right, labelRight) && wy >= rowTop(row) + 4 && wy <= rowTop(row) + BAND_TOP + BAND_H) {
        return { kind: "branch", id: s.branch };
      }
    }
    return null;
  }

  /** The arrow's curve in world coordinates: from its source changeset to just before its destination. */
  private edgeCurve(e: Edge) {
    const a = this.commitPos(e.from);
    const z = this.commitPos(e.to);
    const dx = Math.max(COL, (z.x - a.x) * 0.5);
    return { a, c1: { x: a.x + dx, y: a.y }, c2: { x: z.x - dx, y: z.y }, end: { x: z.x - NODE_R - 1, y: z.y } };
  }

  /** The arrow nearest a screen point, if one passes within a few pixels of it. */
  private edgeAt(sx: number, sy: number): Edge | null {
    if (!this.model || !this.layout || sy < TIMELINE_H) return null;
    const wx = (sx - this.tx) / this.scale;
    const wy = (sy - this.ty) / this.scale;
    const reach = 5 / this.scale + 1;
    let best: Edge | null = null;
    let bestD = reach;
    for (const e of this.layout.edges) {
      const { a, c1, c2, end } = this.edgeCurve(e);
      // Skip arrows whose box is nowhere near the point.
      if (wx < Math.min(a.x, end.x) - reach || wx > Math.max(a.x, c1.x, end.x) + reach) continue;
      if (wy < Math.min(a.y, end.y) - reach || wy > Math.max(a.y, end.y) + reach) continue;
      // Distance to the curve, as a chain of short segments.
      const STEPS = 32;
      let px = a.x;
      let py = a.y;
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS;
        const u = 1 - t;
        const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x;
        const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y;
        const d = segmentDistance(wx, wy, px, py, x, y);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
        px = x;
        py = y;
      }
    }
    return best;
  }

  /** Whether a screen point is on the hollow HEAD marker (an empty branch's slot or the pending-changes changeset). */
  private onHollowHead(sx: number, sy: number) {
    const layout = this.layout;
    const id = this.headLane ?? this.pendingLane;
    if (!layout || id === null || sy < TIMELINE_H) return false;
    const span = layout.spans[id];
    const { left, right } = this.bandExtent(span);
    const x = span.pendingCol !== null ? colX(span.pendingCol) : (left + right) / 2;
    const wx = (sx - this.tx) / this.scale;
    const wy = (sy - this.ty) / this.scale;
    return Math.hypot(x - wx, rowMid(span.row) - wy) <= HEAD_R + 4 / this.scale;
  }

  /** The changeset drawn with the HEAD marker (unless HEAD's branch has an empty lane of its own). */
  private isHeadCommit(hash: string) {
    return hash === this.model?.headHash && this.headLane === null && this.pendingLane === null;
  }

  private labelWidth(b: Branch) {
    this.ctx.font = "600 12px -apple-system, system-ui, sans-serif";
    return this.ctx.measureText(this.labelText(b)).width + 4;
  }

  private labelText(b: Branch) {
    const tags: string[] = [];
    if (b.commits.length === 0 && b.kind !== "trunk") tags.push("empty");
    if (b.kind === "deleted") tags.push("deleted");
    if (b.kind === "remote") tags.push("remote");
    return tags.length ? `${b.name}  · ${tags.join(" · ")}` : b.name;
  }

  // ---- input ---------------------------------------------------------------

  private bindInput() {
    const c = this.canvas;
    let drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
    // On macOS, Ctrl+click arrives as a context menu, during the press; this
    // stops the release from toggling the changeset a second time.
    let toggledThisPress = false;

    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // only the primary button pans and selects
      toggledThisPress = false;
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
    });
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) > 4) {
          drag.moved = true;
          c.classList.add("dragging");
          this.showTooltip(null, 0, 0);
        }
        if (drag.moved) {
          this.tx = drag.tx + dx;
          this.ty = drag.ty + dy;
          this.redraw();
        }
        return;
      }
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      const h = hit?.kind === "commit" ? hit.hash : null;
      const edge = hit ? null : this.edgeAt(e.clientX - r.left, e.clientY - r.top);
      c.style.cursor = hit || edge ? "pointer" : "";
      if (h !== this.hovered || edge !== this.hoveredEdge) {
        this.hovered = h;
        this.hoveredEdge = edge;
        this.redraw();
      }
      this.showTooltip(h, e.clientX - r.left, e.clientY - r.top);
    });
    c.addEventListener("pointerup", (e) => {
      if (e.button !== 0) return;
      c.classList.remove("dragging");
      const wasDrag = drag?.moved;
      drag = null;
      if (wasDrag) return;
      const r = c.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (e.ctrlKey || e.metaKey) {
        if (!toggledThisPress) this.toggleSecond(hit);
        return;
      }
      this.second = null;
      this.select(hit);
      this.events.onSelect(hit);
    });
    c.addEventListener("dblclick", (e) => {
      const r = c.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (this.onHollowHead(sx, sy)) return this.events.onOpenPending();
      const hit = this.hitTest(sx, sy);
      if (hit?.kind === "commit") this.events.onOpenChangeset(hit.hash);
      else if (hit?.kind === "branch") this.events.onOpenBranch(hit.id);
    });
    c.addEventListener("contextmenu", (e) => {
      // Replace the webview's own menu (Reload, Inspect) on the explorer.
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      // Ctrl+click with the primary button (macOS turns it into this event): add or remove a changeset.
      if (e.ctrlKey && e.button === 0) {
        toggledThisPress = true;
        this.toggleSecond(hit);
        return;
      }
      if (!hit) {
        const edge = this.edgeAt(e.clientX - r.left, e.clientY - r.top);
        if (edge) {
          this.showTooltip(null, 0, 0);
          this.events.onArrowMenu(edge);
        }
        return;
      }
      this.showTooltip(null, 0, 0);
      this.select(hit);
      this.events.onSelect(hit);
      this.events.onContextMenu(hit);
    });
    c.addEventListener("pointerleave", () => {
      this.hovered = null;
      this.hoveredEdge = null;
      this.showTooltip(null, 0, 0);
      this.redraw();
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) {
          this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
        } else {
          this.tx -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
          this.ty -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
          this.redraw();
        }
      },
      { passive: false },
    );
  }

  /**
   * Ctrl/⌘+click: with a changeset selected, another one becomes the second
   * selected changeset (replacing any earlier second). Clicking either of the
   * two again leaves just the other. With nothing (or a branch) selected,
   * it selects the changeset as a plain click would.
   */
  private toggleSecond(hit: Selection | null) {
    if (hit?.kind !== "commit") return;
    const first = this.selection?.kind === "commit" ? this.selection.hash : null;
    let next: Selection = hit;
    if (first && hit.hash === first) {
      if (!this.second) return;
      next = { kind: "commit", hash: this.second };
      this.second = null;
    } else if (first && hit.hash === this.second) {
      next = { kind: "commit", hash: first };
      this.second = null;
    } else if (first) {
      this.second = hit.hash;
      next = { kind: "commit", hash: first };
    } else {
      this.second = null;
    }
    this.selection = next;
    this.redraw();
    this.events.onSelect(next);
  }

  private showTooltip(hash: string | null, sx: number, sy: number) {
    const tip = this.tooltip;
    if (!hash || !this.model) {
      tip.hidden = true;
      return;
    }
    const c = this.model.commits.get(hash)!;
    const b = this.model.branches[this.model.owner.get(hash)!];
    tip.replaceChildren();
    const title = document.createElement("div");
    title.textContent = c.subject || "(no message)";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${hash.slice(0, 8)} · ${b.name} · ${c.author} · ${new Date(c.time * 1000).toLocaleString()}`;
    tip.append(title, meta);
    if (this.model.unpushed.has(hash)) {
      const note = document.createElement("div");
      note.className = "meta unpushed";
      note.textContent = "Not pushed";
      tip.append(note);
    }
    const tags = this.model.tags.get(hash);
    if (tags) {
      const release = document.createElement("div");
      release.className = "meta";
      release.textContent = `Release ${tags.join(", ")}`;
      tip.append(release);
    }
    tip.hidden = false;
    const maxX = this.canvas.clientWidth - tip.offsetWidth - 8;
    tip.style.left = `${Math.max(8, Math.min(sx + 14, maxX))}px`;
    tip.style.top = `${sy + 18}px`;
  }

  // ---- drawing -------------------------------------------------------------

  private readTheme() {
    const s = getComputedStyle(document.documentElement);
    const v = (name: string) => s.getPropertyValue(name).trim();
    this.theme = {
      text: v("--text"),
      muted: v("--muted"),
      accent: v("--accent"),
      merge: v("--merge"),
      fork: v("--fork"),
      nodeStroke: v("--node-stroke"),
      canvas: v("--canvas"),
      match: v("--match"),
      unpushed: v("--unpushed"),
      panel: v("--panel"),
      border: v("--border"),
      grid: v("--grid"),
    };
  }

  private draw() {
    this.settle();
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const model = this.model;
    const layout = this.layout;
    if (!model || !layout) return;

    const s = this.scale;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * this.tx, dpr * this.ty);
    const view = {
      x0: -this.tx / s,
      y0: -this.ty / s,
      x1: (w - this.tx) / s,
      y1: (h - this.ty) / s,
    };
    const visibleRow = (row: number) => rowTop(row) + ROW >= view.y0 && rowTop(row) <= view.y1;
    const t = this.theme;
    const selectedBranch =
      this.selection?.kind === "branch"
        ? this.selection.id
        : this.selection?.kind === "commit"
          ? model.owner.get(this.selection.hash)
          : undefined;

    // Lanes.
    for (const span of layout.spans) {
      const { left, right } = this.bandExtent(span);
      if (right < view.x0 || left > view.x1 + 400 || !visibleRow(span.row)) continue;
      const b = model.branches[span.branch];
      const color = branchColor(model, b.id);
      const top = rowTop(span.row) + BAND_TOP;
      const ghost = b.kind === "deleted" || b.kind === "anonymous";
      const empty = b.commits.length === 0;
      roundRect(ctx, left, top, right - left, BAND_H, 7);
      ctx.fillStyle = withAlpha(color, ghost ? 0.06 : empty ? 0.1 : 0.16);
      ctx.fill();
      ctx.lineWidth = (b.id === selectedBranch ? 2.2 : 1.2) / Math.min(1, s);
      ctx.strokeStyle = withAlpha(color, ghost ? 0.5 : 0.85);
      ctx.setLineDash(ghost || empty ? [5, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      if (this.matches?.branches.has(b.id)) {
        roundRect(ctx, left - 3, top - 3, right - left + 6, BAND_H + 6, 9);
        ctx.lineWidth = 2.5 / Math.min(1, s);
        ctx.strokeStyle = t.match;
        ctx.stroke();
      }

      if (s > 0.3) {
        const label = this.labelText(b);
        ctx.font = `${ghost ? "italic " : ""}600 12px -apple-system, system-ui, sans-serif`;
        const tw = ctx.measureText(label).width;
        // Sticky label: stays visible while the lane's start is scrolled off.
        const lx = Math.max(left + 2, Math.min(view.x0 + 8, right - tw - 2));
        ctx.fillStyle = ghost ? t.muted : t.text;
        ctx.fillText(label, lx, rowTop(span.row) + 15);
        const push = pushLabel(model, b);
        if (push) {
          ctx.font = "700 10px -apple-system, system-ui, sans-serif";
          ctx.fillStyle = t.unpushed;
          ctx.fillText(push, lx + tw + 8, rowTop(span.row) + 15);
        }
      }
    }

    // Branch-creation connectors: from the base changeset down to the new lane.
    ctx.lineWidth = 1.5;
    for (const b of model.branches) {
      if (b.base === null || b.parent === null) continue;
      const span = layout.spans[b.id];
      const { left } = this.bandExtent(span);
      const origin = this.forkOrigin(b);
      const y = rowMid(span.row);
      if (Math.max(origin.x, left) < view.x0 || Math.min(origin.x, left) > view.x1) continue;
      if (Math.max(origin.y, y) < view.y0 || Math.min(origin.y, y) > view.y1) continue;
      const r = Math.min(10, Math.abs(y - origin.y) / 2, Math.max(0, left - origin.x));
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y + NODE_R);
      ctx.lineTo(origin.x, y - r);
      ctx.quadraticCurveTo(origin.x, y, origin.x + r, y);
      ctx.lineTo(left, y);
      ctx.strokeStyle = withAlpha(branchColor(model, b.id), 0.75);
      ctx.stroke();
    }

    // Lane lines through each branch's changesets.
    ctx.lineWidth = 2;
    for (const span of layout.spans) {
      if (span.firstCol === null || span.lastCol === null || span.firstCol === span.lastCol) continue;
      if (colX(span.lastCol) < view.x0 || colX(span.firstCol) > view.x1 || !visibleRow(span.row)) continue;
      ctx.beginPath();
      ctx.moveTo(Math.max(colX(span.firstCol), view.x0 - 10), rowMid(span.row));
      ctx.lineTo(Math.min(colX(span.lastCol), view.x1 + 10), rowMid(span.row));
      ctx.strokeStyle = withAlpha(branchColor(model, span.branch), 0.55);
      ctx.stroke();
    }

    // Dashed lane line on to the pending-changes changeset.
    for (const span of layout.spans) {
      if (span.pendingCol === null || span.lastCol === null || !visibleRow(span.row)) continue;
      ctx.beginPath();
      ctx.moveTo(colX(span.lastCol) + NODE_R, rowMid(span.row));
      ctx.lineTo(colX(span.pendingCol) - HEAD_R, rowMid(span.row));
      ctx.strokeStyle = withAlpha(branchColor(model, span.branch), 0.55);
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Merges (green arrows) and other cross-lane parent links.
    for (const e of layout.edges) {
      const { a, c1, c2, end } = this.edgeCurve(e);
      if (Math.max(a.x, end.x) < view.x0 || Math.min(a.x, end.x) > view.x1) continue;
      if (Math.max(a.y, end.y) < view.y0 || Math.min(a.y, end.y) > view.y1) continue;
      const color = e.kind === "merge" ? t.merge : t.fork;
      const hovered = e === this.hoveredEdge;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
      ctx.strokeStyle = color;
      ctx.lineWidth = (e.kind === "merge" ? 1.8 : 1.2) + (hovered ? 1.4 : 0);
      ctx.setLineDash(e.kind === "merge" ? [] : [3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      arrowHead(ctx, c2.x, c2.y, end.x, end.y, color);
    }

    // Changesets.
    const c0 = clamp(Math.floor((view.x0 - PAD) / COL) - 1, 0, model.order.length);
    const c1 = clamp(Math.ceil((view.x1 - PAD) / COL) + 1, 0, model.order.length);
    const selectedHash = this.selection?.kind === "commit" ? this.selection.hash : null;
    for (let col = c0; col < c1; col++) {
      const hash = model.order[col];
      const id = model.owner.get(hash)!;
      const row = layout.spans[id].row;
      if (!visibleRow(row)) continue;
      const x = colX(col);
      const y = rowMid(row);
      const commit = model.commits.get(hash)!;
      const ghost = model.branches[id].kind === "deleted" || model.branches[id].kind === "anonymous";
      const tags = model.tags.get(hash);
      const isHead = this.isHeadCommit(hash);
      const r = isHead ? HEAD_R : NODE_R;
      const hit = this.matches?.commits.has(hash);
      // While searching, changesets that don't match (and aren't on a matching branch) fade back.
      ctx.globalAlpha = this.matches && !hit && !this.matches.branches.has(id) ? 0.3 : 1;
      if (hit) {
        ctx.beginPath();
        ctx.arc(x, y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(t.match, 0.55);
        ctx.fill();
      }
      if (hash === selectedHash || hash === this.second) {
        // Selection is a halo, so rings stay reserved for releases.
        ctx.beginPath();
        ctx.arc(x, y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(t.accent, 0.3);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = isHead ? t.accent : ghost ? withAlpha(branchColor(model, id), 0.55) : branchColor(model, id);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = t.nodeStroke;
      ctx.stroke();
      if (isHead) {
        houseIcon(ctx, x, y, "#ffffff");
      } else if (commit.parents.length > 1) {
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = t.nodeStroke;
        ctx.fill();
      }
      if (hash === this.hovered && hash !== selectedHash && hash !== this.second) ring(ctx, x, y, r + 3, withAlpha(t.text, 0.5), 1.5);
      // Not pushed: a small up-arrow above the changeset.
      if (model.unpushed.has(hash) && s > 0.35) upArrow(ctx, x, y - r - 2, t.unpushed);

      // Releases (tags): a circle drawn around the changeset, with the release name under it.
      if (tags) {
        ring(ctx, x, y, RELEASE_R, t.text, 2);
        if (s > 0.55) {
          ctx.font = "700 10px -apple-system, system-ui, sans-serif";
          ctx.fillStyle = t.text;
          ctx.textAlign = "center";
          ctx.fillText(tags.join(", "), x, y + RELEASE_R + 11);
          ctx.textAlign = "left";
        }
      }
    }
    ctx.globalAlpha = 1;

    // Empty-branch stub marker: a hollow changeset-sized slot inside the pill.
    for (const span of layout.spans) {
      if (span.firstCol !== null) continue;
      const { left, right } = this.bandExtent(span);
      if (right < view.x0 || left > view.x1 || !visibleRow(span.row)) continue;
      const x = (left + right) / 2;
      const y = rowMid(span.row);
      if (span.branch === this.headLane) {
        // The checked-out branch with nothing committed yet: HEAD sits in its empty slot,
        // hollow because the changes there are still uncommitted.
        hollowHome(ctx, x, y, t);
        continue;
      }
      const color = branchColor(model, span.branch);
      ctx.setLineDash([2, 2]);
      ring(ctx, x, y, NODE_R - 1, color, 1.5);
      ctx.setLineDash([]);
    }

    // Pending changes on a branch with changesets: an empty changeset after the latest one.
    for (const span of layout.spans) {
      if (span.pendingCol === null || !visibleRow(span.row)) continue;
      const x = colX(span.pendingCol);
      if (x < view.x0 - 20 || x > view.x1 + 20) continue;
      hollowHome(ctx, x, rowMid(span.row), t);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawTimeline(model, w, t);
  }

  /** Each column's date for the timeline: commit times, never going backwards (a rebased or backdated changeset doesn't make the timeline jump back). */
  private columnTimes(model: Model): number[] {
    let times = columnTimeCache.get(model);
    if (!times) {
      times = [];
      let last = -Infinity;
      for (const h of model.order) times.push((last = Math.max(last, model.commits.get(h)!.time)));
      columnTimeCache.set(model, times);
    }
    return times;
  }

  /**
   * The timeline across the top: it stays put as you scroll down, and follows
   * the columns as you scroll sideways and zoom. Labels go where the date
   * changes between one changeset and the next, by priority (years, then
   * months, days, and each changeset's time), wherever they fit: zoomed out
   * shows years, zooming in brings in months, days, then times. The date of
   * the first changeset in view stays at the left.
   */
  private drawTimeline(model: Model, w: number, t: Theme) {
    const { ctx } = this;
    const s = this.scale;
    const times = this.columnTimes(model);
    ctx.fillStyle = t.panel;
    ctx.fillRect(0, 0, w, TIMELINE_H);
    ctx.fillStyle = t.border;
    ctx.fillRect(0, TIMELINE_H - 1, w, 1);
    if (times.length === 0) return;

    const sx = (col: number) => colX(col) * s + this.tx;
    const first = clamp(Math.ceil(((-this.tx) / s - PAD) / COL), 0, times.length - 1);
    const last = clamp(Math.floor(((w - this.tx) / s - PAD) / COL), 0, times.length - 1);
    if (sx(first) > w || sx(last) < 0) return;

    const font = (bold: boolean) => `${bold ? "600" : "400"} 11px -apple-system, system-ui, sans-serif`;
    const { context, marks } = timelineMarks(times, first, last, sx, COL * s, (text, bold) => {
      ctx.font = font(bold);
      return ctx.measureText(text).width;
    });

    ctx.textBaseline = "alphabetic";
    for (const m of marks) {
      ctx.fillStyle = m.bold ? t.text : t.muted;
      ctx.fillRect(Math.round(m.x), TIMELINE_H - 1 - m.tick, 1, m.tick);
      ctx.font = font(m.bold);
      ctx.fillText(m.text, m.x + 3, 15);
    }
    ctx.fillStyle = t.text;
    ctx.font = font(true);
    ctx.fillText(context, 8, 15);
  }

  /** Where a branch's creation connector starts. */
  private forkOrigin(b: Branch) {
    const model = this.model!;
    const parent = model.branches[b.parent!];
    if (model.owner.get(b.base!) !== parent.id && parent.commits.length === 0) {
      const { left, right } = this.bandExtent(this.layout!.spans[parent.id]);
      return { x: (left + right) / 2, y: rowMid(this.layout!.spans[parent.id].row) };
    }
    return this.commitPos(b.base!);
  }
}

const columnTimeCache = new WeakMap<Model, number[]>();

export interface TimelineMark {
  /** Screen x of the changeset where the date changes. */
  x: number;
  text: string;
  /** Years and months: drawn bold, with longer ticks. */
  bold: boolean;
  tick: number;
}

/**
 * The timeline's labels for columns `first`…`last` (`times`: each column's
 * date, unix seconds; `x`: a column's screen x; `colWidth`: a column's width
 * on screen). A label goes where the date changes from the column before, by
 * priority: years, months, days, then each changeset's time (only once a
 * column is wide enough to hold one), wherever it fits without overlapping
 * one already placed. `context` is the first column's full date, pinned at
 * the left.
 */
export function timelineMarks(
  times: number[],
  first: number,
  last: number,
  x: (col: number) => number,
  colWidth: number,
  measure: (text: string, bold: boolean) => number,
): { context: string; marks: TimelineMark[] } {
  const date = (col: number) => new Date(times[col] * 1000);
  const levels: { key: (d: Date, col: number) => number; label: (d: Date) => string; bold: boolean; tick: number }[] = [
    { key: (d) => d.getFullYear(), label: (d) => String(d.getFullYear()), bold: true, tick: 10 },
    { key: (d) => d.getFullYear() * 12 + d.getMonth(), label: (d) => d.toLocaleDateString(undefined, { month: "short" }), bold: true, tick: 8 },
    { key: (d) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(), label: (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), bold: false, tick: 6 },
    { key: (_, col) => col, label: (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }), bold: false, tick: 4 },
  ];

  // Placed labels as [left, right], kept sorted by left, so nothing overlaps.
  const placed: [number, number][] = [];
  const GAP = 10;
  const at = (a: number) => {
    let lo = 0;
    let hi = placed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (placed[mid][0] < a) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const tryPlace = (a: number, b: number) => {
    const i = at(a);
    if ((i > 0 && placed[i - 1][1] + GAP > a) || (i < placed.length && b + GAP > placed[i][0])) return false;
    placed.splice(i, 0, [a, b]);
    return true;
  };

  const context = date(first).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  tryPlace(0, 8 + measure(context, true));

  const marks: TimelineMark[] = [];
  for (const level of levels) {
    // A time under every changeset only once a column can hold one; before that it's clutter.
    if (level.tick === 4 && colWidth < 34) continue;
    let prev = first > 0 ? level.key(date(first - 1), first - 1) : NaN;
    for (let col = first; col <= last; col++) {
      const d = date(col);
      const key = level.key(d, col);
      if (key === prev) continue;
      prev = key;
      const left = x(col);
      const text = level.label(d);
      if (!tryPlace(left - 1, left + 3 + measure(text, level.bold))) continue;
      marks.push({ x: left, text, bold: level.bold, tick: level.tick });
    }
  }
  return { context, marks };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function withAlpha(color: string, alpha: number) {
  if (color.startsWith("#") && color.length === 7) {
    const a = Math.round(alpha * 255)
      .toString(16)
      .padStart(2, "0");
    return color + a;
  }
  return color;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** A small filled house (roof + walls with a door cut out), centred on (x, y). */
function houseIcon(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x + 5, y - 0.6);
  ctx.lineTo(x + 3.4, y - 0.6);
  ctx.lineTo(x + 3.4, y + 4.4);
  ctx.lineTo(x + 1.1, y + 4.4);
  ctx.lineTo(x + 1.1, y + 1.4);
  ctx.lineTo(x - 1.1, y + 1.4);
  ctx.lineTo(x - 1.1, y + 4.4);
  ctx.lineTo(x - 3.4, y + 4.4);
  ctx.lineTo(x - 3.4, y - 0.6);
  ctx.lineTo(x - 5, y - 0.6);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** HEAD over uncommitted work: a hollow disc with the home symbol, in the accent colour. */
function hollowHome(ctx: CanvasRenderingContext2D, x: number, y: number, t: Theme) {
  ctx.beginPath();
  ctx.arc(x, y, HEAD_R, 0, Math.PI * 2);
  ctx.fillStyle = t.canvas;
  ctx.fill();
  // Dashed, like an empty changeset: nothing is committed here yet.
  ctx.setLineDash([3, 2]);
  ring(ctx, x, y, HEAD_R, t.accent, 2);
  ctx.setLineDash([]);
  houseIcon(ctx, x, y, t.accent);
}

/** A small solid arrow pointing up, its base at (x, y). */
function upArrow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x + 3.5, y - 2.5);
  ctx.lineTo(x + 1.2, y - 2.5);
  ctx.lineTo(x + 1.2, y);
  ctx.lineTo(x - 1.2, y);
  ctx.lineTo(x - 1.2, y - 2.5);
  ctx.lineTo(x - 3.5, y - 2.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, width: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Distance from (x, y) to the segment from (x1, y1) to (x2, y2). */
function segmentDistance(x: number, y: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : clamp(((x - x1) * dx + (y - y1) * dy) / len, 0, 1);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function arrowHead(ctx: CanvasRenderingContext2D, fromX: number, fromY: number, x: number, y: number, color: string) {
  const angle = Math.atan2(y - fromY, x - fromX);
  const size = 7;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - 0.45), y - size * Math.sin(angle - 0.45));
  ctx.lineTo(x - size * Math.cos(angle + 0.45), y - size * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
