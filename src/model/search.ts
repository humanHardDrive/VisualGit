/**
 * Search over the explorer: branch names, changeset ids and commit messages.
 *
 * Matching is case-insensitive and finds the query anywhere in the text.
 * Wildcards: `*` matches any run of characters (including none), `?` exactly one.
 * So `feat*login` finds `feature/login-page`, and `v1.?` finds `v1.2`.
 */

import type { Model } from "./infer.ts";

export interface SearchResults {
  /** Branch ids whose name matches, in model order. */
  branches: number[];
  /** Matching changesets: changeset-id matches first, then newest first. */
  commits: string[];
}

const escape = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turns a query into a regular expression, or null for an empty query. */
export function compileQuery(query: string): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  const source = [...q].map((ch) => (ch === "*" ? ".*" : ch === "?" ? "." : escape(ch))).join("");
  // `s`: a wildcard may span the lines of a multi-line message.
  return new RegExp(source, "is");
}

export function searchModel(model: Model, query: string): SearchResults | null {
  const re = compileQuery(query);
  if (!re) return null;
  // Changeset ids match from their start, once the query looks like one (4+ hex digits).
  const literal = query.trim().replace(/[*?]/g, "");
  const idRe = literal.length >= 4 && /^[0-9a-f]+$/i.test(literal) ? new RegExp(`^${re.source}`, "is") : null;

  const branches = model.branches.filter((b) => re.test(b.name)).map((b) => b.id);
  const byId: string[] = [];
  const byText: string[] = [];
  for (let i = model.order.length - 1; i >= 0; i--) {
    const hash = model.order[i];
    const c = model.commits.get(hash)!;
    if (idRe?.test(hash)) byId.push(hash);
    else if (re.test(c.subject) || (c.body && re.test(c.body)) || model.tags.get(hash)?.some((t) => re.test(t))) {
      byText.push(hash);
    }
  }
  return { branches, commits: [...byId, ...byText] };
}
