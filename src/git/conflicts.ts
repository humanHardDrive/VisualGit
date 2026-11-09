/**
 * Conflict markers in a file git couldn't merge on its own:
 *
 *   <<<<<<< HEAD            ← destination (what's checked out, "ours")
 *   …destination's lines…
 *   ||||||| base            ← only with merge.conflictStyle = diff3 / zdiff3
 *   …common ancestor's lines…
 *   =======
 *   …source's lines…        ← what's being merged in ("theirs")
 *   >>>>>>> feature
 */

export interface Conflict {
  /** Start of the `<<<<<<<` line. */
  from: number;
  /** End of the `>>>>>>>` line, including its line break. */
  to: number;
  /** The destination's text (between `<<<<<<<` and `|||||||` or `=======`), with its line breaks. */
  destination: { from: number; to: number };
  /** The common ancestor's text, with diff3-style markers. */
  base: { from: number; to: number } | null;
  /** The source's text (between `=======` and `>>>>>>>`). */
  source: { from: number; to: number };
  /** Where each marker line starts and ends (without its line break). */
  markers: { from: number; to: number }[];
}

const MARK = 7;
const isMarker = (line: string, ch: string) => line.length >= MARK && line.startsWith(ch.repeat(MARK)) && (line.length === MARK || line[MARK] === " " || line[MARK] === "\r");

/** Every complete conflict block in `text`, in order. Unfinished blocks are ignored. */
export function parseConflicts(text: string): Conflict[] {
  const out: Conflict[] = [];
  // Line starts and ends, without the line break.
  const lines: { from: number; to: number; next: number }[] = [];
  for (let at = 0; at <= text.length; ) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl;
    lines.push({ from: at, to: end, next: nl < 0 ? text.length : nl + 1 });
    if (nl < 0) break;
    at = nl + 1;
  }
  const textOf = (i: number) => text.slice(lines[i].from, lines[i].to);
  for (let i = 0; i < lines.length; i++) {
    if (!isMarker(textOf(i), "<")) continue;
    let base = -1;
    let mid = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = textOf(j);
      if (isMarker(t, "<")) break; // a new block started before this one ended
      if (mid < 0 && base < 0 && isMarker(t, "|")) base = j;
      else if (mid < 0 && isMarker(t, "=")) mid = j;
      else if (mid >= 0 && isMarker(t, ">")) {
        end = j;
        break;
      }
    }
    if (mid < 0 || end < 0) continue;
    const destEnd = base >= 0 ? base : mid;
    out.push({
      from: lines[i].from,
      to: lines[end].next,
      destination: { from: lines[i].next, to: lines[destEnd].from },
      base: base >= 0 ? { from: lines[base].next, to: lines[mid].from } : null,
      source: { from: lines[mid].next, to: lines[end].from },
      markers: [i, ...(base >= 0 ? [base] : []), mid, end].map((k) => ({ from: lines[k].from, to: lines[k].to })),
    });
    i = end;
  }
  return out;
}

/** Where one conflict's two sides are in a file with its markers taken out. */
export interface ConflictRegion {
  destination: { from: number; to: number };
  source: { from: number; to: number };
}

/**
 * The file with its conflict markers (and diff3's common-ancestor lines)
 * taken out, leaving each conflict's Destination lines followed by its
 * Source lines, plus where those are. Positions count each line break as one
 * character, as an editor does, so they hold for CRLF files too; the text
 * keeps its own line endings. Each range runs from the start of its first
 * line to the start of the line after its last.
 */
export function stripConflicts(text: string): { text: string; regions: ConflictRegion[] } {
  const lines = text.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const lineOf = (at: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // Each line's part in its block; lines outside any block have none.
  type Role = "open" | "destination" | "base" | "mid" | "source" | "close";
  const role: (Role | undefined)[] = [];
  for (const c of parseConflicts(text)) {
    const at = c.markers.map((m) => lineOf(m.from));
    const [open, close, mid] = [at[0], at[at.length - 1], at[at.length - 2]];
    const ancestor = c.base ? at[1] : mid; // diff3's ||||||| line, else straight to =======
    role[open] = "open";
    for (let l = open + 1; l < ancestor; l++) role[l] = "destination";
    for (let l = ancestor; l < mid; l++) role[l] = "base";
    role[mid] = "mid";
    for (let l = mid + 1; l < close; l++) role[l] = "source";
    role[close] = "close";
  }

  const kept: string[] = [];
  const regions: ConflictRegion[] = [];
  let pos = 0; // in editor positions: a line break is one character
  let block: ConflictRegion | null = null;
  for (let l = 0; l < lines.length; l++) {
    const r = role[l];
    if (r === "open") {
      block = { destination: { from: pos, to: pos }, source: { from: pos, to: pos } };
      regions.push(block);
      continue;
    }
    if (r === "mid" && block) block.source = { from: pos, to: pos };
    if (r === "close") block = null;
    if (r === "base" || r === "mid" || r === "close") continue;
    const line = lines[l];
    pos += (line.endsWith("\r") ? line.length - 1 : line.length) + (l < lines.length - 1 ? 1 : 0);
    if (block && r === "destination") block.destination.to = pos;
    if (block && r === "source") block.source.to = pos;
    kept.push(line);
  }
  // A closing marker on the very last line (no line break after it) leaves the text a character shorter.
  const length = kept.reduce((n, l) => n + (l.endsWith("\r") ? l.length - 1 : l.length), 0) + Math.max(0, kept.length - 1);
  const clamp = (r: { from: number; to: number }) => ({ from: Math.min(r.from, length), to: Math.min(r.to, length) });
  return { text: kept.join("\n"), regions: regions.map((r) => ({ destination: clamp(r.destination), source: clamp(r.source) })) };
}
