/**
 * The Add Submodule window: choose the repository (a folder on this computer,
 * one of the workspace's repositories, or a remote URL) and where it goes in
 * this repository. "Choose Changeset…" then opens that repository's Branch
 * Explorer (see pick.ts); a remote one is cloned first, with git's progress
 * shown here.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message, open } from "@tauri-apps/plugin-dialog";
import type { RepoInfo } from "../view/workspaceList.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("sm-form");
const folderInput = $<HTMLInputElement>("sm-folder");
const urlInput = $<HTMLInputElement>("sm-url");
const pathInput = $<HTMLInputElement>("sm-path");
const list = $("sm-workspace");
const note = $("sm-note");
const progress = $("sm-progress");
const error = $("sm-error");
const next = $<HTMLButtonElement>("sm-next");

interface Info {
  repo: string;
  folder: string;
  workspace: string | null;
}

let info: Info | null = null;
/** Once the path has been typed in, it's no longer filled in from the repository's name. */
let pathTyped = false;
let busy = false;

const remote = () => form.querySelector<HTMLInputElement>('input[name="where"]:checked')?.value === "remote";
const source = () => (remote() ? urlInput.value : folderInput.value).trim();

/** "project" from https://host/owner/project.git, git@host:owner/project.git or /path/to/project. */
function nameOf(src: string): string {
  const path = src.trim().replace(/[/\\]+$/, "").replace(/\.git$/i, "");
  return path.split(/[/:\\]/).pop() ?? "";
}

function suggestPath() {
  if (pathTyped || !info) return;
  const name = nameOf(source());
  pathInput.value = name ? (info.folder ? `${info.folder}/${name}` : name) : info.folder ? `${info.folder}/` : "";
  describe();
}

function describe() {
  const path = pathInput.value.trim().replace(/^\/+|\/+$/g, "");
  note.textContent = path
    ? `Goes in ${path}/, staged with .gitmodules for your next commit.${remote() ? "" : " .gitmodules records the folder's location on this computer."}`
    : "";
}

function choose(where: "local" | "remote") {
  form.querySelector<HTMLInputElement>(`input[name="where"][value="${where}"]`)!.checked = true;
  $("sm-local").classList.toggle("off", where !== "local");
  $("sm-remote").classList.toggle("off", where !== "remote");
  error.textContent = "";
  suggestPath();
  describe();
}

/** The workspace's other repositories, to pick from with one click. */
async function showWorkspace() {
  if (!info?.workspace) return;
  let repos: RepoInfo[];
  try {
    repos = await invoke<RepoInfo[]>("find_repos", { root: info.workspace });
  } catch {
    return; // just no list
  }
  repos = repos.filter((r) => r.path !== info!.repo).sort((a, b) => a.name.localeCompare(b.name));
  if (repos.length === 0) return;
  list.replaceChildren(
    ...repos.map((r) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.dataset.path = r.path;
      const name = Object.assign(document.createElement("span"), { textContent: r.name });
      const where = Object.assign(document.createElement("span"), { className: "sm-list-path", textContent: r.remote?.host ?? r.path });
      b.append(name, where);
      b.onclick = () => {
        folderInput.value = r.path;
        choose("local");
        markListed();
      };
      b.ondblclick = () => form.requestSubmit();
      return b;
    }),
  );
  list.hidden = false;
  markListed();
}

function markListed() {
  for (const b of list.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-selected", String(b.dataset.path === folderInput.value.trim()));
}

async function browse() {
  const dir = await open({ directory: true, title: "Choose the repository to add", defaultPath: info?.workspace ?? undefined });
  if (typeof dir !== "string") return;
  folderInput.value = dir;
  choose("local");
  markListed();
}

async function submit() {
  if (!info || busy) return;
  error.textContent = "";
  const src = source();
  if (!src) {
    error.textContent = remote() ? "Enter the repository's URL" : "Choose the repository's folder";
    return;
  }
  busy = true;
  next.disabled = true;
  for (const el of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, #sm-browse, .sm-list button")) el.disabled = true;
  progress.textContent = remote() ? "Fetching its history…" : "";
  try {
    // On success this window closes and the Choose Changeset window opens.
    await invoke("choose_submodule_changeset", { repo: info.repo, path: pathInput.value, source: src, remote: remote() });
  } catch (err) {
    // git's errors can run to several lines: show them whole, in a message box.
    error.textContent = "Couldn't continue. See the message for why.";
    progress.textContent = "";
    await message(String(err), { title: remote() ? "Could not fetch the repository" : "Could not use that repository", kind: "error" });
    busy = false;
    next.disabled = false;
    for (const el of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, #sm-browse, .sm-list button")) el.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void submit();
});
for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="where"]')) radio.addEventListener("change", () => choose(radio.value as "local" | "remote"));
folderInput.addEventListener("focus", () => choose("local"));
urlInput.addEventListener("focus", () => choose("remote"));
folderInput.addEventListener("input", () => {
  suggestPath();
  markListed();
});
urlInput.addEventListener("input", suggestPath);
pathInput.addEventListener("input", () => {
  pathTyped = pathInput.value.trim() !== "";
  describe();
});
$("sm-browse").addEventListener("click", () => void browse());
$("sm-cancel").addEventListener("click", () => void getCurrentWindow().destroy());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !busy) void getCurrentWindow().destroy();
});
void listen<string>("submodule-progress", (e) => {
  progress.textContent = e.payload;
});

async function start() {
  info = await invoke<Info | null>("add_submodule_info");
  if (!info) {
    error.textContent = "This window doesn't know which repository to add to. Use Add Submodule… in the Files view.";
    next.disabled = true;
    return;
  }
  $("sm-repo").textContent = info.repo.split(/[/\\]/).pop() ?? info.repo;
  $("sm-repo").title = info.repo;
  pathInput.value = info.folder ? `${info.folder}/` : "";
  choose("local");
  folderInput.focus();
  void showWorkspace();
}

void start();
