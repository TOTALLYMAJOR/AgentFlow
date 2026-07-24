import { useEffect, useState } from "react";
import type { BuildEvent } from "../api/types.js";

interface BuildEventsState {
  events: BuildEvent[];
  connected: boolean;
}

const MAX_EVENTS = 100;

export function useBuildEvents(buildId: string | null): BuildEventsState {
  const [state, setState] = useState<BuildEventsState>({
    events: [],
    connected: false,
  });

  useEffect(() => {
    if (buildId === null) {
      setState({ events: [], connected: false });
      return;
    }

    const stream = new EventSource(`/api/builds/${buildId}/events/stream`);
    const handleOpen = (): void => {
      setState((current) => ({ ...current, connected: true }));
    };
    const handleMessage = (message: MessageEvent<string>): void => {
      try {
        const event = JSON.parse(message.data) as BuildEvent;
        setState((current) => ({
          connected: true,
          events: [...current.events, event].slice(-MAX_EVENTS),
        }));
      } catch {
        // The raw server event remains durable. Ignore only malformed UI data.
      }
    };
    const handleError = (): void => {
      setState((current) => ({ ...current, connected: false }));
    };

    stream.addEventListener("open", handleOpen);
    stream.addEventListener("message", handleMessage);
    stream.addEventListener("error", handleError);
    return () => {
      stream.removeEventListener("open", handleOpen);
      stream.removeEventListener("message", handleMessage);
      stream.removeEventListener("error", handleError);
      stream.close();
    };
  }, [buildId]);

  return state;
}
