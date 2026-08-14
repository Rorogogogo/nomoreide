# Provider registry — design

**Status:** steps 1–7 of §8 decided. Both contracts have implementations: `DeployProvider` has Vercel and Cloudflare (§8.5), `HostProvider` has Vultr (§8.6). Step 7 is **decided in §11: `apiVersion: 1` is not frozen and providers stay in-tree** — the three-implementation bar measured contract churn, which is genuinely settled, but a freeze is a promise about a manifest schema, a loader and a sandbox, none of which exist yet. §11 holds the gate for re-opening it; the next unit of work is the generic view (tax #1).
**Goal:** make provider #2 (Cloudflare) and #3 (Vultr) cost ~a third of what provider #1 (Vercel) cost, and leave a seam that can later become a downloadable-plugin contract.

## The problem, measured

The Vercel integration is ~3,850 lines across 17 dedicated files. That is not the problem. The problem is the **central-file tax** — the ~15 sites every new provider must also edit:

`types.ts` · `config-store.ts` (schema + `setVercelConnection` + `updateVercelTokens` + `setVercelScope`) · `app.tsx` (route map, label map, `repoScopedPage`, render branch) · `app-navigation.tsx` (page union, nav entry, logo import) · `lib/api/index.ts` · `tauri-bridge.ts` · `routes/index.ts` · `mcp/tools/index.ts` · `i18n/en.ts` + `zh.ts` · `project-overview.ts` + `overview-routes.ts` + 2 overview column files · `website/src/mock-api.ts` (46 refs)

Two more providers done the current way means ~8k more lines and touching all 15 sites twice more.

## Two contracts, not one

Cloudflare Pages/Workers is near-isomorphic to Vercel: projects, deployments, build logs, env vars, domains. Vultr is IaaS: instances, storage, firewall, DNS — it has almost nothing in common with a deploy platform and overlaps `ssh-servers.ts` far more than it overlaps `vercel-manager.ts`.

A single `Plugin` interface wide enough to hold both would save nothing. So: **`DeployProvider`** and **`HostProvider`**, each narrow.

---

## 1. `DeployProvider` — derived from the real `VercelManager`

Every method below already exists on `VercelManager` with the same arguments. This is a rename, not a redesign.

```ts
// src/core/providers/deploy-provider.ts

export interface DeployProvider {
  /** Signed-in account. ← VercelManager.viewer() */
  account(): Promise<ProviderAccount>;

  /** Teams / orgs / accounts. ← listTeams() */
  listScopes(): Promise<ProviderScope[]>;

  /** ← listProjects({ search, repoUrl, limit }) */
  listProjects(opts?: {
    search?: string;
    repoUrl?: string;
    limit?: number;
  }): Promise<ProviderProject[]>;

  /** ← getProject(idOrName) */
  getProject(id: string): Promise<ProviderProject>;

  /** ← listDeployments({ projectId, target, limit }) */
  listDeployments(opts: {
    projectId: string;
    target?: "production" | "preview";
    limit?: number;
  }): Promise<ProviderDeployment[]>;

  /** ← getDeployment(idOrUrl) */
  getDeployment(id: string): Promise<ProviderDeploymentDetail>;

  /** ← deploymentBuildLogs(idOrUrl, limit) */
  buildLogs(id: string, limit?: number): Promise<ProviderLogLine[]>;

  // --- capability-gated; declared in the manifest, absent when unsupported ---

  /** ← deploymentRuntimeLogs(). Returns [] when the plan lacks it, never throws. */
  runtimeLogs?(id: string, limit?: number): Promise<ProviderLogLine[]>;
  /** ← listEnv(projectId) — values deliberately absent. */
  listEnv?(projectId: string): Promise<ProviderEnvVar[]>;
  /** ← getEnvValue(projectId, envId) — the one door for reading a secret. */
  getEnvValue?(projectId: string, envId: string): Promise<string>;
  /** ← listDomains(projectId) */
  listDomains?(projectId: string): Promise<ProviderDomain[]>;
}
```

### Write half stays separate

The `git-manager`/`git-actions` and `db-peek`/`db-write` split is preserved exactly — `DeployProviderActions` is a distinct optional object, resolved by its own `requireProviderActions()`, and never exposed as an MCP tool.

```ts
export interface DeployProviderActions {
  /** Named actions, not fixed methods — see note below. */
  run(action: string, input: DeployActionInput): Promise<DeployActionResult>;

  createEnv?(projectId: string, input: EnvInput): Promise<ProviderEnvVar>;
  updateEnv?(projectId: string, envId: string, input: Partial<EnvInput>): Promise<ProviderEnvVar>;
  deleteEnv?(projectId: string, envId: string): Promise<void>;
}
```

**Why `run(action, …)` rather than `redeploy()/cancel()/promote()/rollback()`:** promote-vs-rollback is Vercel-specific semantics (Vercel records a rollback with its reason on a different endpoint). Cloudflare has "retry" and "rollback" but no "promote"; Netlify has "publish". Fixing four method names into the contract bakes in one vendor's vocabulary.

This generalizes for free, because `vercel-actions.ts` already has exactly the right shape:

```ts
export const VERCEL_ACTIONS = ["redeploy", "cancel", "promote", "rollback"] as const;
export const PRODUCTION_AFFECTING_ACTIONS: ReadonlySet<VercelActionName> = new Set([
  "promote", "rollback",
]);
```

Move those two lists into the manifest (`actions`, `productionAffecting`) and the UI's confirm-before-shipping logic becomes provider-agnostic with no change in behaviour.

### Neutral types

Straight renames of the existing interfaces, with two deliberate changes:

| Today | Contract | Change |
| --- | --- | --- |
| `VercelViewer` | `ProviderAccount` | none |
| `VercelTeam` | `ProviderScope` | `teamId/teamSlug` → `scopeId/scopeSlug` |
| `VercelProject` | `ProviderProject` | build fields → `settings: ProviderSetting[]` |
| `VercelDeployment` | `ProviderDeployment` | `state` neutral + `rawState` passthrough |
| `VercelDeploymentState` | `ProviderDeploymentState` | see below |
| `VercelEnvVar` | `ProviderEnvVar` | `target[]` → `environments[]` |
| `VercelDomain` | `ProviderDomain` | none |
| `VercelBuildLogLine` + `VercelRuntimeLogLine` | `ProviderLogLine` | merged; `kind: "build" \| "runtime"` |

**`settings` becomes a list, not fields.** `VercelProject` hard-codes `buildCommand`, `devCommand`, `installCommand`, `outputDirectory`, `rootDirectory`, `nodeVersion`, `serverlessFunctionRegion`. Cloudflare's set differs, Vultr has none. So:

```ts
export interface ProviderSetting {
  key: string;
  label: string;
  /** null means "not overridden" — a meaningful state, kept distinct from absent.
   *  (This nuance is already documented on VercelProject and must survive.) */
  value: string | null;
}
```

**State enum keeps an escape hatch.** The eight Vercel states mostly map to Cloudflare's (`queued`, `building`, `deploying`, `success`, `failure`, `canceled`, `skipped`), but not cleanly. So carry both:

```ts
export type ProviderDeploymentState =
  | "queued" | "building" | "ready" | "error" | "canceled" | "blocked" | "deleted";

export interface ProviderDeployment {
  state: ProviderDeploymentState;   // drives icon + filter
  rawState: string;                 // the vendor's own word, shown in the UI detail
  // …
}
```

Without `rawState` the first provider whose states don't map forces a contract change. This is the single most likely place the abstraction leaks, so it gets a pressure valve on day one.

---

## 2. Auth — the biggest single win

`vercel-auth.ts`'s three-source model (`cli` | `stored` | `oauth`) generalizes almost perfectly. Cloudflare has `wrangler login` + API token + OAuth; Vultr has an API key only (`stored`).

```ts
export interface ProviderCredential {
  source: "cli" | "stored" | "oauth";
  token: string;
  scopeId?: string;
  scopeSlug?: string;
}
```

What stays provider-specific is small:

- **CLI session discovery** — `vercelCliDataDirs()` and `readVercelCliSession()` (~60 lines) become a `cliSession()` hook. The *policy* around it — "CLI tokens are never copied into config, they are re-read at use time so `vercel logout` revokes us too" — is generic and moves to the shared resolver. That policy is one of the better decisions in the current code and should be the contract's default, not per-provider.
- **OAuth endpoints** — `vercel-oauth.ts` is 296 lines of PKCE + loopback redirect + token refresh with rotation. Perhaps 85% of that is vendor-neutral. The provider supplies `authorizeUrl`, `tokenUrl`, `clientId`, `scopes`; the shared module does the rest, including the `VERCEL_TOKEN_REFRESH_SKEW_MS` freshness check and the rotated-refresh-token persistence.

### Config shape — do this migration first, alone

```ts
// today
interface NoMoreIdeConfig { vercel?: VercelConnection }
interface GitRepository  { vercelProjectId?: string }

// contract
interface NoMoreIdeConfig { connections: Record<string, ProviderConnection> }
interface GitRepository  { providerProjects?: Record<string, string> }
```

This replaces `setVercelConnection` / `updateVercelTokens` / `setVercelScope` with `setConnection(id, …)` / `updateTokens(id, …)` / `setScope(id, …)`.

Migrate with a Zod `.transform()` on load — if `config.vercel` exists, move it to `connections.vercel` and drop the old key on next write. This is the one change with real blast radius (it touches the user's on-disk config), so it should land as its own PR with its own tests, before anything else.

---

## 3. Project resolution generalizes with two hooks

`vercel-context.ts`'s `resolveProject()` is a three-tier confidence ladder — explicit pin → local link file → git-remote lookup — and the *algorithm* is entirely generic. Only two inputs are vendor-specific:

```ts
interface DeployProviderHooks {
  /** Normalizes a git remote into the URL the vendor keys projects by.
   *  ← vercelRepoUrl(remoteUrl) */
  repoUrl(remoteUrl: string): string | null;

  /** Local file written by the vendor's CLI link command. Vercel:
   *  { path: ".vercel/project.json", field: "projectId" }.
   *  Cloudflare and Vultr have no equivalent — the tier is simply skipped. */
  linkFile?: { path: string; field: string };
}
```

Also generic and worth keeping verbatim: `adoptDefaultTeam()`'s rule that a sole scope is adopted and persisted, but several scopes means *ask* rather than guess — and that a `cli` connection never persists a scope, because that would override `vercel switch` from then on. Both are correct for any provider with a CLI.

---

## 4. Routes, MCP, and the client seam collapse

**Routes.** `vercel-routes.ts` is 553 lines / 20 routes, of which essentially none is Vercel-specific — the OAuth callback HTML page, `escapeHtml`, `loginResultPage`, `VercelLoginSessions`, and the `loginPhase` polling state are all generic. It becomes one `provider-routes.ts` serving `/api/providers/:id/*`. `routes/index.ts` changes from `export const routes: Route[]` to `buildRoutes(providers)`; `server.ts` is the only consumer and already builds its `RouteServices` context once, so this is a small change.

**MCP.** `mcp/tools/vercel.ts` is only 4 tools. They become 4 tools with a `provider` parameter — *not* 4 tools per provider. This matters: the tool list is already 70+, and per-provider tools would be the fastest way to make it unusable.

**Client seam.** The four files (`vercel-api.ts` interface 200, `vercel-http.ts` 164, `vercel-tauri.ts` 138, `vercel.ts` 54 = 556 lines) collapse to one `provider-api.ts` set taking a `providerId` first argument. The `isTauri()`-once-at-module-load pattern in `vercel.ts` is good and carries over unchanged.

**i18n — this one is load-bearing.** The generic view uses generic keys (`provider.tabs.env`), but each provider needs its own strings, and `en.ts` defines `TranslationKey` while `zh.ts` is a `Partial`. If every provider still edits both files, one of the 15 taxes survives and the plugin story is dead on arrival. So the manifest carries its own strings, merged into the i18n map at load:

```jsonc
"strings": { "en": { "setup.hint": "Run `wrangler login`" }, "zh": { … } }
```

**Website mock.** One `/api/providers/:id/*` handler set in `mock-api.ts` replaces the 46 Vercel references, and no future provider needs to touch it.

---

## 5. What survives the refactor

| File | Lines | Becomes shared | Stays Vercel-specific |
| --- | ---: | ---: | ---: |
| `vercel-manager.ts` | 687 | ~130 (types) | ~557 (REST paths, normalizers, transport) |
| `vercel-auth.ts` | 197 | ~137 | ~60 (CLI file locations) |
| `vercel-oauth.ts` | 296 | ~250 | ~46 (endpoints, client id) |
| `vercel-context.ts` | 174 | ~150 | ~24 (`repoUrl`, link file) |
| `vercel-actions.ts` | 152 | ~10 (action lists → manifest) | ~142 |
| `vercel-routes.ts` | 553 | ~553 | 0 |
| `mcp/tools/vercel.ts` | 122 | ~122 | 0 |
| client API seam (4) | 556 | ~200 | ~30 |
| client feature (7) | 942 | ~700 | ~240 (logo, icons, setup copy) |
| **Total** | **3,679** | **~2,250** | **~1,100** |

**Roughly 60% becomes shared infrastructure.** Provider #2 costs ~1,100 lines and **zero** central-file edits, against ~3,850 lines and ~15 edits today.

The Vercel implementation *shrinks* in the process, because 553 lines of routes and 122 of MCP tools stop being its problem.

---

## 6. Manifest schema

```jsonc
{
  "id": "cloudflare",
  "apiVersion": "1",
  "name": "Cloudflare",
  "kind": "deploy",                    // "deploy" | "host"
  "icon": "data:image/svg+xml;base64,…",
  "server": "./server.js",             // default-exports createProvider(ctx)

  "auth": {
    "sources": ["cli", "stored", "oauth"],
    "cli":    { "hint": "Run `wrangler login`" },
    "stored": { "label": "API token", "helpUrl": "https://dash.cloudflare.com/profile/api-tokens" },
    "oauth":  { "authorizeUrl": "…", "tokenUrl": "…", "clientId": "…", "scopes": ["…"], "pkce": true }
  },

  "scope": { "label": "Account", "required": true },   // Vercel: "Team"

  "capabilities": ["projects", "deployments", "buildLogs", "runtimeLogs", "env", "domains"],
  "actions": ["redeploy", "cancel", "rollback"],
  "productionAffecting": ["rollback"],

  "link": { "file": ".vercel/project.json", "field": "projectId" },   // optional

  "strings": { "en": { … }, "zh": { … } },

  "api": { "hosts": ["api.cloudflare.com"] }           // egress allowlist
}
```

`capabilities` is what lets one generic React view render every provider: absent `runtimeLogs` hides the tab rather than showing one that errors.

### `api.hosts` is the security boundary

A provider necessarily receives credentials, and it runs inside the daemon — the same process holding GitHub tokens, `db-write.ts` access, and process-spawn ability. So `createProvider(ctx)` must receive a **host-supplied `ctx.fetch`** scoped to `api.hosts` and its own `connections[id]` entry, never raw `node:fs` / global `fetch`.

*The `fetch` half landed as `providers/egress.ts` — gate item 3 of §11, where the details are. The `node:fs` and credential halves are still convention.*

---

## 7. `HostProvider` — the Vultr half

*Landed (§8.6). The sketch below is what was planned; three of its four lines changed on contact, which is recorded after it.*

```ts
export interface HostProvider {
  listInstances(): Promise<HostInstance[]>;
  getInstance(id: string): Promise<HostInstance>;
  metrics?(id: string): Promise<RemoteHostMetrics>;   // reuse ssh-servers.ts type
  run?(action: string, instanceId: string): Promise<void>;

  /** The payoff: adopt a provider instance as an SSH target. */
  toSshTarget(instance: HostInstance): SshServerDefinition;
}
```

`toSshTarget` is the reason this contract earns its keep. A Vultr instance shows up in the existing SSH server list, with existing metrics and existing remote service running, without the user registering it by hand. That is a feature the current architecture cannot express and a generic plugin interface would never have produced — it only falls out of writing the third implementation against a contract shaped by the first two.

**What the sketch got wrong**, all three found by writing the implementation:

- **`run?()` does not belong on the read interface.** Halting a production box is not something an agent holding read tools should be one call away from, and every other write in this codebase is a separate object (`git-actions`, `db-write`, `vercel-actions`). It became `HostProviderActions`, resolved separately, and never an MCP tool.
- **`metrics?()` is redundant, so it was dropped.** `toSshTarget` already hands the instance to `readRemoteHostMetrics`, which is a better answer anyway: it measures the machine over SSH rather than trusting a vendor's aggregate. Keeping a contract method nothing implements is precisely the over-abstraction §9 warns about.
- **`toSshTarget` returns `SshServerDefinition | null`, and needs the machine's login.** An instance that is still provisioning has no address; inventing a placeholder would put a permanently-failing row on the servers page. And an address alone is not reachable — `ssh 45.32.10.1` tries the *local* username — so `HostInstance` carries `defaultUser` (`root`, Vultr's `linuxuser`, elsewhere `ubuntu`).

---

## 8. Sequencing

1. ~~**Config migration**~~ — done (`bf52d44`). `config.vercel` → `connections.vercel`, `vercelProjectId` → `providerProjects`, `teamId` → `scopeId`. Mirrored in the Tauri Rust core, which shares the file.
2. ~~**Shared credential + OAuth**~~ — done (`3c837aa`). `providers/oauth.ts` + `providers/credentials.ts`; Vercel is reduced to CLI file locations, four OAuth constants, and six message strings. Discovery is cached per issuer, not per module.
3. ~~**Contract + Vercel as implementation #1**~~ — done. `providers/deploy-provider.ts` (contract), `providers/project-resolution.ts` (the three-tier ladder + sole-scope adoption, consumed by `vercel-context.ts` today), `vercel-provider.ts` (the adapter). HTTP surface unchanged.
4. ~~**Generic routes + MCP + client seam**~~ — done. `/api/vercel/*` → `/api/providers/:id/*` (`provider-routes.ts`, provider-agnostic), 4 MCP tools with a `provider` parameter, the client's 4-file seam collapsed to `provider-*.ts`, and `mock-api.ts` down to one handler set. The wire now carries the neutral shapes.

   **Two taxes deliberately survive**, because paying them now would be guessing:
   - `features/vercel/` is still a Vercel-named view. It reaches the seam through `provider-client.ts`, which binds the id once, so making it generic is a prop change — but *what* a generic view should look like is a question Cloudflare answers, not one to invent here (§9, over-abstraction).
   - Provider strings still live in `en.ts`/`zh.ts` rather than a manifest `strings` block, for the same reason. `DeploymentStateBadge` does now consume `rawState` for labels, which is the mechanism a manifest would feed.
5. ~~**Cloudflare**~~ — done. `cloudflare-{manager,actions,auth,provider,context}.ts` plus one entry in `providers/registry.ts`. No route, no MCP tool, no client seam and no `mock-api.ts` change — which is the claim §4 made, now tested at the HTTP surface in `test/provider-routes.test.ts` ("a second provider, served by the same routes").

   **What the contract had to absorb, and did, without a signature change:**
   - *Deployment reads are project-scoped.* Cloudflare has no global deployment endpoint, so `createCloudflareDeployProvider(manager, projectName)` closes over the project the caller already resolved instead of `getDeployment(id)` growing a second argument. `ProviderContext` bundles a provider with its project anyway.
   - *`ProviderProject.id` is whatever the vendor addresses projects by.* Cloudflare's paths use the project **name**; its UUID addresses nothing. A pinned project therefore stores a name.
   - *`rawState` paid for itself on day one.* Cloudflare's state is a `(stage, status)` pair, not an enum — there was no eight-value list to map from. The pair rides through as `deploy:success`, and `skipped` (an outcome the neutral enum has no room for) folds into `canceled` while keeping its own word.
   - *No `runtimeLogs`, no `oauth`, no `linkFile`.* Three optional things declined by provider #2, which is the first evidence the optionality was real: Pages tails runtime output over a websocket, Cloudflare's authorization server serves neither OIDC discovery nor dynamic client registration (so `providers/oauth.ts` cannot mint a client for it), and Wrangler writes no link file.
   - *`url` is a bare hostname.* Undocumented but load-bearing — the client renders `https://${url}`. Cloudflare returns a full URL, so the adapter strips the scheme. Now stated on the contract.

   **The one shared-layer change:** `adoptSoleScope` grew `cliSelectsScope`. The old rule — a `cli` credential adopts nothing, because `vercel switch` already chose — is wrong for a CLI that has no scope switch: every Pages path contains an account id, so a `wrangler login` would have been unable to read a single project. It now adopts the sole scope in memory but still never persists it, since a saved scope would outrank `CLOUDFLARE_ACCOUNT_ID`. Vercel's behaviour is unchanged (the flag defaults to the old rule).

   **What Cloudflare says the manifest still lacks**, deferred with the two taxes below rather than guessed at now:
   - `authSources`. Vercel has all three; Cloudflare has two. A generic setup screen cannot know whether to offer "Sign in with browser" without being told. Derivable from `ProviderAuthSpec`, so this is a wiring decision, not new data.
   - `scope.required` (§6 has it, `DeployProviderManifest` does not). Vercel works unscoped; Cloudflare cannot. Today an unscoped Cloudflare connection reports `no_project` with `scopes` populated — workable, but the UI has to infer the real problem.
6. ~~**Vultr + `HostProvider`**~~ — done. `providers/host-provider.ts` (the second contract), `providers/host-bridge.ts` (the SSH adoption), `vultr-{manager,actions,auth,provider,context}.ts`, `web/routes/host-routes.ts`, and the host half of the registry.

   **A second *contract* costs central edits; a second *provider within* a contract does not.** That distinction is the real result of this step. Cloudflare cost one line in `registry.ts`. Vultr cost that line plus `routes/index.ts`, the `mergeSshServers` signature, one client type, one line of UI and two i18n keys — because it introduced a kind, not because it introduced a provider. DigitalOcean will cost one line and its own directory.

   **What generalized, and what correctly did not:**
   - *`providers/credentials.ts` carried over untouched.* Vultr is neither a deploy platform nor an OAuth one, and it reuses the three-source resolver exactly — the first evidence that layer generalized beyond the contract it was extracted from. It also stretches the model to its narrowest: a `cli` source backed by `VULTR_API_KEY` with **no CLI file at all**. What makes a source `cli` turns out to be the *policy* (re-read at use time, never persisted), not where the token lives — which is what `credentials.ts` already said, now tested.
   - *`providers/project-resolution.ts` is not part of this contract, and should not be.* An instance belongs to an account, not to a repository. There is no working directory in `HostContext`, no `repoUrl` hook, no link file, no scope — Vultr's API key addresses exactly one account. `vultr-context.ts` is the shortest registry entry so far, and the missing parts are the argument for two contracts rather than one wide one.
   - *`rawState` paid for itself a second time.* Vultr describes a machine with three fields (`status`, `power_status`, `server_status`) and only their combination says whether it is reachable. `suspended` — a vendor lock the user must act on — has no neutral equivalent, so it maps to `error` and survives verbatim, exactly as Cloudflare's `skipped` did.

   **The bridge is the payoff, and it is where the design earns its keep.** A Vultr instance is a row in the SSH server list the user already has, merged on the host string so a machine they had already saved metadata for is one row and *their* name wins. `probeSshServer`, `readRemoteHostMetrics`, the terminal route and the remote service runner all work against it unchanged, because what the provider hands over is a plain `SshServerDefinition`. Two rules the bridge enforces: it **never throws** (a vendor outage must not blank a page listing the user's own hosts), and it caches for 30s (that page reloads on an interval *and* on every window focus).

   **Deliberately not done:** `environment` is not inferred from Vultr tags — they are free-form, and guessing "Production" from one would eventually put that label on the wrong machine. Destructive operations (`delete`, `reinstall`) are absent from the manifest entirely, the line `GitManager` draws around `reset --hard`.
7. ~~**Consider freezing `apiVersion: 1`**~~ — decided, **no**. The contracts are stable enough; the manifest, the loader and the sandbox that a version number would actually be promising are not written. Providers stay in-tree. Full reasoning and the gate for re-opening it are in §11.

## 9. Risks

- **Contract churn.** Mitigated entirely by sequencing — three in-tree implementations before any external commitment. Publishing `apiVersion 1` at v0.1.x and then being unable to change it is the failure mode that turns a marketplace into a millstone.
- **Lossy state mapping.** `rawState` passthrough.
- **Over-abstraction.** If Cloudflare needs a view Vercel's generic one can't render, give it a custom component and keep the shared route/auth/seam layers. Escaping the generic UI must stay cheap, or the contract starts distorting features.
- **i18n regression.** `zh.ts` is a `Partial`, so a missing key renders English rather than failing the build — a provider's `strings.zh` being incomplete will be silent. Worth a test that asserts manifest string sets match across locales.
- **Neither new provider has met its live API.** Cloudflare and Vultr are both tested against stubbed `fetch` only. Their request and response shapes come from authoritative sources — Cloudflare's OpenAPI spec via the `cloudflare-api` MCP server, Vultr's from the official `github.com/vultr/govultr` SDK — so the risk is not in the field names but in the behaviours a spec does not state: Cloudflare's PATCH-merge env semantics, and whether a Vultr power action's 204 arrives before the instance's reported state changes. One manual pass each with a real token, before anyone relies on env writes or on the servers list refreshing after a reboot.

## 10. Deliberately out of scope

Runtime loading of third-party React. The dashboard is a Vite-built SPA served from `dist/`; shipping external React into it needs either an install-time rebuild (Backstage's approach) or a module loader with externalized React and a versioned UI SDK (Grafana's). Declarative, manifest-driven providers cover Cloudflare, Vultr, Fly, Railway, Render, DO and Netlify without either. Revisit only when a concrete provider cannot be expressed declaratively.

Distribution infrastructure is already built — `agent-profiles/registry-client.ts` implements `createProfile` / `createVersion` / `package` / `publish` / `install` against `https://api.nomoreide.com`. Providers would be a second artifact type in that store, not a second store.

---

## 11. Step 7 — the freeze decision

**Decided: `apiVersion: 1` is not frozen, and downloadable providers stay closed. Providers remain in-tree.** Re-open on the gate below rather than on a count of implementations.

§9 set the bar at "three in-tree implementations before any external commitment", and three now exist. That bar measured the right *risk* — contract churn — but it is not the whole precondition. Freezing an `apiVersion` is not a promise that `DeployProvider` is stable; it is a promise about **a manifest schema, a loader, and a sandbox**, and those are the parts that do not yet exist.

### What the three implementations did buy

The contracts are, on the evidence, right — worth stating plainly, because this is the part that worked:

- `DeployProvider`'s signatures survived Cloudflare **unchanged** (§8.5). Every collision was absorbed by something designed as a pressure valve: `rawState` twice (§8.5, §8.6), `settings` as a list, `ProviderProject.id` as "whatever the vendor addresses projects by".
- The one shared-layer change Cloudflare forced — `adoptSoleScope`'s `cliSelectsScope` — was a policy refinement, not a signature change.
- `providers/credentials.ts` carried over to a provider on the *other* contract untouched, which is the strongest single piece of evidence that the layer generalized rather than being renamed.
- The two contracts stayed disjoint under pressure exactly as §2 predicted: `HostProvider` needed no project resolution, `DeployProvider` needed no `toSshTarget`.

So the interfaces would survive being frozen. That is not what freezing costs.

### The four things that are not ready

1. **There is no manifest to freeze.** `apiVersion` appears nowhere in `src/` — only in this document. A registry entry today is **code, not data**: `RegisteredDeployProvider` carries four function-valued fields (`context()`, `actions()`, `hooks.repoUrl`, `auth.cliSession`), where §6 assumed a JSON manifest with a `server: "./server.js"` pointer beside it. A version number is a promise about a schema, and that schema has not been written. Designing it *is* the work a freeze implies, not its precondition.

2. **Half the manifest is write-only.** All three providers declare `capabilities`, `productionAffecting` and `scopeLabel`; **nothing reads any of them.** The only manifest field with a consumer is `actions`, validated at the two action routes. `capabilities` was §6's central claim — "what lets one generic React view render every provider" — but the view is still `features/vercel/`, Vercel-bound (tax #1), so a provider declaring `capabilities: ["env"]` buys exactly nothing. Freezing v1 tells an external author their declarations are honoured, while three of six fields are inert. That is the shortest path to needing a v2.

3. **The security boundary exists only in prose.** §6 calls `api.hosts` "the security boundary" and requires a host-supplied `ctx.fetch`. Neither appears in `src/`; all three managers call global `fetch` directly. In-tree that is fine — the code is reviewed and the egress is auditable. For downloadable code it is the *entire* barrier between a third party and a daemon holding GitHub tokens, `db-write.ts` access and process-spawn ability. This gate is independent of contract stability, and it is the one that actually blocks third-party loading. *(Since resolved for `fetch` — see the gate below. `node:fs` is not.)*

4. **§9's live-API risk is still open.** Cloudflare and Vultr have met stubbed `fetch` only. The behaviours a spec does not state — Cloudflare's PATCH-merge env semantics, whether a Vultr power action's 204 precedes the reported state change — are exactly the kind that force an adapter shape change, and a freeze would put that change on the far side of a compatibility promise.

### The gate

Re-open the question when all four hold, in this order, because each is cheap only after the one before it:

1. ~~**The generic view lands**~~ (tax #1), giving `capabilities` and `scopeLabel` a real consumer. **Landed.** `features/vercel/` became `features/deploy/`, one nav entry with an in-view provider switcher, and the manifest gained `authSources` — the gap §8.5 predicted, since Cloudflare serves no OIDC discovery and a sign-in button there could only fail.
2. **Manifest strings move out of `en.ts`/`zh.ts`** (tax #2), with the locale-parity test §9 asks for — the change that makes the declarative half genuinely declarative.
3. ~~**`ctx.fetch` replaces global `fetch`**~~ in all three managers, enforced by `api.hosts`. **Landed**, as `providers/egress.ts`. Notes below.
4. **One live-token pass each** against Cloudflare and Vultr, retiring §9's last open risk.

Items 1 and 3 landed out of order on purpose: 3 does not depend on 2, and it is the only gate item that is a *security* boundary rather than a tidiness one.

#### What landing item 3 settled

- **The allowlist is checked against the final URL, not the base URL.** All three `xRequest` helpers accept an absolute path (`path.startsWith("http")`) and skip their base URL entirely. That escape exists for pagination cursors, and it is precisely what downloaded provider code would use. Checking the composed URL is what makes it not an escape.
- **Redirects are followed by hand, one allowlist check per hop.** The default `redirect: "follow"` would let an open redirect on an allowlisted vendor host carry an `Authorization` header anywhere. This is the one place the boundary costs something at runtime; a live pass against Vercel confirms `redirect: "manual"` changes nothing for a JSON API that does not redirect.
- **No wildcard hosts, and that is a decision, not an omission.** Every vendor here has a customer-controlled subdomain space (`*.vercel.app`, `*.pages.dev`), so a `*.vendor.com` form reads as a convenience while admitting hosts the vendor does not control.
- **The scoped `fetch` is minted only in the three `*-context.ts` files.** A manager built anywhere else gets global `fetch` — which keeps every existing `vi.stubGlobal("fetch")` test working, and means "did this client come from the registry?" and "is it sandboxed?" are the same question.
- **What is still outside the boundary**, and would need to move before anything third-party loads: `node:fs` (a provider's hooks read a link file), and the OAuth leg, which resolves its endpoints from the auth spec rather than through `api.hosts`.

Provider #4 (DigitalOcean — one line plus a directory) is deliberately *not* on that list. It would add a fourth implementation while touching none of the four gates, which is the precise sense in which "three implementations" was the wrong bar to freeze on.
