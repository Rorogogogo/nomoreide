//! Write-capable operations, deliberately kept out of `nomoreide-core`.
//!
//! `nomoreide-core` is the read-safe crate: it inspects a repository, a
//! process, or a database without reaching outward to write. Operations that
//! *do* — pushing to a remote, integrating history, and later guarded database
//! writes and provider mutations — live here instead, mirroring the split
//! `src/core/git-manager.ts` and `src/core/git-actions.ts` draw on the
//! TypeScript side. Callers are expected to have confirmed with a human first.
//!
//! # What this boundary is not
//!
//! This crate does **not** encode "an agent cannot get here". An earlier draft
//! forbade `nomoreide-mcp` from depending on it, so that an agent reaching a
//! write would be a compile error. That is wrong: the frozen 90-tool manifest
//! (`test/fixtures/mcp-tool-manifest-v1.json`) includes `nomoreide_git_push`,
//! and the reference implements it by calling `GitActions.push` directly
//! (`src/mcp/tools/git.ts`). A crate-level ban would make that tool
//! unimplementable and break Phase 3 parity.
//!
//! What an agent may do with git is defined by the **MCP tool surface**, and
//! gated by `npm run mcp:parity -- --surface-only`, which diffs the exposed
//! tool list against that manifest. Adding a write tool fails the gate.
//!
//! # The line the reference actually draws
//!
//! The reference does not document its reasoning, so this is derived from the
//! manifest and the call sites rather than from a stated rule. Agents reach:
//!
//! - reads (`status`, `diff`, `log`, `branches`)
//! - local, reversible writes (`stage`, `unstage`, `commit`, branch creation
//!   and switching — git itself refuses rather than leaving a half-state)
//! - `push`, which sends commits outward and leaves the working tree untouched
//! - `github_merge_pr`, which merges server-side through the API — so "agents
//!   may not integrate history" is *not* the rule
//!
//! Agents do not reach `pull`, `merge`, `rebase`, or `pull_default`. Those four
//! are the only git operations that can stop halfway and leave the working tree
//! conflicted for a human to resolve, and `rebase` additionally rewrites hashes
//! that may already be shared. The code corroborates it: they are the only ones
//! guarded by [`git::GitActions`]'s clean-tree check and its `--abort` on
//! failure.
//!
//! The readable invariant is that an agent may change the repository but must
//! never leave the working tree in a state it cannot reason about. Whether to
//! relax it — exposing the four through this guarded path, which is arguably
//! safer than an agent reaching for raw `git` in a shell — is an open product
//! question, and belongs in the TypeScript reference first so both runtimes
//! stay diffable.

pub mod git;
