/** .gitignore patterns for one file: by name, by extension, or by exact path. */

/** Escapes characters gitignore would read as pattern syntax, so the name matches literally. */
export function escapePattern(text: string): string {
  return text
    .replace(/[\\*?[]/g, "\\$&")
    .replace(/^[#!]/, "\\$&")
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
}

export interface IgnoreChoices {
  /** `name.ext`: this name in any folder. */
  name: string;
  /** `*.ext`: every file with this extension; null for a file without one. */
  extension: string | null;
  /** `/path/to/name.ext`: only this file. */
  path: string;
}

export function ignorePatterns(path: string): IgnoreChoices {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // ".gitignore" or "Makefile" have no extension; "archive.tar.gz" has "gz".
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : null;
  return {
    name: escapePattern(name),
    extension: ext ? `*.${escapePattern(ext)}` : null,
    path: `/${path.split("/").map(escapePattern).join("/")}`,
  };
}
