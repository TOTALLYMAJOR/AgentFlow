import { Label } from "@primer/react";

interface StatusBadgeProps {
  status: string;
}

const successStatuses = new Set(["ok", "ready", "validated", "integrated", "completed"]);
const attentionStatuses = new Set([
  "planning",
  "running",
  "validating",
  "integrating",
  "paused",
  "interrupted",
]);
const dangerStatuses = new Set(["failed", "blocked_failed", "invalid", "unavailable"]);

export function StatusBadge({ status }: StatusBadgeProps): React.JSX.Element {
  const variant = successStatuses.has(status)
    ? "success"
    : dangerStatuses.has(status)
      ? "danger"
      : attentionStatuses.has(status)
        ? "attention"
        : "secondary";

  return (
    <Label size="small" variant={variant}>
      {status.replaceAll("_", " ")}
    </Label>
  );
}
