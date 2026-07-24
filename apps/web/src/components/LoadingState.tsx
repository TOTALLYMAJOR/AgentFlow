import { SkeletonBox } from "@primer/react";

interface LoadingStateProps {
  label: string;
  height?: string;
}

export function LoadingState({
  label,
  height = "220px",
}: LoadingStateProps): React.JSX.Element {
  return (
    <section className="loading-state" aria-busy="true" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <SkeletonBox height={height} width="100%" />
    </section>
  );
}
