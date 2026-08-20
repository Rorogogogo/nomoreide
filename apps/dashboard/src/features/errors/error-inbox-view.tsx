import { useMemo } from "react";
import { IncidentTable } from "./incident-table";
import { useErrorIncidents } from "./use-error-incidents";

export function ErrorInboxView({
  inScope,
  onReviewChanges,
}: {
  /** Project-scope filter; when set, only incidents from these services show. */
  inScope?: (service: string) => boolean;
  /** Deep-link to Agent → Changes for a fix run's recorded session. */
  onReviewChanges?: (sessionId: string) => void;
} = {}) {
  const { incidents: allIncidents, connected, error } = useErrorIncidents();
  const incidents = useMemo(
    () =>
      inScope
        ? allIncidents.filter((incident) => inScope(incident.service))
        : allIncidents,
    [allIncidents, inScope],
  );

  return (
    <IncidentTable
      connected={connected}
      error={error}
      incidents={incidents}
      onReviewChanges={onReviewChanges}
    />
  );
}
