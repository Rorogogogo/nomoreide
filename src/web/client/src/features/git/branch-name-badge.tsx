import { Badge } from "@/components/ui/badge";

export function BranchNameBadge({ branch }: { branch: string }) {
  return (
    <span className="min-w-0 max-w-40" title={branch}>
      <Badge className="w-full max-w-full shadow-none" variant="outline">
        {branch}
      </Badge>
    </span>
  );
}
