# Agent Terminal Full-Screen Design

## Goal

Give the agent terminal dock a focused full-screen mode while preserving the normal app's vertical sidebar navigation.

## Layout

Normal mode remains unchanged: the app uses its vertical left sidebar and the agent terminal is either a 36px bottom rail or a resizable 50vh dock.

Full-screen mode fills the application area below the native Tauri title bar. The vertical sidebar and normal page content are hidden. A compact horizontal navigation bar appears at the top of the full-screen terminal and exposes the same destinations as the vertical sidebar: Services, Git Review, GitHub, Error Inbox, Database, Terminal, Agent, and Agent Env. The terminal fills all remaining space.

## Interaction

The dock toolbar gains an Expand/Restore control. Expanding preserves the active PTY, tabs, scrollback, listeners, and task state. Escape restores the regular expanded dock. Using Collapse while full-screen returns directly to the 36px rail.

Selecting an item in the horizontal navigation changes the underlying application page, exits full-screen mode, and collapses the dock. The terminal sessions remain alive and can be reopened from the rail.

## Architecture

The application shell continues to own the current page. It passes the page and a navigation callback into the terminal dock. The dock owns only its presentation state (`normal` or `full-screen`) and calls the app callback when horizontal navigation is used. This avoids duplicating routing state or creating a separate terminal route.

## Testing

Component tests cover full-screen expansion/restoration, the horizontal navigation destinations and active state, navigation collapsing the dock, Escape restoration, and preservation of terminal viewports across mode changes.
