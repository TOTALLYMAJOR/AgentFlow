import type { TaskSummary, WorkerSummary } from "../api/types.js";
import { StatusBadge } from "./StatusBadge.js";

interface WorkerBoardProps {
  workers: WorkerSummary[];
  tasks: TaskSummary[];
  workerLimit: number;
  onSelectTask: (taskId: string, trigger: HTMLButtonElement) => void;
}

const SLOT_COUNT = 4;

export function WorkerBoard({
  workers,
  tasks,
  workerLimit,
  onSelectTask,
}: WorkerBoardProps): React.JSX.Element {
  return (
    <section className="build-panel" aria-labelledby="worker-board-title">
      <header className="panel-heading">
        <div>
          <h2 id="worker-board-title">Worker slots</h2>
          <p>
            {workerLimit} of {SLOT_COUNT} local slots enabled
          </p>
        </div>
      </header>
      <div className="worker-grid">
        {Array.from({ length: SLOT_COUNT }, (_, index) => {
          const slot = index + 1;
          const worker = workers.find((candidate) => candidate.slot === slot);
          const task = tasks.find((candidate) => candidate.id === worker?.taskId);
          const enabled = slot <= workerLimit;
          return (
            <article
              className={enabled ? "worker-slot" : "worker-slot is-disabled"}
              key={slot}
            >
              <div className="worker-slot__heading">
                <span>Worker {slot}</span>
                <StatusBadge
                  status={enabled ? (worker?.status ?? "idle") : "disabled"}
                />
              </div>
              {task === undefined ? (
                <strong>{enabled ? "Available" : "Not enabled"}</strong>
              ) : (
                <button
                  type="button"
                  className="text-button worker-slot__task"
                  onClick={(event) => {
                    onSelectTask(task.id, event.currentTarget);
                  }}
                >
                  <span className="mono">{task.backlogTaskId}</span>
                  <strong>{task.title}</strong>
                </button>
              )}
              <span className="worker-slot__heartbeat">
                {worker?.heartbeatAt === null ||
                worker?.heartbeatAt === undefined
                  ? "No heartbeat"
                  : `Heartbeat ${formatRelativeTime(worker.heartbeatAt)}`}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatRelativeTime(value: string): string {
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1_000),
  );
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s ago`;
  }
  return `${Math.floor(elapsedSeconds / 60)}m ago`;
}
