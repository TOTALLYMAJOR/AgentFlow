import { useId } from "react";
import type { BuildEvent } from "../api/types.js";

interface EventTimelineProps {
  events: BuildEvent[];
  connected: boolean;
  title?: string;
  emptyMessage?: string;
}

export function EventTimeline({
  events,
  connected,
  title = "Recent events",
  emptyMessage = "No durable events have been recorded yet.",
}: EventTimelineProps): React.JSX.Element {
  const titleId = useId();
  const visibleEvents = events.slice().reverse();
  return (
    <section className="build-panel event-panel" aria-labelledby={titleId}>
      <header className="panel-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          <p>{connected ? "Live SSE connection" : "Reconnecting SSE stream"}</p>
        </div>
        <span
          className={connected ? "stream-state is-live" : "stream-state"}
          role="status"
        >
          {connected ? "Live" : "Reconnecting"}
        </span>
      </header>
      {visibleEvents.length === 0 ? (
        <p className="panel-empty">{emptyMessage}</p>
      ) : (
        <ol className="event-list">
          {visibleEvents.map((event) => {
            const isRecovery = /(recover|reconcil|reattach|interrupt)/i.test(
              event.type,
            );
            return (
              <li className={isRecovery ? "is-recovery" : undefined} key={event.sequence}>
                <span className="mono">#{event.sequence}</span>
                <span>
                  <strong>{event.type.replaceAll("_", " ")}</strong>
                  {event.taskId === null ? null : (
                    <span className="mono">{event.taskId}</span>
                  )}
                </span>
                <time dateTime={event.occurredAt}>
                  {new Date(event.occurredAt).toLocaleTimeString()}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
