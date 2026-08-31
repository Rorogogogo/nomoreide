"use client";

import { AlertTriangle, Bell, Check, Info, X } from "lucide-react";
import { Badge } from "@/components/ui/cvui-badge";

export const BadgeDemo = () => {
  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <div className="flex flex-wrap gap-4">
        <Badge label="Primary" variant="primary" />
        <Badge label="Secondary" variant="secondary" />
        <Badge label="Success" variant="success" />
        <Badge label="Warning" variant="warning" />
        <Badge label="Error" variant="error" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Badge label="Small" size="small" />
        <Badge label="Medium" size="medium" />
        <Badge label="Large" size="large" />
      </div>

      <div className="flex flex-wrap gap-4">
        <Badge label="Solid" appearance="solid" />
        <Badge label="Outline" appearance="outline" />
        <Badge label="Subtle" appearance="subtle" />
      </div>

      <div className="flex flex-wrap gap-4">
        <Badge label="Notification" icon={<Bell className="size-4" />} />
        <Badge label="Success" variant="success" icon={<Check className="size-4" />} />
        <Badge
          label="Warning"
          variant="warning"
          icon={<AlertTriangle className="size-4" />}
        />
        <Badge label="Error" variant="error" icon={<X className="size-4" />} />
        <Badge label="Info" variant="primary" icon={<Info className="size-4" />} />
      </div>

      <div className="flex flex-wrap gap-4">
        <Badge label="Clickable" onClick={() => alert("Clicked!")} />
        <Badge label="Removable" removable onRemove={() => alert("Removed!")} />
        <Badge label="Max Width" maxWidth={100} />
      </div>

      <Badge
        label="Complete Example"
        size="large"
        icon={<Check className="size-4" />}
        onClick={() => alert("Clicked!")}
        removable
        maxWidth={200}
      />
      <Badge label="Loading" isLoading />
    </div>
  );
};
