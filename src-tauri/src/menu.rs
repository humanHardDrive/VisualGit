//! The native menu bar: the platform default menu, with the open commands at
//! the top of File and an About panel carrying version, changeset, author and
//! copyright. Choosing an open command emits a `menu` event carrying the item
//! id to the webview, which runs the command.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const OPEN_WORKSPACE: &str = "open-workspace";
const OPEN_REPOSITORY: &str = "open-repository";

/// The commit this binary was built from (see build.rs).
const CHANGESET: &str = env!("VISUALGIT_CHANGESET");

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Start from the default so Edit (copy/paste in text fields), Window and Quit keep working.
    let menu = Menu::default(app)?;
    let open_workspace = MenuItem::with_id(app, OPEN_WORKSPACE, "Open Workspace…", true, Some("CmdOrCtrl+Shift+O"))?;
    let open_repository = MenuItem::with_id(app, OPEN_REPOSITORY, "Open Repository…", true, Some("CmdOrCtrl+O"))?;

    let submenus: Vec<Submenu<R>> = menu.items()?.into_iter().filter_map(|item| item.as_submenu().cloned()).collect();
    match submenus.iter().find(|s| s.text().is_ok_and(|t| t == "File")) {
        Some(file) => file.insert_items(&[&open_workspace, &open_repository, &PredefinedMenuItem::separator(app)?], 0)?,
        // The default menu has no File menu on Linux.
        None => menu.prepend(&Submenu::with_items(app, "File", true, &[&open_workspace, &open_repository])?)?,
    }

    // The default About item (app menu on macOS, Help elsewhere) only knows the version.
    for submenu in &submenus {
        for (i, item) in submenu.items()?.into_iter().enumerate() {
            if let MenuItemKind::Predefined(p) = &item {
                if p.text().is_ok_and(|t| t.starts_with("About")) {
                    submenu.remove(p)?;
                    submenu.insert(&PredefinedMenuItem::about(app, None, Some(about(app)))?, i)?;
                }
            }
        }
    }
    Ok(menu)
}

fn about<R: Runtime>(app: &AppHandle<R>) -> AboutMetadata<'static> {
    let pkg = app.package_info();
    let authors: Vec<String> = env!("CARGO_PKG_AUTHORS").split(':').map(str::to_string).collect();
    let short = &CHANGESET[..CHANGESET.len().min(8)];
    AboutMetadata {
        name: Some(pkg.name.clone()),
        // macOS shows "Version <short_version> (<version>)", the usual place for a build id.
        short_version: Some(pkg.version.to_string()),
        version: Some(if cfg!(target_os = "macos") { short.to_string() } else { format!("{} ({short})", pkg.version) }),
        copyright: app.config().bundle.copyright.clone(),
        // macOS shows `credits`; other platforms show `authors`, `comments` and the website.
        credits: Some(format!("Author: {}\nChangeset: {CHANGESET}", authors.join(", "))),
        authors: Some(authors),
        comments: Some(format!("Changeset {CHANGESET}")),
        license: Some(env!("CARGO_PKG_LICENSE").into()),
        website: Some(env!("CARGO_PKG_REPOSITORY").into()),
        ..Default::default()
    }
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == OPEN_WORKSPACE || id == OPEN_REPOSITORY {
        let _ = app.emit("menu", id);
    }
}
