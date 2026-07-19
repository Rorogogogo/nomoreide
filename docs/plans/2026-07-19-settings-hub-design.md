# Settings Hub Design

## Goal

Turn the small appearance-and-language settings page into a complete settings hub for NoMoreIDE. The hub must expose useful global and project-specific configuration without presenting controls that do not have real behavior.

## Product principles

- Make scope explicit. Users should always know whether they are changing global behavior or the current project.
- Prefer a smaller set of working controls over placeholder toggles.
- Save simple, safe changes immediately and require explicit saves for values that need validation.
- Explain unavailable settings instead of silently hiding them.
- Keep destructive and privacy-sensitive actions deliberate and reversible where possible.
- Preserve existing theme and language preferences during migration.

## Information architecture

The page uses a two-column layout: searchable category navigation on the left and the selected category on the right. Narrow layouts replace the sidebar with a category selector.

The header and each category display a scope indicator:

- **Global** for preferences that follow the local NoMoreIDE installation.
- **Current project** for values stored with the selected project.

Project categories display the active project name. When no project is active, project controls remain visible but disabled with an explanation.

The categories are:

1. General
2. Appearance
3. Terminal
4. Services & Logs
5. Git & GitHub
6. Agents & MCP
7. Database & Safety
8. Notifications
9. Data & Privacy
10. About

Search matches category names, setting labels, and descriptions. Results are shown in a unified view while preserving the scope of every setting.

## Settings catalogue

### General — Global

- Startup page
- Reopen the last project
- Language
- Sidebar behavior
- Default project scope

### Appearance — Global

- Light, dark, or system theme
- Interface density
- Code font size
- Reduced motion

### Terminal — Global

- Default shell
- Font size
- Cursor style
- Scrollback limit
- Copy on select
- Confirm before terminating a running process

### Services & Logs — Current project

- Default auto-start behavior
- Restart policy
- Health-check timing
- Log timestamps
- Line wrapping
- Retained log limit

### Git & GitHub — Mixed scope

- Auto-fetch interval
- Default branch
- Commit co-author preference
- Confirmation before push or branch deletion
- GitHub connection status and management entry point

### Agents & MCP — Mixed scope

- Preferred agent
- Default model where the selected agent supports it
- Agent terminal behavior
- Claude co-author preference
- MCP server defaults
- Links into the detailed Agent Environments editor

### Database & Safety — Current project

- Read-only mode by default
- Confirmation for write operations
- Query timeout
- Result row limit
- Transaction preference

### Notifications — Global

- Service crash notifications
- Failed workflow notifications
- Completed agent task notifications
- Sound
- Desktop notification permission and status

### Data & Privacy — Global

- Diagnostic-data preference
- Log and history retention
- Configuration file locations
- Clear local UI data
- Export and import settings

### About

- Application version
- Runtime details
- Documentation
- Release notes
- Issue reporting
- Update check

Only settings backed by working behavior are rendered as interactive controls. Capabilities that require later platform work, such as native desktop notifications, update installation, and advanced retention jobs, are added only when their implementations exist.

## Storage and data flow

Settings are divided into three persistence layers:

1. **UI preferences** use local app storage for synchronous startup and instant application. This includes theme, density, sidebar behavior, and display sizing.
2. **Global operational settings** use a versioned settings file managed by the backend. This includes terminal, notifications, global safety defaults, and retention behavior.
3. **Project settings** extend the project `nomoreide.config.json`. This includes service, Git, log, and database behavior.

A shared typed schema owns defaults, validation rules, descriptions, scopes, and schema versioning. The web and desktop clients read and write operational settings through the existing API abstraction.

Safe toggles and selects save immediately. Paths, branch names, timeouts, limits, and grouped edits require an explicit save. The interface displays saving, saved, and failed states. Failed optimistic saves restore the last confirmed value and show an actionable inline error.

Project changes state whether they will modify the tracked project configuration file.

## Component design

The settings hub is assembled from reusable primitives:

- Settings layout and category navigation
- Category selector for narrow viewports
- Search and unified results
- Scope badge
- Section and setting row
- Toggle, select, and validated input controls
- Save-status indicator
- Unsupported-setting explanation
- Reset and destructive-action confirmation dialogs

Category definitions remain separate from rendering so the catalogue can grow without turning the page into one large component. Settings that need custom management experiences link to their existing feature page rather than duplicating complex editors.

## Interaction and safety

- Unavailable capabilities are disabled with a visible reason.
- Risky controls use stronger visual treatment and confirmation dialogs.
- Reset category and reset all show a preview of affected values.
- Data clearing separates UI preferences, logs/history, and project configuration.
- Import validates schema versions and previews the difference before applying.
- Stable skeleton rows prevent layout jumps during loading.
- Inline errors retain context and provide retry actions.
- Sidebar and controls support keyboard navigation and visible focus states.
- Existing appearance and language storage keys migrate without losing values.

## Error handling

Validation errors are attached to the relevant field and block persistence. Backend failures preserve or restore the previous confirmed state. A category-level error banner is used only when the entire settings payload cannot load or save. Project-scope controls distinguish between no active project, an unreadable config, invalid config content, and a write failure.

Import failures never partially apply settings. Reset operations compute and show their change set before confirmation.

## Delivery boundaries

The first delivery includes:

- The full responsive hub shell, category navigation, search, scopes, and save states
- Every setting already supported by the product
- Shared versioned global-settings infrastructure
- A practical first group of new settings with real behavior
- Migration of the current settings page without preference loss

Platform features without an implementation are outside the first delivery and must not appear as fake controls.

## Verification

Automated coverage should verify:

- Defaults and schema validation
- Global and project persistence
- Strict separation of scopes
- Migration of existing theme and language choices
- Optimistic save success and rollback
- Explicit-save validation
- Search matching and result grouping
- Disabled project controls with no active project
- Category and full reset behavior
- Import version validation and atomic application
- Keyboard navigation and accessible control labels

Responsive and visual checks should cover desktop and narrow layouts, light and dark themes, empty-project state, loading, validation errors, and save failures.
