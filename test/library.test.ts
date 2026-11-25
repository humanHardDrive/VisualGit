import { describe, expect, it } from "vitest";
import { addRepository, addWorkspace, carriedOver, emptyLibrary, groupLibrary, removeRepository, removeWorkspace } from "../src/model/library.ts";
import type { RepoInfo } from "../src/view/workspaceList.ts";

const repo = (path: string, name = path.split("/").pop()!): RepoInfo => ({ path, name, head: "main", detached: false });
const inside = (p: string, root: string) => p.startsWith(`${root}/`);

describe("repository list", () => {
  it("adds workspaces and repositories once, and forgets them", () => {
    let lib = addWorkspace(emptyLibrary(), "/code");
    expect(addWorkspace(lib, "/code")).toBe(lib);
    lib = addRepository(lib, "/elsewhere/tool", () => false);
    expect(addRepository(lib, "/elsewhere/tool", () => false)).toBe(lib);
    // One a workspace already lists isn't added on its own.
    expect(addRepository(lib, "/code/app", (p) => p === "/code/app")).toBe(lib);
    expect(lib).toEqual({ workspaces: ["/code"], repositories: ["/elsewhere/tool"], last: null });

    lib = { ...lib, last: "/elsewhere/tool" };
    expect(removeRepository(lib, "/elsewhere/tool")).toEqual({ workspaces: ["/code"], repositories: [], last: null });
    expect(removeWorkspace(lib, "/code").workspaces).toEqual([]);
  });

  it("carries over the workspace and last repository remembered before", () => {
    expect(carriedOver("/code", "/code/app", inside)).toEqual({ workspaces: ["/code"], repositories: [], last: "/code/app" });
    expect(carriedOver("/code", "/other/x", inside)).toEqual({ workspaces: ["/code"], repositories: ["/other/x"], last: "/other/x" });
    expect(carriedOver(null, null, inside)).toEqual(emptyLibrary());
  });

  it("groups by workspace, lists each repository once, and keeps missing ones", () => {
    const lib = { workspaces: ["/code", "/work", "/usb"], repositories: ["/code/app", "/tools/x", "/gone/y"], last: null };
    const scans = new Map<string, RepoInfo[] | null>([
      ["/code", [repo("/code/app"), repo("/code/web")]],
      // Nested workspace folders: a repository found by both is listed under the first.
      ["/work", [repo("/code/web"), repo("/work/fw")]],
      ["/usb", null],
    ]);
    const singles = new Map<string, RepoInfo | null>([
      ["/tools/x", repo("/tools/x")],
      ["/gone/y", null],
    ]);
    const groups = groupLibrary(lib, scans, singles);
    expect(groups.map((g) => [g.kind, g.path, g.missing, g.repos.map((r) => r.path)])).toEqual([
      ["workspace", "/code", false, ["/code/app", "/code/web"]],
      ["workspace", "/work", false, ["/work/fw"]],
      ["workspace", "/usb", true, []],
      // /code/app was added on its own too, but its workspace lists it.
      ["repositories", undefined, false, ["/tools/x", "/gone/y"]],
    ]);
    const own = groups[3].repos;
    expect(own.map((r) => [r.own, !!r.missing])).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(own[1].name).toBe("y");
  });
});
