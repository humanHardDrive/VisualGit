import { describe, expect, it } from "vitest";
import { shortcutText, shownPath, slashPath } from "../src/platform.ts";

describe("paths", () => {
  it("keeps Windows paths with / so they match git's", () => {
    // A folder dialog's answer, and git's `rev-parse --show-toplevel` for the same folder.
    expect(slashPath("C:\\Users\\me\\Repos\\app")).toBe("C:/Users/me/Repos/app");
    expect(slashPath("C:/Users/me/Repos/app")).toBe("C:/Users/me/Repos/app");
    expect(slashPath("c:\\Repos\\app\\")).toBe("C:/Repos/app");
    expect(slashPath("C:\\")).toBe("C:/");
    expect(slashPath("\\\\server\\share\\app")).toBe("//server/share/app");
  });

  it("leaves other paths alone", () => {
    expect(slashPath("/Users/me/Repos/app")).toBe("/Users/me/Repos/app");
    expect(slashPath("/home/me/odd\\name")).toBe("/home/me/odd\\name");
    expect(slashPath("/")).toBe("/");
  });

  it("shows Windows paths with Windows' own separator", () => {
    expect(shownPath("C:/Users/me/Repos/app")).toBe("C:\\Users\\me\\Repos\\app");
    expect(shownPath("//server/share/app")).toBe("\\\\server\\share\\app");
    expect(shownPath("/Users/me/Repos/app")).toBe("/Users/me/Repos/app");
  });
});

describe("shortcuts", () => {
  it("names them as each platform does", () => {
    expect(shortcutText("Reload (⌘R)", true)).toBe("Reload (⌘R)");
    expect(shortcutText("Reload (⌘R)", false)).toBe("Reload (Ctrl+R)");
    expect(shortcutText("Open a folder of repositories (⇧⌘O)", false)).toBe("Open a folder of repositories (Ctrl+Shift+O)");
    expect(shortcutText("Commit message (⌘↩ commit · ⇧⌘↩ commit & push)", false)).toBe("Commit message (Ctrl+Enter commit · Ctrl+Shift+Enter commit & push)");
    expect(shortcutText("Previous change (⇧F7)", false)).toBe("Previous change (Shift+F7)");
    expect(shortcutText("⌘/Ctrl + scroll or pinch to zoom", false)).toBe("Ctrl + scroll or pinch to zoom");
  });
});
