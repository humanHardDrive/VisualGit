use std::process::Command;

fn main() {
    stamp_changeset();
    stamp_build_date();
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

/// Bakes the day the build script ran into the binary as `VISUALGIT_BUILD_DATE`
/// (YYYY-MM-DD, UTC), for the About panel. Honours `SOURCE_DATE_EPOCH` for
/// reproducible builds. The script reruns when the changeset does (above), so
/// a release build's date is the day it was built.
fn stamp_build_date() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    let secs = std::env::var("SOURCE_DATE_EPOCH").ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or_else(|| {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    });
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    println!("cargo:rustc-env=VISUALGIT_BUILD_DATE={y:04}-{m:02}-{d:02}");
}

/// Days since 1970-01-01 to a (year, month, day) date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
