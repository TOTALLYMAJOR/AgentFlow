import { useEffect, useState } from "react";
import type { BuildEvent } from "../api/types.js";

interface BuildEventsState {
  events: BuildEvent[];
  connected: boolean;
}

interface BuildEventsSnapshot extends BuildEventsState {
  buildId: string | null;
}

const MAX_EVENTS = 100;

function isBuildEvent(value: unknown, buildId: string): value is BuildEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.sequence === "number" &&
    Number.isSafeInteger(event.sequence) && event.sequence >= 0 &&
    event.buildId === buildId &&
    (event.taskId === null || typeof event.taskId === "string") &&
    typeof event.type === "string" &&
    typeof event.occurredAt === "string" &&
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload);
}

export function useBuildEvents(buildId: string | null): BuildEventsState {
  const [state, setState] = useState<BuildEventsSnapshot>({
    buildId,
    events: [],
    connected: false,
  });

  useEffect(() => {
    setState({ buildId, events: [], connected: false });
    if (buildId === null) {
      return;
    }

    let active = true;
    const stream = new EventSource(`/api/builds/${buildId}/events/stream`);
    const updateCurrent = (update: (current: BuildEventsSnapshot) => BuildEventsSnapshot): void => {
      if (!active) return;
      setState((current) => active && current.buildId === buildId ? update(current) : current);
    };
    const handleOpen = (): void => {
      updateCurrent((current) => ({ ...current, connected: true }));
    };
    const handleMessage = (message: MessageEvent<string>): void => {
      try {
        const event: unknown = JSON.parse(message.data);
        if (!isBuildEvent(event, buildId)) return;
        updateCurrent((current) => ({
          buildId,
          connected: true,
          events: [
            ...current.events.filter(
              (candidate) => candidate.sequence !== event.sequence,
            ),
            event,
          ]
            .sort((first, second) => first.sequence - second.sequence)
            .slice(-MAX_EVENTS),
        }));
      } catch {
        // The raw server event remains durable. Ignore only malformed UI data.
      }
    };
    const handleError = (): void => {
      updateCurrent((current) => ({ ...current, connected: false }));
    };

    stream.addEventListener("open", handleOpen);
    stream.addEventListener("message", handleMessage);
    stream.addEventListener("error", handleError);
    return () => {
      active = false;
      stream.removeEventListener("open", handleOpen);
      stream.removeEventListener("message", handleMessage);
      stream.removeEventListener("error", handleError);
      stream.close();
    };
  }, [buildId]);

  // Fence the render before passive-effect cleanup/reset when selection changes.
  return state.buildId === buildId
    ? { events: state.events, connected: state.connected }
    : { events: [], connected: false };
}
