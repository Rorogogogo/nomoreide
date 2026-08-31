//! Stages the bundled debug skill where `include_str!` can reach it.
//!
//! The skill's source of truth is `profiles/nomoreide-debug/` at the workspace
//! root — one copy, shared with everything else that reads it. `include_str!`
//! took a relative path straight out of the crate and up into that directory,
//! which compiles in a checkout and fails the moment the crate is packaged on
//! its own: `cargo publish` ships a crate's own directory, so those files were
//! simply absent and verification stopped at three "no such file" errors.
//!
//! Copying them into `OUT_DIR` fixes it without a second source of truth. The
//! sources are looked for in the same order the daemon's dashboard is:
//! the workspace copy first, so a checkout always compiles what is actually
//! there, then `vendored/` — written by `scripts/vendor-crate-assets.mjs`
//! before publishing, and the only one a published crate has.

use std::path::PathBuf;

/// Paths under the skill directory, and the names they keep in `OUT_DIR`.
/// Listed rather than globbed for the reason the Rust side lists them: a skill
/// quietly losing a file is worse than a build that stops.
const SKILL_FILES: &[&str] = &["SKILL.md", "agents/openai.yaml", "evals/evals.json"];

const SKILL_SUBPATH: &str = "profiles/nomoreide-debug/skills/nomoreide-debug";

fn main() {
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let manifest = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );

    let root = locate_skill(&manifest).unwrap_or_else(|| {
        panic!(
            "the bundled debug skill was not found. Looked for {SKILL_SUBPATH} above \
             {} and for a vendored copy inside it. Run scripts/vendor-crate-assets.mjs \
             if you are packaging this crate.",
            manifest.display()
        )
    });

    let staged = out.join("debug-skill");
    for relative in SKILL_FILES {
        let source = root.join(relative);
        println!("cargo:rerun-if-changed={}", source.display());
        let destination = staged.join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).expect("creating the staging directory");
        }
        std::fs::copy(&source, &destination)
            .unwrap_or_else(|error| panic!("staging {}: {error}", source.display()));
    }
}

/// The skill directory: the workspace copy if this is a checkout, else the
/// vendored one a published crate carries.
fn locate_skill(manifest: &std::path::Path) -> Option<PathBuf> {
    let mut current = Some(manifest);
    while let Some(directory) = current {
        let candidate = directory.join(SKILL_SUBPATH);
        if candidate.join("SKILL.md").is_file() {
            return Some(candidate);
        }
        current = directory.parent();
    }

    let vendored = manifest.join("vendored").join(SKILL_SUBPATH);
    vendored.join("SKILL.md").is_file().then_some(vendored)
}
