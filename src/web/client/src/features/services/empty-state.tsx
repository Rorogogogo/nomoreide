import { Alert } from "@/components/ui/alert";

export function EmptyState({ label }: { label: string }) {
  return (
    <Alert variant="muted" className="m-4 text-center">
      {label}
    </Alert>
  );
}
