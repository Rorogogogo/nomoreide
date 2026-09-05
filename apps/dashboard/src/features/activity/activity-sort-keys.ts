/**
 * Columns the service activity table can sort by.
 *
 * Its own module because the table component and the page that owns the
 * current sort state both need the type, and neither should import the other.
 */
export type SortKey = "cpu" | "energy" | "memory" | "name";
