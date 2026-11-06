//! The native menu bar: the platform default menu, with the open commands at
//! the top of File. Choosing one emits a `menu` event carrying the item id to
//! the webview, which runs the command.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const OPEN_WORKSPACE: &str = "open-workspace";
const OPEN_REPOSITORY: &str = "open-repository";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Start from the default so Edit (copy/paste in text fields), Window and Quit keep working.
    let menu = Menu::default(app)?;
    let open_workspace = MenuItem::with_id(app, OPEN_WORKSPACE, "Open Workspace…", true, Some("CmdOrCtrl+Shift+O"))?;
    let open_repository = MenuItem::with_id(app, OPEN_REPOSITORY, "Open Repository…", true, Some("CmdOrCtrl+O"))?;

    let file = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(s) if s.text().is_ok_and(|t| t == "File") => Some(s),
        _ => None,
    });
    match file {
        Some(file) => file.insert_items(&[&open_workspace, &open_repository, &PredefinedMenuItem::separator(app)?], 0)?,
        // The default menu has no File menu on Linux.
        None => menu.prepend(&Submenu::with_items(app, "File", true, &[&open_workspace, &open_repository])?)?,
    }
    Ok(menu)
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == OPEN_WORKSPACE || id == OPEN_REPOSITORY {
        let _ = app.emit("menu", id);
    }
}
