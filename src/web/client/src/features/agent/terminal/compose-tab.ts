/**
 * Sentinel selection value for the dock's compose ("New task") tab.
 *
 * Selection in the dock is a single value — a task id, or this — so the tab
 * strip can never disagree with what the viewport is rendering. It is opaque to
 * `useAgentTerminalTasks`: it matches no session id, so task lookups miss and
 * the hook's "don't steal focus" checks read it as an active selection.
 */
export const COMPOSE_TAB_ID = "new";
