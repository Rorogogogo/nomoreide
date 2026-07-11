# Migrating from brainctl to NoMoreIDE

brainctl is now part of NoMoreIDE as the **Agent Environments** feature. One
install gives you everything brainctl did — live agent config inspection,
staged MCP/skill edits, portable profiles, and the hosted profile registry —
plus NoMoreIDE's service, git, and database tooling.

```bash
npm i -g nomoreide
```

The hosted registry (www.brainctl.net) **keeps running** — your account,
published profiles, and installs all keep working through NoMoreIDE. Your
existing sign-in carries over automatically: NoMoreIDE reads the same
`~/.brainctl/config.json` and honors the same `BRAINCTL_*` environment
variables.

## Command mapping

| brainctl | NoMoreIDE |
|---|---|
| `brainctl status` | `nomoreide agents status` |
| `brainctl doctor` | `nomoreide agents doctor` |
| `brainctl ui` | `nomoreide web` (Agent Environments page) |
| `brainctl mcp` | `nomoreide mcp` (see [MCP tool mapping](#mcp-tool-mapping)) |
| `brainctl profile list` | `nomoreide profile list` |
| `brainctl profile create` | `nomoreide profile snapshot <agent> <name>` (or create in the web UI) |
| `brainctl profile snapshot` | `nomoreide profile snapshot <agent> <name>` |
| `brainctl profile apply` | `nomoreide profile apply <name> <agent> [--dry-run]` |
| `brainctl profile export` | `nomoreide profile export <name> [--output <path>]` |
| `brainctl profile import` | `nomoreide profile import <archive> [--force] [--as <name>]` |
| `brainctl profile install` | `nomoreide profile install <slug> [--force] [--as <name>]` |
| `brainctl profile register-github` | web UI / `nomoreide_profiles_register_github` MCP tool |
| `brainctl config status/get/set/unset` | sign in from the web UI, or `BRAINCTL_API_TOKEN` / `BRAINCTL_API_BASE_URL` env vars |
| `brainctl run` | **dropped** — agents connect via MCP instead of a skill executor |

## MCP tool mapping

Point your agent at NoMoreIDE instead of brainctl:

```bash
claude mcp remove brainctl
claude mcp add --transport stdio nomoreide -- npx -y nomoreide
```

| brainctl tool | NoMoreIDE tool |
|---|---|
| `brainctl_status` | `nomoreide_agents_status` |
| `brainctl_doctor` | `nomoreide_agents_doctor` |
| `brainctl_read_agent_configs` | `nomoreide_agents_read_configs` |
| `brainctl_add_agent_mcp` | `nomoreide_agents_add_mcp` |
| `brainctl_remove_agent_mcp` | `nomoreide_agents_remove_mcp` |
| `brainctl_move_agent_mcp_scope` | `nomoreide_agents_move_mcp_scope` |
| `brainctl_move_agent_skill_scope` | `nomoreide_agents_move_skill_scope` |
| `brainctl_snapshot_agent` | `nomoreide_agents_snapshot_agent` |
| `brainctl_list_profiles` | `nomoreide_profiles_list` |
| `brainctl_get_profile` | `nomoreide_profiles_get` |
| `brainctl_create_profile` | `nomoreide_profiles_create` |
| `brainctl_update_profile` | `nomoreide_profiles_update` |
| `brainctl_delete_profile` | `nomoreide_profiles_delete` |
| `brainctl_copy_profile_items` | `nomoreide_profiles_copy_items` |
| `brainctl_apply_profile` | `nomoreide_profiles_apply` (dry-run built in) |
| `brainctl_export_profile` | `nomoreide_profiles_export` |
| `brainctl_import_profile` | `nomoreide_profiles_import` |
| `brainctl_publish_profile` | `nomoreide_profiles_publish` |
| `brainctl_install_registry_profile` | `nomoreide_profiles_install_from_registry` |
| `brainctl_register_github_profile` | `nomoreide_profiles_register_github` |
| `brainctl_config_status` | `GET /api/agent-env/auth/status` (web UI registry bar) |
| `brainctl_open_ui` / `brainctl_close_ui` | `nomoreide_open_ui` / `nomoreide_close_ui` |

## What changed

- **Profile storage**: NoMoreIDE stores profiles as JSON under
  `~/.config/nomoreide/agent-profiles/`, not brainctl's YAML under
  `~/.brainctl/profiles/`. Existing local brainctl profiles are **not**
  auto-migrated — re-snapshot your live agent once
  (`nomoreide profile snapshot claude my-setup`) and you're done.
- **Registry archives**: profiles you published with brainctl use its YAML
  archive layout, which NoMoreIDE can't import. Re-snapshot and re-publish
  (`nomoreide profile publish`) so installers on NoMoreIDE can use them.
- **Write safety**: every agent-config mutation goes through a preview →
  apply gate and writes a timestamped backup first; responses echo the
  backup paths.
- **Dropped**: the `run` skill executor and the subagent `.md`/`.toml`
  converter — agents talk to NoMoreIDE over MCP, so the executor layer is
  unnecessary.
