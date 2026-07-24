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
}

const queues: QueueDefinition[] = [
  {
    id: "ready",
    title: "Ready queue",
    description: "Runnable after dependencies and ownership checks",
    states: new Set(["ready"]),
  },
  {
    id: "blocked",
    title: "Blocked tasks",
    description: "Waiting on work, artifacts, approval, or review",
    states: new Set(["pending", "blocked", "blocked_failed", "awaiting_approval"]),
  },
  {
    id: "integration",
    title: "Integration queue",
    description: "Validated work waiting for serialized integration",
    states: new Set(["validated", "integrating"]),
  },
];

export function TaskQueues({
  tasks,
  selectedTaskId,
  onSelectTask,
}: TaskQueuesProps): React.JSX.Element {
  return (
    <section className="queue-grid" aria-label="Build task queues">
      {queues.map((queue) => {
        const queueTasks = tasks.filter((task) => queue.states.has(task.state));
        return (
          <article className="build-panel queue-panel" key={queue.id}>
            <header className="panel-heading">
              <div>
                <h2>{queue.title}</h2>
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
