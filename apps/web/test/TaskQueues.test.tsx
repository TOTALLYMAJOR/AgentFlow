// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskSummary } from "../src/api/types.js";

// Primer ships CSS through its component entrypoint, which Node's focused
// jsdom runner does not load. This test exercises board semantics, so a textual
// badge is the smallest faithful boundary stub.
vi.mock("../src/components/StatusBadge.js", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

import { TaskQueues } from "../src/components/TaskQueues.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("live work board", () => {
  it("maps every known lifecycle state to one operator-facing lane", () => {
    const tasks = [
      task("working", "running"),
      task("attention", "blocked_failed"),
      task("queued", "ready"),
      task("checking", "integrating"),
      task("done", "integrated"),
    ];

    renderBoard(tasks);

    expect(laneTitles()).toEqual([
      "Working",
      "Needs you",
      "Queued",
      "Checking",
      "Done",
    ]);
    for (const item of tasks) {
      expect(container?.querySelectorAll(`[data-task-title="${item.title}"]`)).toHaveLength(1);
    }
  });

  it("keeps unknown server states visible and preserves task selection", () => {
    const onSelectTask = vi.fn();
    renderBoard([task("future", "future_state")], "future", onSelectTask);

    expect(laneTitles()).toContain("Unmapped state");
    const button = container?.querySelector("button.task-row");
    expect(button?.getAttribute("aria-pressed")).toBe("true");

    act(() => (button as HTMLButtonElement).click());
    expect(onSelectTask).toHaveBeenCalledWith("future", button);
  });
});

function renderBoard(
  tasks: TaskSummary[],
  selectedTaskId: string | null = null,
  onSelectTask = vi.fn(),
): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <TaskQueues
        tasks={tasks}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
      />,
    );
  });
  // Add a stable locator without coupling assertions to visible copy layout.
  for (const button of container.querySelectorAll<HTMLButtonElement>("button.task-row")) {
    button.dataset.taskTitle = button.querySelector("strong")?.textContent ?? "";
  }
}

function laneTitles(): string[] {
  return [...(container?.querySelectorAll(".queue-panel h2") ?? [])].map(
    (heading) => heading.textContent,
  );
}

function task(id: string, state: string): TaskSummary {
  return {
    id,
    backlogTaskId: id.toUpperCase(),
    title: `${id} task`,
    state,
    attempt: 0,
    estimateHours: 1,
    branchName: null,
    workerId: null,
    errorCode: null,
    errorMessage: null,
  };
}
