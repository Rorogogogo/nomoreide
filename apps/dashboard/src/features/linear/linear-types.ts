export interface LinearChoice { id: string; name: string }
export interface LinearTeam extends LinearChoice { states: { nodes: LinearChoice[] }; projects: { nodes: LinearChoice[] } }
export interface LinearIssue {
  id: string;
  identifier: string; title: string; description: string | null; url: string; branchName: string;
  priority: number; state: LinearChoice; team: LinearChoice; assignee: LinearChoice | null;
  comments?: { nodes: { id: string; body: string; user: { name: string } | null }[]; pageInfo: { hasNextPage: boolean } };
}
export type LinearRequest =
  | { operation: "metadata" }
  | { operation: "binding"; team: string; project: string | null }
  | { operation: "issues"; team: string; project: string | null; after?: string | null }
  | { operation: "issue"; id: string }
  | { operation: "create"; team: string; project: string | null; title: string; description: string }
  | { operation: "update"; id: string; state: string }
  | { operation: "comment"; id: string; body: string };
export interface LinearData {
  teams?: { nodes: LinearTeam[] };
  binding?: { team: string; project: string | null } | null;
  issues?: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  issue?: LinearIssue;
  issueCreate?: { issue: LinearIssue };
}
export type LinearTransport = (request: LinearRequest) => Promise<LinearData>;
export function linearTaskPrompt(issue: LinearIssue): string {
  return `Work on Linear task ${issue.identifier}: ${issue.title}\n${issue.url}\n\n${issue.description ?? ""}\n\nSuggested branch: ${issue.branchName}\nRead the repository instructions, implement the task, and verify the changes. Include ${issue.identifier} in the pull request so Linear can link it.`;
}
