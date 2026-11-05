import { invoke } from "@tauri-apps/api/core";
import type { GitRunner } from "./load.ts";

/** Runs read-only git commands through the Rust backend (see src-tauri/src/lib.rs). */
export function tauriRunner(repo: string): GitRunner {
  return { run: (args) => invoke<string>("git", { repo, args }) };
}

export const inTauri = () => "__TAURI_INTERNALS__" in window;
