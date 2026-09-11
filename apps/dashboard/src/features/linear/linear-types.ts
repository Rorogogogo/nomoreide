export interface LinearChoice { id: string; name: string }
/** A workflow state. `type` is Linear's fixed enum — see `linear-states.ts`. */
export interface LinearState extends LinearChoice { type: string }
export interface LinearTeam extends LinearChoice { states: { nodes: LinearState[] }; projects: { nodes: LinearChoice[] } }
export interface LinearIssue {
  id: string;
  identifier: string; title: string; description: string | null; url: string; branchName: string;
  priority: number; state: LinearState; team: LinearChoice; assignee: LinearChoice | null;
  project?: LinearChoice | null;
  /** ISO 8601. How long a card has sat still is the board's missing signal. */
  updatedAt?: string | null;
  /** Linear's manual board position. Ascending: the smallest sits at the top. */
  sortOrder?: number | null;
  comments?: { nodes: { id: string; body: string; user: { name: string } | null }[]; pageInfo: { hasNextPage: boolean } };
}
export type LinearRequest =
  | { operation: "metadata" }
  | { operation: "binding"; team: string; project: string | null }
  | { operation: "unbind" }
  | { operation: "issues"; team: string; project: string | null; after?: string | null }
  | { operation: "issue"; id: string }
  | { operation: "createProject"; team: string; name: string; description: string }
  | { operation: "create"; team: string; project: string | null; title: string; description: string }
  | { operation: "update"; id: string; state: string }
  | { operation: "place"; id: string; state: string; sortOrder: number }
  | { operation: "comment"; id: string; body: string };
export interface LinearData {
  teams?: { nodes: LinearTeam[] };
  binding?: { team: string; project: string | null } | null;
  /** The repository the binding is filed under — what the UI names it by. */
  repository?: string | null;
  issues?: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  issue?: LinearIssue;
  issueCreate?: { issue: LinearIssue };
  projectCreate?: { project: LinearChoice };
}
export type LinearTransport = (request: LinearRequest) => Promise<LinearData>;
export function linearTaskPrompt(issue: LinearIssue): string {
  return `Work on Linear task ${issue.identifier}: ${issue.title}\n${issue.url}\n\n${issue.description ?? ""}\n\nSuggested branch: ${issue.branchName}\nRead the repository instructions, implement the task, and verify the changes. Include ${issue.identifier} in the pull request so Linear can link it.`;
}
