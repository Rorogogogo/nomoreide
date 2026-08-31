//! Stages the frozen MCP contract where `include_str!` can reach it.
//!
//! `test/fixtures/mcp-contract-v1.json` is the shape the MCP surface promised
//! and must keep promising — shared with the parity harness, which is why it
//! lives at the workspace root rather than in this crate. `include_str!`
//! reached up into it with a relative path, which compiles in a checkout and
//! fails when the crate is packaged alone, the file being outside what
//! `cargo publish` ships.
//!
//! Same resolution order as the other two build scripts: the workspace copy
//! first, so a checkout compiles what is really there, then `vendored/`, which
//! `scripts/vendor-crate-assets.mjs` writes before publishing.

use std::path::{Path, PathBuf};

const CONTRACT_SUBPATH: &str = "test/fixtures/mcp-contract-v1.json";

fn main() {
    let out = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is set by cargo"));
    let manifest = PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo"),
    );

    let source = locate_contract(&manifest).unwrap_or_else(|| {
        panic!(
            "the frozen MCP contract was not found. Looked for {CONTRACT_SUBPATH} above \
             {} and for a vendored copy inside it. Run scripts/vendor-crate-assets.mjs \
             if you are packaging this crate.",
            manifest.display()
        )
    });

    println!("cargo:rerun-if-changed={}", source.display());
    std::fs::copy(&source, out.join("mcp-contract-v1.json"))
        .unwrap_or_else(|error| panic!("staging {}: {error}", source.display()));
}

fn locate_contract(manifest: &Path) -> Option<PathBuf> {
    let mut current = Some(manifest);
    while let Some(directory) = current {
        let candidate = directory.join(CONTRACT_SUBPATH);
        if candidate.is_file() {
            return Some(candidate);
        }
        current = directory.parent();
    }

    let vendored = manifest.join("vendored").join(CONTRACT_SUBPATH);
    vendored.is_file().then_some(vendored)
}
