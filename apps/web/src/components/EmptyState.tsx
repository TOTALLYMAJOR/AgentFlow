import { Button } from "@primer/react";
import { PlusIcon } from "@phosphor-icons/react";

interface EmptyStateProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps): React.JSX.Element {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <div>
        <h2 id="empty-state-title">{title}</h2>
        <p>{description}</p>
      </div>
      {actionLabel === undefined || onAction === undefined ? null : (
        <Button leadingVisual={PlusIcon} onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </section>
  );
}
