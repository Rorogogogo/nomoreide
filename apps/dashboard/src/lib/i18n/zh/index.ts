import type { TranslationKey } from "../en";
import { zh_shell } from "./shell";
import { zh_home } from "./home";
import { zh_services } from "./services";
import { zh_activity } from "./activity";
import { zh_servers } from "./servers";
import { zh_docker } from "./docker";
import { zh_errors } from "./errors";
import { zh_git } from "./git";
import { zh_github } from "./github";
import { zh_database } from "./database";
import { zh_provider } from "./provider";
import { zh_agent } from "./agent";
import { zh_agent_env } from "./agent-env";
import { zh_context } from "./context";
import { zh_terminal } from "./terminal";
import { zh_remote } from "./remote";
import { zh_extensions } from "./extensions";
import { zh_global_search } from "./global-search";
import { zh_workspace } from "./workspace";
import { zh_onboard } from "./onboard";
import { zh_settings } from "./settings";

/**
 * Simplified Chinese overrides, one module per feature to match `./en`.
 *
 * Typed `Partial`, so a missing key falls back to English rather than showing
 * a raw key — which is silent, and why `test/i18n-key-parity.test.ts` exists.
 */
export const zh: Partial<Record<TranslationKey, string>> = {
  ...zh_shell,
  ...zh_home,
  ...zh_services,
  ...zh_activity,
  ...zh_servers,
  ...zh_docker,
  ...zh_errors,
  ...zh_git,
  ...zh_github,
  ...zh_database,
  ...zh_provider,
  ...zh_agent,
  ...zh_agent_env,
  ...zh_context,
  ...zh_terminal,
  ...zh_remote,
  ...zh_extensions,
  ...zh_global_search,
  ...zh_workspace,
  ...zh_onboard,
  ...zh_settings,
};
