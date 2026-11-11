/**
 * What differs between operating systems, for the pages: how absolute paths
 * are written, what keyboard shortcuts are called, and what the Trash is called.
 *
 * Absolute paths are kept in one form throughout the pages, with `/` between
 * folders, as git prints them (`C:/Users/me/repo` on Windows), so they can be
 * compared and joined with `/`. The backend sends them that way; folders
 * chosen in a dialog go through `slashPath`. Only text shown to the user goes
 * back to Windows' `\` (`shownPath`).
 */

const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
export const isMac = agent.includes("Mac");
export const isWindows = agent.includes("Windows");

/** Where removed files go, as the user knows it. */
export const TRASH = isWindows ? "Recycle Bin" : "Trash";

/** A Windows path: `C:\…` or `\\server\share\…`, with either slash. */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/**
 * An absolute path as the pages keep it. A Windows one gets `/` between
 * folders, a capital drive letter and no trailing `/` (`c:\Repos\app\` →
 * `C:/Repos/app`); any other is left as it is.
 */
export function slashPath(path: string): string {
  if (!WINDOWS_PATH.test(path)) return path;
  let p = path.replace(/\\/g, "/");
  if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  return p.length > 3 ? p.replace(/\/+$/, "") : p; // "C:/" itself keeps its slash
}

/** A path to show the user: a Windows one with Windows' own `\`. */
export function shownPath(path: string): string {
  return WINDOWS_PATH.test(path) ? path.replace(/\//g, "\\") : path;
}

/**
 * Shortcuts are written as macOS shows them (⇧⌘O, ⌘↩); elsewhere they're
 * Ctrl+Shift+O and Ctrl+Enter.
 */
export function shortcutText(text: string, mac = isMac): string {
  if (mac) return text;
  return text
    .replace(/⌘\/Ctrl/g, "Ctrl")
    .replace(/⇧⌘/g, "Ctrl+Shift+")
    .replace(/⌘/g, "Ctrl+")
    .replace(/⇧/g, "Shift+")
    .replace(/↩/g, "Enter");
}

const SHORTCUT = /[⌘⇧↩]/;

/** Rewrites the shortcuts in a page's tooltips, placeholders and text for this platform (see `shortcutText`). */
export function localizeShortcuts(root: HTMLElement = document.body) {
  if (isMac) return;
  for (const el of root.querySelectorAll<HTMLElement>("[title], [placeholder], [aria-label]")) {
    for (const attr of ["title", "placeholder", "aria-label"]) {
      const value = el.getAttribute(attr);
      if (value && SHORTCUT.test(value)) el.setAttribute(attr, shortcutText(value));
    }
  }
  const text = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = text.nextNode(); n; n = text.nextNode()) {
    if (n.nodeValue && SHORTCUT.test(n.nodeValue)) n.nodeValue = shortcutText(n.nodeValue);
  }
}
