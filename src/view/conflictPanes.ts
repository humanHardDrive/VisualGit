/**
 * Showing a conflict in three panes: Source and Destination coloured where
 * they differ, and the Result (its markers taken out, see `stripConflicts`)
 * with each conflict's two sides coloured and tagged, tracked as it's edited.
 * Colours come from the `cm-tw-*` and `tw-tag*` classes in merge.css.
 */

import { diff } from "@codemirror/merge";
import { RangeSetBuilder, StateEffect, StateField, type ChangeDesc, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { ConflictRegion } from "../git/conflicts.ts";

/** Marks every line touched by one of `ranges` (sorted, [from, to)) with `cls`. */
function markLines(ranges: [number, number][], cls: string) {
  const deco = Decoration.line({ class: cls });
  return EditorView.decorations.of((view) => {
    const doc = view.state.doc;
    const b = new RangeSetBuilder<Decoration>();
    let last = -1;
    for (const [from, to] of ranges) {
      for (let pos = from; pos < to && pos <= doc.length; ) {
        const line = doc.lineAt(pos);
        if (line.from > last) b.add(line.from, line.from, deco);
        last = line.from;
        pos = line.to + 1;
      }
    }
    return b.finish();
  });
}

/** Extensions for the Destination and Source panes: each marks its lines that differ from the other. */
export function sideHighlights(destination: string, source: string) {
  const changes = diff(destination, source);
  return {
    destination: markLines(changes.map((c) => [c.fromA, c.toA]), "cm-tw-dest"),
    source: markLines(changes.map((c) => [c.fromB, c.toB]), "cm-tw-source"),
  };
}

/** Replaces the conflicts being tracked (on loading or resetting a Result). */
export const setRegions = StateEffect.define<ConflictRegion[]>();
/** A conflict is settled (a side taken, or marked resolved): stop tracking it. */
export const dropRegion = StateEffect.define<number>();

const mapRange = (r: { from: number; to: number }, changes: ChangeDesc) => {
  // Text typed at either edge of a side joins that side.
  const from = changes.mapPos(r.from, -1);
  return { from, to: Math.max(from, changes.mapPos(r.to, -1)) };
};

/**
 * The Result's unresolved conflicts: where each one's Destination and Source
 * lines are, kept in step with edits. Its markers aren't in the text; this
 * is what remembers them.
 */
export const regionsField = StateField.define<ConflictRegion[]>({
  create: () => [],
  update(regions, tr) {
    let next = tr.docChanged ? regions.map((r) => ({ destination: mapRange(r.destination, tr.changes), source: mapRange(r.source, tr.changes) })) : regions;
    for (const e of tr.effects) {
      if (e.is(setRegions)) next = e.value;
      if (e.is(dropRegion)) next = next.filter((_, i) => i !== e.value);
    }
    return next;
  },
});

/** The faint "← Destination" / "← Source" after a side's first line, or a line saying a side has nothing. */
class Tag extends WidgetType {
  readonly text: string;
  readonly cls: string;
  readonly block: boolean;
  constructor(text: string, cls: string, block: boolean) {
    super();
    this.text = text;
    this.cls = cls;
    this.block = block;
  }
  eq(other: Tag) {
    return other.text === this.text && other.cls === this.cls && other.block === this.block;
  }
  toDOM() {
    const el = document.createElement(this.block ? "div" : "span");
    el.className = `tw-tag ${this.cls}${this.block ? " tw-tag-empty" : ""}`;
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function regionDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const side = (r: { from: number; to: number }, name: string, cls: string, tagCls: string, first: boolean) => {
    if (r.to <= r.from) {
      // Nothing from this side: say so, on a line of its own.
      decos.push(Decoration.widget({ widget: new Tag(`nothing from ${name}`, tagCls, true), block: true, side: -1 }).range(r.from));
      return;
    }
    let firstLine = true;
    for (let pos = r.from; pos < r.to && pos <= doc.length; ) {
      const line = doc.lineAt(pos);
      decos.push(Decoration.line({ class: `${cls}${firstLine && first ? " cm-tw-start" : ""}` }).range(line.from));
      if (firstLine) decos.push(Decoration.widget({ widget: new Tag(`← ${name}`, tagCls, false), side: 1 }).range(line.to));
      firstLine = false;
      if (line.to >= doc.length) break;
      pos = line.to + 1;
    }
  };
  for (const r of state.field(regionsField)) {
    side(r.destination, "Destination", "cm-tw-dest", "tw-tag-dest", true);
    side(r.source, "Source", "cm-tw-source", "tw-tag-source", r.destination.to <= r.destination.from);
  }
  return Decoration.set(decos, true);
}

/** For the Result pane: tracks `regions` (from `stripConflicts`) as it's edited, colouring and tagging each side. */
export const conflictRegions = (regions: ConflictRegion[]) => [
  regionsField.init(() => regions),
  EditorView.decorations.compute(["doc", regionsField], regionDecorations),
];
