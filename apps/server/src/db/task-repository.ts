import type Database from "better-sqlite3";
import { canTransitionTask } from "../orchestration/state-machines.js";
import { createId } from "../util/ids.js";
import {
  ConcurrentStateChangeError,
  InvalidStateTransitionError,
  decodeJson,
  encodeJson,
  inImmediateTransaction,
  insertBuildEvent,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import type {
  AttemptStatus,
  ChangedFileEntity,
  CreateTaskAttemptInput,
  CreateTaskInput,
  DependencyType,
  FileChangeType,
  RecordChangedFileInput,
  TaskAttemptEntity,
  TaskDependencyEntity,
  TaskEntity,
  TaskStatus,
  TaskValidationCommandEntity,
} from "./types.js";

interface TaskRow {
  id: string;
  build_id: string;
  backlog_task_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
  state: TaskStatus;
  branch_name: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  result_commit: string | null;
  integration_commit: string | null;
  estimate_hours: number | null;
  attempt: number;
  allow_no_changes: number;
  risk_score: number;
  requires_approval: number;
  ranking_score: number | null;
  ranking_explanation: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

interface TaskDependencyRow {
  task_id: string;
  dependency_task_id: string;
  dependency_type: DependencyType;
  required_artifact_name: string | null;
  required_artifact_version: string | null;
}

interface ValidationCommandRow {
  task_id: string;
  command_order: number;
  command: string;
}

interface TaskAttemptRow {
  id: string;
  task_id: string;
  build_id: string;
  attempt: number;
  worker_id: string | null;
  status: AttemptStatus;
  prompt_path: string | null;
  jsonl_path: string | null;
  log_path: string | null;
  result_commit: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface ChangedFileRow {
  task_id: string;
  attempt: number;
  path: string;
  change_type: FileChangeType;
  previous_path: string | null;
  within_ownership: number;
  sha256: string | null;
}

function mapTask(row: TaskRow): TaskEntity {
  return {
    id: row.id,
    buildId: row.build_id,
    backlogTaskId: row.backlog_task_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: decodeJson<string[]>(
      row.acceptance_criteria,
      "tasks.acceptance_criteria",
    ),
    state: row.state,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    resultCommit: row.result_commit,
    integrationCommit: row.integration_commit,
    estimateHours: row.estimate_hours,
    attempt: row.attempt,
    allowNoChanges: row.allow_no_changes === 1,
    riskScore: row.risk_score,
    requiresApproval: row.requires_approval === 1,
    rankingScore: row.ranking_score,
    rankingExplanation: row.ranking_explanation,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

function mapDependency(row: TaskDependencyRow): TaskDependencyEntity {
  return {
    taskId: row.task_id,
    dependencyTaskId: row.dependency_task_id,
    dependencyType: row.dependency_type,
    requiredArtifactName: row.required_artifact_name,
    requiredArtifactVersion: row.required_artifact_version,
  };
}

function mapValidationCommand(
  row: ValidationCommandRow,
): TaskValidationCommandEntity {
  return {
    taskId: row.task_id,
    commandOrder: row.command_order,
    command: row.command,
  };
}

function mapAttempt(row: TaskAttemptRow): TaskAttemptEntity {
  return {
    id: row.id,
    taskId: row.task_id,
    buildId: row.build_id,
    attempt: row.attempt,
    workerId: row.worker_id,
    status: row.status,
    promptPath: row.prompt_path,
    jsonlPath: row.jsonl_path,
    logPath: row.log_path,
    resultCommit: row.result_commit,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function mapChangedFile(row: ChangedFileRow): ChangedFileEntity {
  return {
    taskId: row.task_id,
    attempt: row.attempt,
    path: row.path,
    changeType: row.change_type,
    previousPath: row.previous_path,
    withinOwnership: row.within_ownership === 1,
    sha256: row.sha256,
  };
}

const TASK_SELECT = `
  SELECT
    id, build_id, backlog_task_id, title, description, acceptance_criteria,
    state, branch_name, worktree_path, base_commit, result_commit,
    integration_commit, estimate_hours, attempt, allow_no_changes, risk_score,
    requires_approval, ranking_score, ranking_explanation, started_at,
    completed_at, error_code, error_message, created_at
  FROM tasks
`;

const ATTEMPT_SELECT = `
  SELECT
    id, task_id, build_id, attempt, worker_id, status, prompt_path, jsonl_path,
    log_path, result_commit, error_code, error_message, started_at,
    completed_at, created_at
  FROM task_attempts
`;

export function insertTaskRecord(
  database: Database.Database,
  buildId: string,
  input: CreateTaskInput,
  clock: Clock,
): void {
  if (input.buildId !== undefined && input.buildId !== buildId) {
    throw new Error(`Task ${input.id} does not belong to build ${buildId}`);
  }
  database
    .prepare<{
      id: string;
      buildId: string;
      backlogTaskId: string;
      title: string;
      description: string;
      acceptanceCriteria: string;
      state: TaskStatus;
      branchName: string | null;
      worktreePath: string | null;
      baseCommit: string | null;
      resultCommit: string | null;
      integrationCommit: string | null;
      estimateHours: number | null;
      attempt: number;
      allowNoChanges: number;
      riskScore: number;
      requiresApproval: number;
      rankingScore: number | null;
      rankingExplanation: string | null;
      startedAt: string | null;
      completedAt: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdAt: string;
    }>(
      `INSERT INTO tasks (
         id, build_id, backlog_task_id, title, description,
         acceptance_criteria, state, branch_name, worktree_path, base_commit,
         result_commit, integration_commit, estimate_hours, attempt,
         allow_no_changes, risk_score, requires_approval, ranking_score,
         ranking_explanation, started_at, completed_at, error_code,
         error_message, created_at
       ) VALUES (
         @id, @buildId, @backlogTaskId, @title, @description,
         @acceptanceCriteria, @state, @branchName, @worktreePath, @baseCommit,
         @resultCommit, @integrationCommit, @estimateHours, @attempt,
         @allowNoChanges, @riskScore, @requiresApproval, @rankingScore,
         @rankingExplanation, @startedAt, @completedAt, @errorCode,
         @errorMessage, @createdAt
       )`,
    )
    .run({
      id: input.id,
      buildId,
      backlogTaskId: input.backlogTaskId ?? input.id,
      title: input.title,
      description: input.description,
      acceptanceCriteria: encodeJson(input.acceptanceCriteria),
      state: input.state ?? "pending",
      branchName: input.branchName ?? null,
      worktreePath: input.worktreePath ?? null,
      baseCommit: input.baseCommit ?? null,
      resultCommit: input.resultCommit ?? null,
      integrationCommit: input.integrationCommit ?? null,
      estimateHours: input.estimateHours ?? null,
      attempt: input.attempt ?? 0,
      allowNoChanges: input.allowNoChanges === true ? 1 : 0,
      riskScore: input.riskScore ?? 0,
      requiresApproval: input.requiresApproval === true ? 1 : 0,
      rankingScore: input.rankingScore ?? null,
      rankingExplanation: input.rankingExplanation ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      createdAt: input.createdAt ?? clock(),
    });
}

export function insertTaskRelations(
  database: Database.Database,
  input: CreateTaskInput,
): void {
  const dependencyStatement = database.prepare<{
    taskId: string;
    dependencyTaskId: string;
    dependencyType: DependencyType;
    requiredArtifactName: string | null;
    requiredArtifactVersion: string | null;
  }>(
    `INSERT INTO task_dependencies (
       task_id, dependency_task_id, dependency_type, required_artifact_name,
       required_artifact_version
     ) VALUES (
       @taskId, @dependencyTaskId, @dependencyType, @requiredArtifactName,
       @requiredArtifactVersion
     )`,
  );
  for (const dependency of input.dependencies ?? []) {
    dependencyStatement.run({
      taskId: input.id,
      dependencyTaskId: dependency.dependencyTaskId,
      dependencyType: dependency.dependencyType ?? "hard",
      requiredArtifactName: dependency.requiredArtifactName ?? null,
      requiredArtifactVersion: dependency.requiredArtifactVersion ?? null,
    });
  }

  const ownershipStatement = database.prepare<{
    taskId: string;
    ownedPath: string;
  }>(
    `INSERT INTO task_ownership (task_id, owned_path)
     VALUES (@taskId, @ownedPath)`,
  );
  for (const ownedPath of input.ownedPaths ?? []) {
    ownershipStatement.run({ taskId: input.id, ownedPath });
  }

  const validationStatement = database.prepare<{
    taskId: string;
    commandOrder: number;
    command: string;
  }>(
    `INSERT INTO task_validation_commands (
       task_id, command_order, command
     ) VALUES (
       @taskId, @commandOrder, @command
     )`,
  );
  for (const [commandOrder, command] of (
    input.validationCommands ?? []
  ).entries()) {
    validationStatement.run({ taskId: input.id, commandOrder, command });
  }
}

export interface TaskTransitionOptions {
  eventType?: string;
  payload?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  resultCommit?: string | null;
  integrationCommit?: string | null;
  occurredAt?: string;
}

export interface RetryTaskOptions {
  attemptId?: string;
  occurredAt?: string;
}

export interface IntegrationSuccessInput {
  integrationCommit: string;
  occurredAt?: string;
}

export interface IntegrationFailureInput {
  errorCode: string;
  errorMessage: string;
  occurredAt?: string;
}

export class TaskRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateTaskInput & { buildId: string }): TaskEntity {
    return inImmediateTransaction(this.database, () => {
      insertTaskRecord(this.database, input.buildId, input, this.clock);
      insertTaskRelations(this.database, input);
      insertBuildEvent(
        this.database,
        {
          buildId: input.buildId,
          taskId: input.id,
          type: "task.created",
          payload: { state: input.state ?? "pending" },
        },
        this.clock,
      );
      return this.getById(input.id);
    });
  }

  getById(id: string): TaskEntity {
    const row = this.database
      .prepare<[string], TaskRow>(`${TASK_SELECT} WHERE id = ?`)
      .get(id);
    return mapTask(requireEntity("task", id, row));
  }

  findById(id: string): TaskEntity | undefined {
    const row = this.database
      .prepare<[string], TaskRow>(`${TASK_SELECT} WHERE id = ?`)
      .get(id);
    return row === undefined ? undefined : mapTask(row);
  }

  listForBuild(buildId: string): TaskEntity[] {
    return this.database
      .prepare<[string], TaskRow>(
        `${TASK_SELECT}
         WHERE build_id = ?
         ORDER BY created_at, backlog_task_id`,
      )
      .all(buildId)
      .map(mapTask);
  }

  listDependencies(taskId: string): TaskDependencyEntity[] {
    return this.database
      .prepare<[string], TaskDependencyRow>(
        `SELECT
           task_id, dependency_task_id, dependency_type,
           required_artifact_name, required_artifact_version
         FROM task_dependencies
         WHERE task_id = ?
         ORDER BY dependency_task_id, dependency_type`,
      )
      .all(taskId)
      .map(mapDependency);
  }

  listOwnedPaths(taskId: string): string[] {
    return this.database
      .prepare<[string], { owned_path: string }>(
        `SELECT owned_path
         FROM task_ownership
         WHERE task_id = ?
         ORDER BY owned_path`,
      )
      .all(taskId)
      .map(({ owned_path }) => owned_path);
  }

  listValidationCommands(taskId: string): TaskValidationCommandEntity[] {
    return this.database
      .prepare<[string], ValidationCommandRow>(
        `SELECT task_id, command_order, command
         FROM task_validation_commands
         WHERE task_id = ?
         ORDER BY command_order`,
      )
      .all(taskId)
      .map(mapValidationCommand);
  }

  setExecutionContext(
    id: string,
    input: {
      branchName: string;
      worktreePath: string;
      baseCommit: string;
    },
  ): TaskEntity {
    return inImmediateTransaction(this.database, () => {
      const task = this.getById(id);
      if (
        task.branchName !== null &&
        (task.branchName !== input.branchName ||
          task.worktreePath !== input.worktreePath ||
          task.baseCommit !== input.baseCommit)
      ) {
        throw new Error(`Task ${id} already has a different execution context`);
      }
      if (
        !["ready", "running", "interrupted"].includes(task.state)
      ) {
        throw new Error(
          `Task ${id} cannot receive an execution context from ${task.state}`,
        );
      }
      this.database
        .prepare<{
          id: string;
          branchName: string;
          worktreePath: string;
          baseCommit: string;
        }>(
          `UPDATE tasks
           SET branch_name = @branchName,
               worktree_path = @worktreePath,
               base_commit = @baseCommit
           WHERE id = @id`,
        )
        .run({ id, ...input });
      insertBuildEvent(
        this.database,
        {
          buildId: task.buildId,
          taskId: id,
          type: "task.execution_context_recorded",
          payload: input,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  setRanking(
    id: string,
    rankingScore: number,
    rankingExplanation: string,
  ): TaskEntity {
    if (!Number.isFinite(rankingScore)) {
      throw new RangeError("Task ranking score must be finite");
    }
    const result = this.database
      .prepare<{
        id: string;
        rankingScore: number;
        rankingExplanation: string;
      }>(
        `UPDATE tasks
         SET ranking_score = @rankingScore,
             ranking_explanation = @rankingExplanation
         WHERE id = @id`,
      )
      .run({ id, rankingScore, rankingExplanation });
    if (result.changes !== 1) {
      requireEntity("task", id, undefined);
    }
    return this.getById(id);
  }

  transition(
    id: string,
    to: TaskStatus,
    options: TaskTransitionOptions = {},
  ): TaskEntity {
    return inImmediateTransaction(this.database, () => {
      const task = this.getById(id);
      if (!canTransitionTask(task.state, to)) {
        throw new InvalidStateTransitionError("task", id, task.state, to);
      }
      const occurredAt = options.occurredAt ?? this.clock();
      const startedAt =
        to === "running" && task.startedAt === null ? occurredAt : task.startedAt;
      const completedAt = [
        "integrated",
        "failed",
        "cancelled",
        "blocked_failed",
      ].includes(to)
        ? occurredAt
        : null;

      const result = this.database
        .prepare<{
          id: string;
          expectedState: TaskStatus;
          state: TaskStatus;
          startedAt: string | null;
          completedAt: string | null;
          errorCode: string | null;
          errorMessage: string | null;
          resultCommit: string | null;
          integrationCommit: string | null;
        }>(
          `UPDATE tasks
           SET state = @state,
               started_at = @startedAt,
               completed_at = @completedAt,
               error_code = @errorCode,
               error_message = @errorMessage,
               result_commit = @resultCommit,
               integration_commit = @integrationCommit
           WHERE id = @id AND state = @expectedState`,
        )
        .run({
          id,
          expectedState: task.state,
          state: to,
          startedAt,
          completedAt,
          errorCode:
            options.errorCode === undefined ? task.errorCode : options.errorCode,
          errorMessage:
            options.errorMessage === undefined
              ? task.errorMessage
              : options.errorMessage,
          resultCommit:
            options.resultCommit === undefined
              ? task.resultCommit
              : options.resultCommit,
          integrationCommit:
            options.integrationCommit === undefined
              ? task.integrationCommit
              : options.integrationCommit,
        });
      if (result.changes !== 1) {
        throw new ConcurrentStateChangeError("task", id);
      }

      insertBuildEvent(
        this.database,
        {
          buildId: task.buildId,
          taskId: id,
          type: options.eventType ?? "task.state_changed",
          payload: {
            from: task.state,
            to,
            ...(options.payload ?? {}),
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  retry(id: string, options: RetryTaskOptions = {}): TaskEntity {
    return inImmediateTransaction(this.database, () => {
      const task = this.getById(id);
      if (!canTransitionTask(task.state, "ready")) {
        throw new InvalidStateTransitionError("task", id, task.state, "ready");
      }
      const attempt = task.attempt + 1;
      const occurredAt = options.occurredAt ?? this.clock();
      this.database
        .prepare<{
          id: string;
          expectedState: TaskStatus;
          attempt: number;
        }>(
          `UPDATE tasks
           SET state = 'ready',
               attempt = @attempt,
               result_commit = NULL,
               integration_commit = NULL,
               started_at = NULL,
               completed_at = NULL,
               error_code = NULL,
               error_message = NULL
           WHERE id = @id AND state = @expectedState`,
        )
        .run({ id, expectedState: task.state, attempt });

      this.insertAttempt({
        id: options.attemptId ?? createId("attempt"),
        taskId: id,
        buildId: task.buildId,
        attempt,
        status: "queued",
        createdAt: occurredAt,
      });
      insertBuildEvent(
        this.database,
        {
          buildId: task.buildId,
          taskId: id,
          type: "task.retried",
          payload: { from: task.state, to: "ready", attempt },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  markIntegrationSuccess(
    id: string,
    input: IntegrationSuccessInput,
  ): TaskEntity {
    return inImmediateTransaction(this.database, () => {
      const task = this.getById(id);
      if (task.state !== "integrating") {
        throw new InvalidStateTransitionError(
          "task",
          id,
          task.state,
          "integrated",
        );
      }
      const occurredAt = input.occurredAt ?? this.clock();
      this.database
        .prepare<{
          id: string;
          integrationCommit: string;
          completedAt: string;
        }>(
          `UPDATE tasks
           SET state = 'integrated',
               integration_commit = @integrationCommit,
               completed_at = @completedAt,
               error_code = NULL,
               error_message = NULL
           WHERE id = @id AND state = 'integrating'`,
        )
        .run({
          id,
          integrationCommit: input.integrationCommit,
          completedAt: occurredAt,
        });
      this.database
        .prepare<{ taskId: string; integratedAt: string }>(
          `UPDATE artifacts
           SET status = 'integrated', integrated_at = @integratedAt
           WHERE producer_task_id = @taskId
             AND status IN ('produced','validated')`,
        )
        .run({ taskId: id, integratedAt: occurredAt });
      insertBuildEvent(
        this.database,
        {
          buildId: task.buildId,
          taskId: id,
          type: "task.integration_succeeded",
          payload: {
            from: task.state,
            to: "integrated",
            integrationCommit: input.integrationCommit,
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  markIntegrationFailure(
    id: string,
    input: IntegrationFailureInput,
  ): TaskEntity {
    return inImmediateTransaction(this.database, () => {
      const task = this.getById(id);
      if (task.state !== "integrating") {
        throw new InvalidStateTransitionError(
          "task",
          id,
          task.state,
          "failed",
        );
      }
      const occurredAt = input.occurredAt ?? this.clock();
      this.database
        .prepare<{
          id: string;
          errorCode: string;
          errorMessage: string;
          completedAt: string;
        }>(
          `UPDATE tasks
           SET state = 'failed',
               error_code = @errorCode,
               error_message = @errorMessage,
               completed_at = @completedAt
           WHERE id = @id AND state = 'integrating'`,
        )
        .run({
          id,
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          completedAt: occurredAt,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: task.buildId,
          taskId: id,
          type: "task.integration_failed",
          payload: {
            from: task.state,
            to: "failed",
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  createAttempt(input: CreateTaskAttemptInput): TaskAttemptEntity {
    return inImmediateTransaction(this.database, () => {
      const occurredAt = input.createdAt ?? this.clock();
      this.insertAttempt({ ...input, createdAt: occurredAt });
      insertBuildEvent(
        this.database,
        {
          buildId: input.buildId,
          taskId: input.taskId,
          type: "task.attempt_created",
          payload: { attempt: input.attempt, status: input.status ?? "queued" },
          occurredAt,
        },
        this.clock,
      );
      return this.getAttempt(input.taskId, input.attempt);
    });
  }

  getAttempt(taskId: string, attempt: number): TaskAttemptEntity {
    const row = this.database
      .prepare<[string, number], TaskAttemptRow>(
        `${ATTEMPT_SELECT} WHERE task_id = ? AND attempt = ?`,
      )
      .get(taskId, attempt);
    return mapAttempt(
      requireEntity("task attempt", `${taskId}:${attempt}`, row),
    );
  }

  listAttempts(taskId: string): TaskAttemptEntity[] {
    return this.database
      .prepare<[string], TaskAttemptRow>(
        `${ATTEMPT_SELECT}
         WHERE task_id = ?
         ORDER BY attempt`,
      )
      .all(taskId)
      .map(mapAttempt);
  }

  updateAttempt(
    taskId: string,
    attempt: number,
    input: {
      status: AttemptStatus;
      workerId?: string | null;
      promptPath?: string | null;
      jsonlPath?: string | null;
      logPath?: string | null;
      resultCommit?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
    },
  ): TaskAttemptEntity {
    const current = this.getAttempt(taskId, attempt);
    this.database
      .prepare<{
        taskId: string;
        attempt: number;
        status: AttemptStatus;
        workerId: string | null;
        promptPath: string | null;
        jsonlPath: string | null;
        logPath: string | null;
        resultCommit: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        startedAt: string | null;
        completedAt: string | null;
      }>(
        `UPDATE task_attempts
         SET status = @status,
             worker_id = @workerId,
             prompt_path = @promptPath,
             jsonl_path = @jsonlPath,
             log_path = @logPath,
             result_commit = @resultCommit,
             error_code = @errorCode,
             error_message = @errorMessage,
             started_at = @startedAt,
             completed_at = @completedAt
         WHERE task_id = @taskId AND attempt = @attempt`,
      )
      .run({
        taskId,
        attempt,
        status: input.status,
        workerId:
          input.workerId === undefined ? current.workerId : input.workerId,
        promptPath:
          input.promptPath === undefined ? current.promptPath : input.promptPath,
        jsonlPath:
          input.jsonlPath === undefined ? current.jsonlPath : input.jsonlPath,
        logPath:
          input.logPath === undefined ? current.logPath : input.logPath,
        resultCommit:
          input.resultCommit === undefined
            ? current.resultCommit
            : input.resultCommit,
        errorCode:
          input.errorCode === undefined ? current.errorCode : input.errorCode,
        errorMessage:
          input.errorMessage === undefined
            ? current.errorMessage
            : input.errorMessage,
        startedAt:
          input.startedAt === undefined ? current.startedAt : input.startedAt,
        completedAt:
          input.completedAt === undefined
            ? current.completedAt
            : input.completedAt,
      });
    return this.getAttempt(taskId, attempt);
  }

  recordChangedFiles(
    taskId: string,
    attempt: number,
    files: readonly RecordChangedFileInput[],
  ): ChangedFileEntity[] {
    return inImmediateTransaction(this.database, () => {
      this.getAttempt(taskId, attempt);
      const statement = this.database.prepare<{
        taskId: string;
        attempt: number;
        path: string;
        changeType: FileChangeType;
        previousPath: string | null;
        withinOwnership: number;
        sha256: string | null;
      }>(
        `INSERT INTO task_changed_files (
           task_id, attempt, path, change_type, previous_path,
           within_ownership, sha256
         ) VALUES (
           @taskId, @attempt, @path, @changeType, @previousPath,
           @withinOwnership, @sha256
         )`,
      );
      for (const file of files) {
        statement.run({
          taskId,
          attempt,
          path: file.path,
          changeType: file.changeType,
          previousPath: file.previousPath ?? null,
          withinOwnership: file.withinOwnership ? 1 : 0,
          sha256: file.sha256 ?? null,
        });
      }
      return this.listChangedFiles(taskId, attempt);
    });
  }

  listChangedFiles(taskId: string, attempt: number): ChangedFileEntity[] {
    return this.database
      .prepare<[string, number], ChangedFileRow>(
        `SELECT
           task_id, attempt, path, change_type, previous_path,
           within_ownership, sha256
         FROM task_changed_files
         WHERE task_id = ? AND attempt = ?
         ORDER BY path`,
      )
      .all(taskId, attempt)
      .map(mapChangedFile);
  }

  private insertAttempt(input: CreateTaskAttemptInput): void {
    this.database
      .prepare<{
        id: string;
        taskId: string;
        buildId: string;
        attempt: number;
        workerId: string | null;
        status: AttemptStatus;
        promptPath: string | null;
        jsonlPath: string | null;
        logPath: string | null;
        resultCommit: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        startedAt: string | null;
        completedAt: string | null;
        createdAt: string;
      }>(
        `INSERT INTO task_attempts (
           id, task_id, build_id, attempt, worker_id, status, prompt_path,
           jsonl_path, log_path, result_commit, error_code, error_message,
           started_at, completed_at, created_at
         ) VALUES (
           @id, @taskId, @buildId, @attempt, @workerId, @status, @promptPath,
           @jsonlPath, @logPath, @resultCommit, @errorCode, @errorMessage,
           @startedAt, @completedAt, @createdAt
         )`,
      )
      .run({
        id: input.id,
        taskId: input.taskId,
        buildId: input.buildId,
        attempt: input.attempt,
        workerId: input.workerId ?? null,
        status: input.status ?? "queued",
        promptPath: input.promptPath ?? null,
        jsonlPath: input.jsonlPath ?? null,
        logPath: input.logPath ?? null,
        resultCommit: input.resultCommit ?? null,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        createdAt: input.createdAt ?? this.clock(),
      });
  }
}
