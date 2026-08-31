import { useEffect, useId, useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { listSshServers, type SshServerSummary } from "@/lib/api";

/** Controlled SSH alias input with suggestions from the shared Servers registry. */
export function SshHostInput({
  value,
  onChange,
  ...props
}: Omit<ComponentProps<typeof Input>, "list" | "onChange" | "value"> & {
  value: string;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const [servers, setServers] = useState<SshServerSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listSshServers().then((next) => {
      if (!cancelled) setServers(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Input
        {...props}
        list={listId}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
      <datalist id={listId}>
        {servers.map((server) => (
          <option key={server.host} value={server.host}>
            {server.name ?? server.environment ?? server.host}
          </option>
        ))}
      </datalist>
    </>
  );
}
