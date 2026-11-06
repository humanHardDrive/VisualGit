use std::process::Command;

fn main() {
    stamp_changeset();
    tauri_build::build()
}

/// Bakes the changeset being built into the binary as `VISUALGIT_CHANGESET`
/// (shown in the About panel). Set the variable yourself to override it, e.g.
/// when building from a source archive with no `.git`.
fn stamp_changeset() {
    println!("cargo:rerun-if-env-changed=VISUALGIT_CHANGESET");
    // HEAD's reflog changes on every commit, checkout and merge.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/logs/HEAD");

    let changeset = std::env::var("VISUALGIT_CHANGESET").ok().filter(|s| !s.is_empty()).or_else(|| {
        let out = Command::new("git").args(["rev-parse", "HEAD"]).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    });
    println!("cargo:rustc-env=VISUALGIT_CHANGESET={}", changeset.unwrap_or_else(|| "unknown".into()));
}
