import { en_shell } from "./shell";
import { en_home } from "./home";
import { en_services } from "./services";
import { en_activity } from "./activity";
import { en_servers } from "./servers";
import { en_docker } from "./docker";
import { en_errors } from "./errors";
import { en_git } from "./git";
import { en_linear } from "./linear";
import { en_github } from "./github";
import { en_database } from "./database";
import { en_provider } from "./provider";
import { en_agent } from "./agent";
import { en_agent_env } from "./agent-env";
import { en_context } from "./context";
import { en_terminal } from "./terminal";
import { en_remote } from "./remote";
import { en_extensions } from "./extensions";
import { en_global_search } from "./global-search";
import { en_workspace } from "./workspace";
import { en_onboard } from "./onboard";
import { en_settings } from "./settings";

/**
 * English catalog — the source of truth for every translation key. Other
 * locales override a subset; anything they omit falls back to the string here,
 * so partial translations degrade to English rather than showing raw keys.
 *
 * Split one module per feature, mirroring `apps/dashboard/src/features/`. The
 * catalogs were one 2,900-line object each, which is where an untranslated key
 * could hide — `test/i18n-key-parity.test.ts` now fails on one, and a per-
 * feature file makes the gap visible while editing rather than only in CI.
 */
export const en = {
  ...en_shell,
  ...en_home,
  ...en_services,
  ...en_activity,
  ...en_servers,
  ...en_docker,
  ...en_errors,
  ...en_git,
  ...en_github,
  ...en_linear,
  ...en_database,
  ...en_provider,
  ...en_agent,
  ...en_agent_env,
  ...en_context,
  ...en_terminal,
  ...en_remote,
  ...en_extensions,
  ...en_global_search,
  ...en_workspace,
  ...en_onboard,
  ...en_settings,
} as const;

export type TranslationKey = keyof typeof en;
