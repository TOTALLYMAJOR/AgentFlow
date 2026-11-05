// @vitest-environment jsdom

import { act, Component, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuildEvent } from "../src/api/types.js";
import { EventTimeline } from "../src/components/EventTimeline.js";
import { useBuildEvents } from "../src/hooks/use-build-events.js";

type Listener = (event: MessageEvent<string>) => void;

class TestEventSource {
  static instances: TestEventSource[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  closed = false;
  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }
  addEventListener(type: string, callback: Listener): void {
    const callbacks = this.listeners.get(type) ?? new Set<Listener>();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }
  removeEventListener(type: string, callback: Listener): void {
    this.listeners.get(type)?.delete(callback);
  }
  close(): void { this.closed = true; }
  emit(type: string, data = ""): void {
    for (const callback of this.listeners.get(type) ?? []) {
      callback(new MessageEvent<string>(type, { data }));
    }
  }
}

interface Observation { buildId: string | null; events: BuildEvent[]; connected: boolean }
let observations: Observation[];
let root: Root;
let container: HTMLDivElement;

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override render(): ReactNode {
    return this.state.failed ? <p>Activity view crashed</p> : this.props.children;
  }
}

function Probe({ buildId }: { buildId: string | null }): React.JSX.Element {
  const state = useBuildEvents(buildId);
  useLayoutEffect(() => { observations.push({ buildId, ...state }); });
  return <EventTimeline {...state} />;
}
function render(buildId: string | null): void {
  act(() => root.render(<Boundary><Probe buildId={buildId} /></Boundary>));
}
function stream(): TestEventSource {
  const current = TestEventSource.instances.at(-1);
  if (current === undefined) throw new Error("Expected a subscribed event stream");
  return current;
}
function latest(): Observation {
  const value = observations.at(-1);
  if (value === undefined) throw new Error("Expected a committed observation");
  return value;
}
function event(sequence = 1, buildId = "build-a"): BuildEvent {
  return { sequence, buildId, taskId: "task-a", type: "task.started", payload: {}, occurredAt: "2026-11-05T01:00:00Z" };
}
function send(value: unknown): void {
  act(() => stream().emit("message", JSON.stringify(value)));
}

beforeEach(() => {
  observations = [];
  TestEventSource.instances = [];
  vi.stubGlobal("EventSource", TestEventSource);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("current-build event stream", () => {
  it.each([
    ["null", null],
    ["array", []],
    ["missing fields", {}],
    ["string sequence", { ...event(), sequence: "1" }],
    ["fractional sequence", { ...event(), sequence: 1.5 }],
    ["unsafe sequence", { ...event(), sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative sequence", { ...event(), sequence: -1 }],
    ["missing task identity", { ...event(), taskId: undefined }],
    ["invalid task identity", { ...event(), taskId: {} }],
    ["invalid type", { ...event(), type: {} }],
    ["invalid date field", { ...event(), occurredAt: {} }],
    ["invalid payload", { ...event(), payload: [] }],
    ["null payload", { ...event(), payload: null }],
    ["different build", event(1, "build-b")],
  ])("ignores %s and continues rendering the next valid event", (_name, value) => {
    render("build-a");
    send(value);
    expect(container.textContent).not.toContain("Activity view crashed");
    expect(latest().events).toEqual([]);
    send(event(2));
    expect(latest().events).toEqual([event(2)]);
    expect(container.textContent).toContain("task.started");
  });

  it("ignores malformed JSON without losing already received events", () => {
    render("build-a");
    send(event());
    act(() => stream().emit("message", "{"));
    expect(latest().events).toEqual([event()]);
    expect(container.textContent).not.toContain("Activity view crashed");
  });

  it("preserves valid build-level events and future event payload fields", () => {
    render("build-a");
    const value = { ...event(0), taskId: null, type: "future.record", payload: { futureField: ["retained"] } };
    send(value);
    expect(latest().events).toEqual([value]);
    expect(container.textContent).toContain("future.record");
  });

  it("does not render the previous build's events or connection during a switch", () => {
    render("build-a");
    send(event());
    const previous = stream();
    const beforeSwitch = observations.length;
    render("build-b");
    const switched = observations.slice(beforeSwitch);
    expect(switched.length).toBeGreaterThan(0);
    expect(switched.every((value) => value.buildId === "build-b" && value.events.length === 0 && !value.connected)).toBe(true);
    expect(previous.closed).toBe(true);
    expect(stream().url).toBe("/api/builds/build-b/events/stream");
    send(event(2, "build-b"));
    expect(latest().events).toEqual([event(2, "build-b")]);
  });

  it("ignores queued callbacks from a disposed subscription", () => {
    render("build-a");
    const previous = stream();
    const callbacks = Object.fromEntries([...previous.listeners].map(([key, values]) => [key, [...values]]));
    render("build-b");
    send(event(1, "build-b"));
    act(() => {
      for (const callback of callbacks.message ?? []) callback(new MessageEvent("message", { data: JSON.stringify(event(2)) }));
      for (const callback of callbacks.error ?? []) callback(new MessageEvent("error"));
    });
    expect(latest().events).toEqual([event(1, "build-b")]);
    expect(latest().connected).toBe(true);
    render(null);
    act(() => { for (const callback of callbacks.open ?? []) callback(new MessageEvent("open")); });
    expect(latest().events).toEqual([]);
    expect(latest().connected).toBe(false);
    expect(TestEventSource.instances).toHaveLength(2);
  });

  it("clears a deselected build before passive effects and closes the stream", () => {
    render("build-a");
    send(event());
    const previous = stream();
    const before = observations.length;
    render(null);
    expect(observations.slice(before).every((value) => value.events.length === 0 && !value.connected)).toBe(true);
    expect(previous.closed).toBe(true);
    expect([...previous.listeners.values()].every((values) => values.size === 0)).toBe(true);
  });

  it("retains ordered recent events across reconnect and deduplicates replay", () => {
    render("build-a");
    act(() => {
      for (let sequence = 105; sequence >= 1; sequence -= 1) stream().emit("message", JSON.stringify(event(sequence)));
    });
    expect(latest().events.map((value) => value.sequence)).toEqual(Array.from({ length: 100 }, (_value, index) => index + 6));
    act(() => stream().emit("error"));
    expect(latest().connected).toBe(false);
    expect(latest().events).toHaveLength(100);
    act(() => stream().emit("open"));
    send({ ...event(105), payload: { replay: true } });
    expect(latest().connected).toBe(true);
    expect(latest().events).toHaveLength(100);
    expect(latest().events.at(-1)?.payload).toEqual({ replay: true });
    render("build-a");
    expect(TestEventSource.instances).toHaveLength(1);
    expect(latest().events).toHaveLength(100);
  });
});

