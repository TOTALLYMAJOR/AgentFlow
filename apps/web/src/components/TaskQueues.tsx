import type { TaskSummary } from "../api/types.js";
import { StatusBadge } from "./StatusBadge.js";

interface TaskQueuesProps {
  tasks: TaskSummary[];
  selectedTaskId: string | null;
  onSelectTask: (taskId: string, trigger: HTMLButtonElement) => void;
}

interface QueueDefinition {
  id: string;
  title: string;
  description: string;
  states: Set<string>;
  tone?: "attention";
}

const queues: QueueDefinition[] = [
  {
    id: "working",
    title: "Working",
    description: "Assigned agents and checks currently in progress",
    states: new Set(["assigned", "running", "validating"]),
  },
  {
    id: "attention",
    title: "Needs you",
    description: "Approval, recovery, or a decision is required",
    states: new Set([
      "awaiting_approval",
      "failed",
      "blocked_failed",
      "interrupted",
    ]),
    tone: "attention",
  },
  {
    id: "queued",
    title: "Queued",
    description: "Waiting on dependencies or ready for governed dispatch",
    states: new Set(["pending", "blocked", "ready"]),
  },
  {
    id: "checking",
    title: "Checking",
    description: "Validated work moving through serialized integration",
    states: new Set(["validated", "integrating"]),
  },
  {
    id: "done",
    title: "Done",
    description: "Integrated or completed with durable evidence",
    states: new Set(["integrated", "completed", "cancelled"]),
  },
];

const knownStates = new Set(queues.flatMap((queue) => [...queue.states]));

export function TaskQueues({
  tasks,
  selectedTaskId,
  onSelectTask,
}: TaskQueuesProps): React.JSX.Element {
  return (
    <section className="queue-grid work-board" aria-label="Live work board">
      {[...queues, unknownQueue(tasks)].map((queue) => {
        const queueTasks = tasks.filter((task) => queue.states.has(task.state));
        if (queue.id === "unknown" && queueTasks.length === 0) {
          return null;
        }
        const headingId = `work-board-${queue.id}`;
        return (
          <article
            className={`build-panel queue-panel${
              queue.tone === "attention" ? " queue-panel--attention" : ""
            }`}
            aria-labelledby={headingId}
            key={queue.id}
          >
            <header className="panel-heading">
              <div>
                <h2 id={headingId}>{queue.title}</h2>
                <p>{queue.description}</p>
              </div>
              <span className="queue-count" aria-label={`${queueTasks.length} tasks`}>
                {queueTasks.length}
              </span>
            </header>
            {queueTasks.length === 0 ? (
              <p className="panel-empty">No tasks in this queue.</p>
            ) : (
              <ul className="task-list task-list--buttons">
                {queueTasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className={
                        selectedTaskId === task.id
                          ? "task-row is-selected"
                          : "task-row"
                      }
                      aria-pressed={selectedTaskId === task.id}
                      onClick={(event) => {
                        onSelectTask(task.id, event.currentTarget);
                      }}
                    >
                      <span>
                        <span className="mono">{task.backlogTaskId}</span>
                        <strong>{task.title}</strong>
                      </span>
                      <StatusBadge status={task.state} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </article>
        );
      })}
    </section>
  );
}

/**
 * Unknown server states stay visible instead of silently disappearing. This
 * fail-visible fallback protects operators when the backend lifecycle evolves
 * before the presentation mapping is updated.
 */
function unknownQueue(tasks: TaskSummary[]): QueueDefinition {
  return {
    id: "unknown",
    title: "Unmapped state",
    description: "AgentFlow reported a state this interface does not recognize",
    states: new Set(
      tasks.filter((task) => !knownStates.has(task.state)).map((task) => task.state),
    ),
    tone: "attention",
  };
}
