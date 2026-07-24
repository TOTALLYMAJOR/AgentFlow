import { useEffect, useRef, useState } from "react";
import { Button, Flash } from "@primer/react";
import { ArrowClockwiseIcon, XIcon } from "@phosphor-icons/react";
import useSWR from "swr";
import { ApiClientError, apiFetch, postJson } from "../api/client.js";
import type {
  AttemptDocumentName,
  AttemptDocumentResponse,
  BuildEvent,
  TaskAttempt,
  TaskDetail,
  TaskDiffResponse,
  TaskOwnership,
  TaskValidationCommand,
} from "../api/types.js";
import { LoadingState } from "./LoadingState.js";
import { StatusBadge } from "./StatusBadge.js";

interface TaskInspectorProps {
  buildId: string;
  taskId: string;
  liveEvents: BuildEvent[];
  onClose: () => void;
  onRetried: () => Promise<void>;
}

const retryableStates = new Set(["failed", "blocked_failed", "interrupted"]);

const attemptDocumentNames = [
  "prompt",
  "jsonl",
  "stderr",
  "result",
  "outcome",
] as const satisfies readonly AttemptDocumentName[];

const attemptDocumentLabels: Record<AttemptDocumentName, string> = {
  prompt: "Worker prompt",
  jsonl: "JSONL event stream",
  stderr: "Worker stderr",
  result: "Worker result",
  outcome: "Worker outcome",
};

type AttemptDocumentState =
  | {
      status: "available";
      document: AttemptDocumentResponse;
    }
  | {
      status: "unavailable" | "error";
      message: string;
    };

type AttemptDocumentSet = Record<AttemptDocumentName, AttemptDocumentState>;
type AttemptDocumentKey = readonly [
  "task-attempt-documents",
  string,
  string,
  number,
];

export function TaskInspector({
  buildId,
  taskId,
  liveEvents,
  onClose,
  onRetried,
}: TaskInspectorProps): React.JSX.Element {
  const inspectorRef = useRef<HTMLElement>(null);
  const task = useSWR<TaskDetail>(
    `/api/builds/${buildId}/tasks/${taskId}`,
    apiFetch,
    { refreshInterval: 4_000 },
  );
  const latestAttempt = findLatestAttempt(task.data?.attempts ?? []);
  const latestAttemptNumber = latestAttempt?.attempt ?? null;
  const attemptDocumentKey: AttemptDocumentKey | null =
    latestAttemptNumber === null
      ? null
      : [
          "task-attempt-documents",
          buildId,
          taskId,
          latestAttemptNumber,
        ];
  const attemptDocuments = useSWR<
    AttemptDocumentSet,
    Error,
    AttemptDocumentKey | null
  >(
    attemptDocumentKey,
    async ([, selectedBuildId, selectedTaskId, selectedAttempt]) =>
      loadAttemptDocuments(
        selectedBuildId,
        selectedTaskId,
        selectedAttempt,
      ),
    { refreshInterval: 4_000 },
  );
  const taskDiff = useSWR<TaskDiffResponse>(
    `/api/builds/${buildId}/tasks/${taskId}/diff`,
    apiFetch,
    { refreshInterval: 4_000 },
  );
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    inspectorRef.current?.focus();
  }, [taskId]);

  async function retryTask(): Promise<void> {
    setRetrying(true);
    setActionError(null);
    try {
      await postJson(`/api/builds/${buildId}/tasks/${taskId}/retry`);
      await Promise.all([task.mutate(), onRetried()]);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : "The retry could not be queued.",
      );
    } finally {
      setRetrying(false);
    }
  }

  if (task.isLoading) {
    return (
      <aside
        ref={inspectorRef}
        className="task-inspector"
        aria-label="Task inspector"
        tabIndex={-1}
      >
        <LoadingState label="Loading task inspector" height="420px" />
      </aside>
    );
  }

  if (task.error !== undefined || task.data === undefined) {
    return (
      <aside
        ref={inspectorRef}
        className="task-inspector"
        aria-label="Task inspector"
        tabIndex={-1}
      >
        <div className="inspector-heading">
          <div>
            <span className="eyebrow">Task inspector</span>
            <h2>Task unavailable</h2>
          </div>
          <Button
            size="small"
            leadingVisual={XIcon}
            aria-label="Close task inspector"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
        <Flash variant="danger">
          The durable task record could not be loaded. No task state was
          inferred.
        </Flash>
      </aside>
    );
  }

  const detail = task.data;
  const taskEvents = mergeEvents(
    detail.events,
    liveEvents.filter((event) => event.taskId === taskId),
  );
  const canRetry = retryableStates.has(detail.state);

  return (
    <aside
      ref={inspectorRef}
      className="task-inspector"
      aria-labelledby="task-inspector-title"
      tabIndex={-1}
    >
      <div className="inspector-heading">
        <div>
          <span className="eyebrow">Task inspector</span>
          <h2 id="task-inspector-title">{detail.title}</h2>
          <span className="mono">{detail.backlogTaskId}</span>
        </div>
        <div className="row-actions">
          <Button
            size="small"
            leadingVisual={ArrowClockwiseIcon}
            disabled={!canRetry || retrying}
            title={
              canRetry
                ? "Queue a new durable attempt"
                : "Retry becomes available after failure or interruption"
            }
            onClick={() => {
              void retryTask();
            }}
          >
            {retrying ? "Retrying…" : "Retry"}
          </Button>
          <Button
            size="small"
            leadingVisual={XIcon}
            aria-label="Close task inspector"
            onClick={onClose}
          >
            Close
          </Button>
        </div>
      </div>

      {actionError === null ? null : (
        <Flash className="inspector-flash" variant="danger">
          {actionError}
        </Flash>
      )}

      <dl className="metadata-grid">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={detail.state} />
          </dd>
        </div>
        <div>
          <dt>Attempt</dt>
          <dd>{detail.attempt}</dd>
        </div>
        <div>
          <dt>Estimate</dt>
          <dd>
            {detail.estimateHours === null ? "Not estimated" : `${detail.estimateHours}h`}
          </dd>
        </div>
        <div>
          <dt>Risk</dt>
          <dd>{detail.riskScore ?? 0}</dd>
        </div>
        <div>
          <dt>Worker</dt>
          <dd className="mono">{detail.workerId ?? latestAttempt?.workerId ?? "Unassigned"}</dd>
        </div>
        <div>
          <dt>Approval</dt>
          <dd>{detail.requiresApproval === true ? "Required" : "Not required"}</dd>
        </div>
      </dl>

      {detail.errorMessage === null ? null : (
        <Flash className="inspector-flash" variant="danger">
          <strong>{detail.errorCode ?? "TASK_FAILED"}</strong>
          <br />
          {detail.errorMessage}
        </Flash>
      )}

      <details open>
        <summary>Scope and acceptance</summary>
        <div className="inspector-section">
          <p>{detail.description || "No task description was recorded."}</p>
          <h3>Acceptance criteria</h3>
          {detail.acceptanceCriteria.length === 0 ? (
            <p className="compact-empty">No acceptance criteria recorded.</p>
          ) : (
            <ul>
              {detail.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details>
        <summary>Dependencies and ownership</summary>
        <div className="inspector-section inspector-split">
          <div>
            <h3>Dependencies</h3>
            {detail.dependencies.length === 0 ? (
              <p className="compact-empty">No task dependencies.</p>
            ) : (
              <ul className="definition-list">
                {detail.dependencies.map((dependency) => (
                  <li
                    key={`${dependency.dependencyTaskId}:${dependency.dependencyType}`}
                  >
                    <code>{dependency.dependencyTaskId}</code>
                    <span>{dependency.dependencyType}</span>
                    {dependency.requiredArtifactName === null ? null : (
                      <span>
                        {dependency.requiredArtifactName}@
                        {dependency.requiredArtifactVersion ?? "any"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>Owned paths</h3>
            {detail.ownership.length === 0 ? (
              <p className="compact-empty">No ownership paths recorded.</p>
            ) : (
              <ul className="path-list">
                {detail.ownership.map((ownership) => {
                  const path = ownershipPath(ownership);
                  return <li key={path}>{path}</li>;
                })}
              </ul>
            )}
          </div>
        </div>
      </details>

      <details>
        <summary>Attempt history and documents</summary>
        <div className="inspector-section">
          {detail.attempts.length === 0 ? (
            <p className="compact-empty">No attempts have started.</p>
          ) : (
            <ol className="attempt-list">
              {detail.attempts
                .slice()
                .reverse()
                .map((attempt) => (
                  <li key={attempt.id}>
                    <header>
                      <strong>Attempt {attempt.attempt}</strong>
                      <StatusBadge status={attempt.status} />
                    </header>
                    <dl>
                      <div>
                        <dt>Prompt</dt>
                        <dd className="path-text">
                          {attempt.promptPath ?? "Not written"}
                        </dd>
                      </div>
                      <div>
                        <dt>JSONL</dt>
                        <dd className="path-text">
                          {attempt.jsonlPath ?? "Not written"}
                        </dd>
                      </div>
                      <div>
                        <dt>Raw log</dt>
                        <dd className="path-text">
                          {attempt.logPath ?? "Not written"}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
            </ol>
          )}

          <h3>Latest attempt documents</h3>
          {latestAttemptNumber === null ? (
            <p className="compact-empty">
              No attempt documents are available because no attempt has
              started.
            </p>
          ) : (
            <>
              <p className="attempt-document-summary">
                Showing durable runtime evidence for attempt{" "}
                <strong>{latestAttemptNumber}</strong>.
              </p>
              {attemptDocuments.error === undefined ? (
                <ul className="attempt-document-list">
                  {attemptDocumentNames.map((documentName) => (
                    <li key={documentName}>
                      {renderAttemptDocument(
                        documentName,
                        attemptDocuments.data?.[documentName],
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Flash variant="danger">
                  Attempt documents could not be loaded from the local API.
                </Flash>
              )}
            </>
          )}
        </div>
      </details>

      <details>
        <summary>Durable task events</summary>
        <div className="inspector-section">
          {taskEvents.length === 0 ? (
            <p className="compact-empty">No task events recorded.</p>
          ) : (
            <ol className="inspector-event-list">
              {taskEvents
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.sequence}>
                    <header>
                      <strong>{event.type}</strong>
                      <time dateTime={event.occurredAt}>
                        {new Date(event.occurredAt).toLocaleString()}
                      </time>
                    </header>
                    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                  </li>
                ))}
            </ol>
          )}
        </div>
      </details>

      <details>
        <summary>Changed files and diff</summary>
        <div className="inspector-section">
          {detail.changedFiles.length === 0 ? (
            <p className="compact-empty">No changed files recorded.</p>
          ) : (
            <div className="table-shell compact-table" role="region" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Path</th>
                    <th scope="col">Change</th>
                    <th scope="col">Ownership</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.changedFiles.map((file) => (
                    <tr key={`${file.attempt}:${file.path}`}>
                      <td>
                        <span className="path-text">{file.path}</span>
                        {file.previousPath === null ? null : (
                          <span className="path-text">
                            from {file.previousPath}
                          </span>
                        )}
                      </td>
                      <td>{file.changeType}</td>
                      <td>
                        <StatusBadge
                          status={
                            file.withinOwnership
                              ? "within ownership"
                              : "violation"
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {taskDiff.isLoading ? (
            <p className="compact-empty" aria-live="polite">
              Loading task diff…
            </p>
          ) : taskDiff.error !== undefined ? (
            <Flash variant="danger">
              The task diff could not be loaded from the local API.
            </Flash>
          ) : taskDiff.data?.available === false ? (
            <p className="data-boundary-note">
              {taskDiff.data.reason ?? "The task diff is not available."}
            </p>
          ) : taskDiff.data?.available === true ? (
            <div className="diff-evidence">
              <dl>
                <div>
                  <dt>Base commit</dt>
                  <dd className="mono">
                    {taskDiff.data.baseCommit ?? "Not reported"}
                  </dd>
                </div>
                <div>
                  <dt>Target</dt>
                  <dd className="mono">
                    {taskDiff.data.target ?? "Not reported"}
                  </dd>
                </div>
              </dl>
              <pre className="code-block code-block--diff">
                {taskDiff.data.diff === undefined ||
                taskDiff.data.diff.length === 0
                  ? "(empty diff)"
                  : taskDiff.data.diff}
              </pre>
            </div>
          ) : (
            <p className="compact-empty">No diff response was returned.</p>
          )}
        </div>
      </details>

      <details>
        <summary>Validation runs</summary>
        <div className="inspector-section">
          {detail.validationCommands.length === 0 ? null : (
            <>
              <h3>Required commands</h3>
              <ol className="command-list">
                {detail.validationCommands.map((command, index) => (
                  <li key={validationCommandKey(command, index)}>
                    <code>{validationCommandValue(command)}</code>
                  </li>
                ))}
              </ol>
            </>
          )}
          {detail.validations.length === 0 ? (
            <p className="compact-empty">No validation runs recorded.</p>
          ) : (
            <ul className="validation-list">
              {detail.validations.map((validation) => (
                <li key={validation.id}>
                  <header>
                    <span>
                      <strong>{validation.validationType}</strong>
                      <code>{validation.command}</code>
                    </span>
                    <StatusBadge status={validation.status} />
                  </header>
                  <span className="path-text">
                    {validation.logPath ?? "No raw log path recorded"}
                  </span>
                  <span>
                    Exit: {validation.exitCode === null ? "pending" : validation.exitCode}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details>
        <summary>Artifacts, manifests, and approvals</summary>
        <div className="inspector-section inspector-split">
          <div>
            <h3>Artifacts</h3>
            {detail.artifacts.length === 0 ? (
              <p className="compact-empty">No artifacts produced.</p>
            ) : (
              <ul className="definition-list">
                {detail.artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <strong>{artifact.name}</strong>
                    <span>
                      {artifact.artifactType}@{artifact.version}
                    </span>
                    <StatusBadge status={artifact.status} />
                  </li>
                ))}
              </ul>
            )}
            <h3>Manifests</h3>
            {detail.manifests.length === 0 ? (
              <p className="compact-empty">No manifests generated.</p>
            ) : (
              <ul className="path-list">
                {detail.manifests.map((manifest) => (
                  <li key={manifest.id}>{manifest.manifestPath}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>Approvals</h3>
            {detail.approvals.length === 0 ? (
              <p className="compact-empty">No approvals requested.</p>
            ) : (
              <ul className="definition-list">
                {detail.approvals.map((approval) => (
                  <li key={approval.id}>
                    <strong>{approval.approvalType}</strong>
                    <span>{approval.reason}</span>
                    <StatusBadge status={approval.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </details>

      <details>
        <summary>Commits</summary>
        <dl className="inspector-section commit-list">
          <div>
            <dt>Base</dt>
            <dd className="mono">{detail.baseCommit ?? "Not recorded"}</dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd className="mono">{detail.resultCommit ?? "Not created"}</dd>
          </div>
          <div>
            <dt>Integration</dt>
            <dd className="mono">
              {detail.integrationCommit ?? "Not integrated"}
            </dd>
          </div>
          <div>
            <dt>Task branch</dt>
            <dd className="mono">{detail.branchName ?? "Not created"}</dd>
          </div>
          <div>
            <dt>Worktree</dt>
            <dd className="path-text">
              {detail.worktreePath ?? "Not created"}
            </dd>
          </div>
        </dl>
      </details>
    </aside>
  );
}

async function loadAttemptDocuments(
  buildId: string,
  taskId: string,
  attempt: number,
): Promise<AttemptDocumentSet> {
  const encodedBuildId = encodeURIComponent(buildId);
  const encodedTaskId = encodeURIComponent(taskId);
  const entries = await Promise.all(
    attemptDocumentNames.map(async (documentName) => {
      try {
        const document = await apiFetch<AttemptDocumentResponse>(
          `/api/builds/${encodedBuildId}/tasks/${encodedTaskId}/attempts/${attempt}/${documentName}`,
        );
        return [
          documentName,
          { status: "available", document } satisfies AttemptDocumentState,
        ] as const;
      } catch (cause) {
        const unavailable =
          cause instanceof ApiClientError && cause.status === 404;
        return [
          documentName,
          {
            status: unavailable ? "unavailable" : "error",
            message:
              cause instanceof Error
                ? cause.message
                : `${attemptDocumentLabels[documentName]} could not be loaded.`,
          } satisfies AttemptDocumentState,
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as AttemptDocumentSet;
}

function renderAttemptDocument(
  documentName: AttemptDocumentName,
  state: AttemptDocumentState | undefined,
): React.JSX.Element {
  const label = attemptDocumentLabels[documentName];
  return (
    <article className="attempt-document">
      <header>
        <div>
          <h4>{label}</h4>
          <code>{documentName}</code>
        </div>
        <span
          className={`attempt-document__state attempt-document__state--${
            state?.status ?? "loading"
          }`}
        >
          {state === undefined
            ? "Loading"
            : state.status === "available"
              ? "Available"
              : state.status === "unavailable"
                ? "Unavailable"
                : "Load error"}
        </span>
      </header>
      {state === undefined ? (
        <p className="compact-empty" aria-live="polite">
          Loading {label.toLowerCase()}…
        </p>
      ) : state.status === "available" ? (
        <>
          <dl className="attempt-document__metadata">
            <div className="attempt-document__path">
              <dt>Path</dt>
              <dd>
                <code>{state.document.path}</code>
              </dd>
            </div>
            <div>
              <dt>Truncation</dt>
              <dd>
                {state.document.truncated
                  ? "Yes (tail only)"
                  : "No (complete file)"}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(state.document.sizeBytes)}</dd>
            </div>
          </dl>
          <pre className="code-block">
            {state.document.content.length === 0
              ? "(empty document)"
              : state.document.content}
          </pre>
        </>
      ) : (
        <p
          className={
            state.status === "error"
              ? "attempt-document__error"
              : "compact-empty"
          }
          role={state.status === "error" ? "alert" : undefined}
        >
          {state.message}
        </p>
      )}
    </article>
  );
}

function findLatestAttempt(attempts: TaskAttempt[]): TaskAttempt | undefined {
  return attempts.reduce<TaskAttempt | undefined>(
    (latest, candidate) =>
      latest === undefined || candidate.attempt > latest.attempt
        ? candidate
        : latest,
    undefined,
  );
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1_024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1_024 * 1_024) {
    return `${(sizeBytes / 1_024).toFixed(1)} KiB`;
  }
  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function mergeEvents(
  durableEvents: BuildEvent[],
  liveEvents: BuildEvent[],
): BuildEvent[] {
  const bySequence = new Map<number, BuildEvent>();
  for (const event of [...durableEvents, ...liveEvents]) {
    bySequence.set(event.sequence, event);
  }
  return [...bySequence.values()].sort(
    (first, second) => first.sequence - second.sequence,
  );
}

function ownershipPath(ownership: TaskOwnership | string): string {
  return typeof ownership === "string" ? ownership : ownership.path;
}

function validationCommandValue(
  command: TaskValidationCommand | string,
): string {
  return typeof command === "string" ? command : command.command;
}

function validationCommandKey(
  command: TaskValidationCommand | string,
  index: number,
): string {
  return typeof command === "string"
    ? `${index}:${command}`
    : `${command.commandOrder}:${command.command}`;
}
