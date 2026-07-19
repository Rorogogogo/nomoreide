import { useToasts } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";

export default function ToastDemo() {
  const toasts = useToasts();
  return (
    <Button
      onClick={() => {
        toasts.error("The requested operation failed.");
      }}
    >
      Show Toast
    </Button>
  );
}
