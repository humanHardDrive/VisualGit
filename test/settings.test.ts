import { describe, expect, it } from "vitest";
import { defaults, normalize } from "../src/settings/settings.ts";

describe("settings", () => {
  it("reads a missing or damaged file as the defaults", () => {
    expect(normalize(null)).toEqual(defaults());
    expect(normalize("nonsense")).toEqual(defaults());
    expect(normalize([])).toEqual(defaults());
  });

  it("keeps what's valid and puts back defaults for the rest", () => {
    const s = normalize({
      theme: "dark",
      accent: "#FF0000",
      interfaceScale: 9,
      codeFont: "Fira Code",
      codeSize: 14,
      branchColors: ["#00ff00", "red", 3],
      diff: { ignoreWhitespace: "all", wrap: "yes" },
      tools: {
        diff: { kind: "custom", command: "code --wait --diff $LOCAL $REMOTE" },
        merge: { kind: "sometimes", command: 5 },
        open: [{ name: "VS Code", command: "code $FILE" }, "junk"],
      },
    });
    expect(s.theme).toBe("dark");
    expect(s.accent).toBe("#ff0000");
    expect(s.interfaceScale).toBe(1); // out of range
    expect(s.codeFont).toBe("Fira Code");
    expect(s.codeSize).toBe(14);
    expect(s.branchColors).toEqual(["#00ff00"]);
    expect(s.diff).toEqual({ ignoreWhitespace: "all", wrap: false });
    expect(s.tools.diff).toEqual({ kind: "custom", command: "code --wait --diff $LOCAL $REMOTE" });
    expect(s.tools.merge).toEqual({ kind: "builtin", command: "" });
    expect(s.tools.open).toEqual([
      { name: "VS Code", command: "code $FILE" },
      { name: "", command: "" },
    ]);
  });

  it("never lets the code font become CSS", () => {
    expect(normalize({ codeFont: 'x"; } body { display: none' }).codeFont).toBe("");
    expect(normalize({ accent: "red; color: blue" }).accent).toBeNull();
  });
});
