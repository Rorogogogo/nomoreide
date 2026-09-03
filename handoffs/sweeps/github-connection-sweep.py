#!/usr/bin/env python3
"""Seeded regression sweep for the github-connection parity gate.

Each seed breaks one behaviour the gate claims to cover. A seed the gate does
not notice is a hole in the gate, not a mercy.

Sources are restored from an in-memory backup rather than from git, because
this tree has parallel writers and uncommitted work that `git checkout` would
eat. The binary is rebuilt at the end so the next gate run tests the restored
source rather than the last seed.
"""
import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GITHUB_RS = "crates/nomoreide-daemon/src/server/routes/github.rs"
CONFIG_RS = "crates/nomoreide-core/src/config.rs"

SEEDS = [
    ("configured-ignores-a-gh-account", GITHUB_RS,
     "token.is_some() || matches!(selected, Some(GithubCredentialSelection::Gh { .. })),",
     "token.is_some(),",
     "status/gh-credential-no-stored-token"),

    ("storing-a-token-keeps-the-old-identity", GITHUB_RS,
     ".set_github_token(host.clone(), token.to_string(), profile)",
     ".set_github_token(host.clone(), token.to_string(), None)",
     "status/token-only"),

    ("a-404-is-not-told-apart-from-a-failure", GITHUB_RS,
     "Err(reason) if reason.status == 404 => {",
     "Err(reason) if reason.status == 410 => {",
     "status/repository-not-visible"),

    ("a-403-is-not-an-auth-error", GITHUB_RS,
     "Self::Api(error) if error.status == 401 || error.status == 403 => \"auth_error\",",
     "Self::Api(error) if error.status == 401 => \"auth_error\",",
     "status/forbidden"),

    ("slow-down-is-treated-as-a-refusal", GITHUB_RS,
     'if matches!(code, Some("authorization_pending") | Some("slow_down")) {',
     'if matches!(code, Some("authorization_pending")) {',
     "oauth/poll-slow-down"),

    ("a-zero-timing-takes-the-default", GITHUB_RS,
     "        Some(Value::Null) | None => fallback,\n        Some(value) => value.clone(),",
     "        Some(value) if truthy(value) => value.clone(),\n        _ => fallback,",
     "oauth/start-null-and-zero"),

    ("a-refusal-reports-its-code-not-its-description", GITHUB_RS,
     'for key in ["error_description", "error"] {',
     'for key in ["error", "error_description"] {',
     "oauth/start-refused"),

    ("an-empty-error-counts-as-an-error", GITHUB_RS,
     "Value::String(text) => !text.is_empty(),",
     "Value::String(_) => true,",
     "oauth/start-empty-error"),

    ("the-avatar-loses-its-size", GITHUB_RS,
     '        "https://github.com/{}.png?size=64",\n        encode_uri_component(login)',
     '        "https://github.com/{}.png",\n        encode_uri_component(login)',
     "status/avatar-derived-from-the-login"),

    ("the-avatar-does-not-escape-its-login", GITHUB_RS,
     '        "https://github.com/{}.png?size=64",\n        encode_uri_component(login)',
     '        "https://github.com/{}.png?size=64",\n        login',
     "status/avatar-escapes-the-login"),

    ("an-enterprise-host-is-accepted", GITHUB_RS,
     'if !host.is_empty() && host != GITHUB_HOST {',
     'if false {',
     "account/enterprise-host"),

    ("an-unknown-credential-source-is-accepted", GITHUB_RS,
     'Some("stored") => {',
     'Some("stored") | Some("basic") => {',
     "account/unsupported-source"),

    ("a-blank-token-is-stored", GITHUB_RS,
     '        .map(|token| token.trim())\n        .filter(|token| !token.is_empty())',
     '        .map(|token| token.trim())',
     "token/blank-token"),

    ("an-empty-access-token-completes-the-flow", GITHUB_RS,
     '        .and_then(Value::as_str)\n        .filter(|token| !token.is_empty())\n    {',
     '        .and_then(Value::as_str)\n    {',
     "oauth/poll-empty-token"),

    ("device-flow-fields-are-filtered-to-strings", GITHUB_RS,
     '    for key in ["device_code", "user_code", "verification_uri"] {\n        if let Some(value) = data.get(key) {',
     '    for key in ["device_code", "user_code", "verification_uri"] {\n        if let Some(value) = data.get(key).filter(|value| value.is_string()) {',
     "oauth/start-unexpected-types"),

    ("a-null-description-hides-the-error-code", GITHUB_RS,
     "            Some(Value::Null) | None => continue,",
     "            None => continue,",
     "oauth/start-refused-with-a-null-description"),

    ("polling-gates-its-refusal-on-truthiness", GITHUB_RS,
     '        Value::Null => bad_request("Authorization failed"),',
     '        reason if !truthy(&reason) => bad_request("Authorization failed"),',
     "oauth/poll-empty-error"),

    ("an-array-credential-reads-as-a-missing-one", GITHUB_RS,
     "        .filter(|value| value.is_object() || value.is_array());",
     "        .filter(|value| value.is_object());",
     "account/credential-is-an-array"),

    ("an-unnamed-account-is-tidied-up", GITHUB_RS,
     'avatar_url.unwrap_or_else(|| avatar_for_login(login.as_deref().unwrap_or("undefined")));',
     'avatar_url.unwrap_or_else(|| avatar_for_login(login.as_deref().unwrap_or("")));',
     "status/account-github-would-not-name"),

    ("removing-a-token-removes-nothing", CONFIG_RS,
     "        config.github_tokens.retain(|t| t.host != host);\n        self.save(&config).await?;\n        Ok(config)\n    }\n\n    /// Cached account identity",
     "        self.save(&config).await?;\n        Ok(config)\n    }\n\n    /// Cached account identity",
     # The DELETE answers `{ok:true}` whether or not it removed anything — the
     # reference's does too — so the removal is observed by the status check
     # that follows it, not by the call that performed it.
     "status/after-removal"),
]


def read(path):
    with open(os.path.join(ROOT, path)) as handle:
        return handle.read()


def write(path, text):
    with open(os.path.join(ROOT, path), "w") as handle:
        handle.write(text)


def cargo_is_busy():
    """Another build holds the target lock.

    Seeding rewrites source and rebuilds, so a concurrent `cargo build` — or a
    gate run of my own — turns every result into a race: the binary under test
    may be one edit behind the source, and a pass or a fail then means nothing.
    Refuse rather than produce a verdict that cannot be trusted.
    """
    lock = os.path.join(ROOT, "target", "debug", ".cargo-lock")
    probe = subprocess.run(["cargo", "build", "-p", "nomoreide-cli", "--quiet"], cwd=ROOT,
                           capture_output=True, text=True, timeout=900)
    return "Blocking waiting for file lock" in probe.stderr or not os.path.exists(lock)


def main():
    backups = {path: read(path) for path in {seed[1] for seed in SEEDS}}

    # Every anchor, up front. rustfmt reflows code between the day a seed is
    # written and the day it runs, and a seed whose anchor has moved reports
    # "not unique" an hour into a sweep rather than in the first second.
    stale = [
        (name, backups[path].count(old))
        for name, path, old, _new, _expected in SEEDS
        if backups[path].count(old) != 1
    ]
    if stale:
        for name, count in stale:
            print(f"SEED-ANCHOR-STALE  {name}  (matches: {count})")
        print("\nFix the anchors before sweeping; nothing was changed.")
        return 2

    if cargo_is_busy():
        print("Another cargo build holds the target lock. Wait for it to finish:")
        print("a seeded sweep that races a build tests the wrong binary.")
        return 2
    results = []
    try:
        for name, path, old, new, expected in SEEDS:
            source = backups[path]
            if source.count(old) != 1:
                results.append((name, "SEED-NOT-UNIQUE", source.count(old)))
                continue
            write(path, source.replace(old, new, 1))
            build = subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=ROOT, capture_output=True, text=True)
            if build.returncode != 0:
                results.append((name, "SEED-DID-NOT-COMPILE", build.stderr[-400:]))
                write(path, source)
                continue
            gate = subprocess.run(
                ["node", "--import", "tsx", "scripts/check-github-connection-parity.ts",
                 "./target/debug/nomoreide"],
                cwd=ROOT, capture_output=True, text=True)
            failed = [line for line in gate.stdout.splitlines() if line.startswith("FAIL ")]
            names = {line.split()[1] for line in failed}
            if gate.returncode == 0:
                results.append((name, "GATE-DID-NOT-BITE", expected))
            elif expected in names:
                results.append((name, "caught", f"{len(names)} case(s), incl. {expected}"))
            else:
                results.append((name, "CAUGHT-BY-ANOTHER-CASE", f"expected {expected}, got {sorted(names)}"))
            write(path, source)
            print(f"{results[-1][1]:24} {name}", flush=True)
    finally:
        for path, source in backups.items():
            write(path, source)
        # The restored source is not the built binary until this runs.
        subprocess.run(["cargo", "build", "-p", "nomoreide-cli"], cwd=ROOT, capture_output=True, text=True)

    print("\n=== sweep ===")
    for name, verdict, detail in results:
        print(f"{verdict:24} {name}  ({detail})")
    caught = sum(1 for _, verdict, _ in results if verdict == "caught")
    print(f"\ncaught {caught}/{len(results)}")
    return 0 if caught == len(results) else 1


# **Guarded on purpose.** Importing this file to reuse SEEDS -- to validate the
# anchors, say -- must not start a sweep. Without the guard the import runs
# main(), which mutates the sources and leaves a seed behind if it is killed.
if __name__ == "__main__":
    sys.exit(main())
