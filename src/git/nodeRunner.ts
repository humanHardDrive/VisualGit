// Node-only GitRunner, used by tests and scripts/inspect.ts (never bundled into the app).
import { execFile } from "node:child_process";
import type { GitRunner } from "./load.ts";

export function nodeRunner(repo: string): GitRunner {
  return {
    run(args) {
      return new Promise((resolve, reject) => {
        execFile(
          "git",
          ["-C", repo, "--no-pager", "-c", "core.quotepath=off", ...args],
          { maxBuffer: 512 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
          (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
        );
      });
    },
  };
}
