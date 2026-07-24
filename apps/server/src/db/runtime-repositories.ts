import type Database from "better-sqlite3";
import { createId } from "../util/ids.js";
import {
  decodeJson,
  encodeJson,
  inImmediateTransaction,
  insertBuildEvent,
  requireEntity,
  systemClock,
  type Clock,
} from "./shared.js";
import { TaskRepository } from "./task-repository.js";
import type {
  ApprovalEntity,
  ApprovalStatus,
  ArtifactEntity,
  ArtifactStatus,
  CreateApprovalInput,
  CreateValidationRunInput,
  CreateWorkerInput,
  PublishArtifactInput,
  ValidationRunEntity,
  ValidationStatus,
  ValidationType,
  WorkerEntity,
  WorkerStatus,
} from "./types.js";

interface WorkerRow {
  id: string;
  build_id: string;
  task_id: string | null;
  process_id: number | null;
  status: WorkerStatus;
  started_at: string | null;
  heartbeat_at: string | null;
  stopped_at: string | null;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  build_id: string;
  producer_task_id: string;
  name: string;
  artifact_type: string;
  version: string;
  repository_path: string | null;
  storage_path: string | null;
  sha256: string | null;
  status: ArtifactStatus;
  metadata_json: string;
  created_at: string;
  integrated_at: string | null;
}

interface ValidationRunRow {
  id: string;
  build_id: string;
  task_id: string | null;
  validation_type: ValidationType;
  command: string;
  exit_code: number | null;
  status: ValidationStatus;
  log_path: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  build_id: string;
  task_id: string | null;
  approval_type: ApprovalEntity["approvalType"];
  status: ApprovalStatus;
  reason: string;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

function mapWorker(row: WorkerRow): WorkerEntity {
  return {
    id: row.id,
    buildId: row.build_id,
    taskId: row.task_id,
    processId: row.process_id,
    status: row.status,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    stoppedAt: row.stopped_at,
    createdAt: row.created_at,
  };
}

function mapArtifact(row: ArtifactRow): ArtifactEntity {
  return {
    id: row.id,
    buildId: row.build_id,
    producerTaskId: row.producer_task_id,
    name: row.name,
    artifactType: row.artifact_type,
    version: row.version,
    repositoryPath: row.repository_path,
    storagePath: row.storage_path,
    sha256: row.sha256,
    status: row.status,
    metadata: decodeJson<Record<string, unknown>>(
      row.metadata_json,
      "artifacts.metadata_json",
    ),
    createdAt: row.created_at,
    integratedAt: row.integrated_at,
  };
}

function mapValidationRun(row: ValidationRunRow): ValidationRunEntity {
  return {
    id: row.id,
    buildId: row.build_id,
    taskId: row.task_id,
    validationType: row.validation_type,
    command: row.command,
    exitCode: row.exit_code,
    status: row.status,
    logPath: row.log_path,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function mapApproval(row: ApprovalRow): ApprovalEntity {
  return {
    id: row.id,
    buildId: row.build_id,
    taskId: row.task_id,
    approvalType: row.approval_type,
    status: row.status,
    reason: row.reason,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
  };
}

const WORKER_SELECT = `
  SELECT
    id, build_id, task_id, process_id, status, started_at, heartbeat_at,
    stopped_at, created_at
  FROM workers
`;

const ARTIFACT_SELECT = `
  SELECT
    id, build_id, producer_task_id, name, artifact_type, version,
    repository_path, storage_path, sha256, status, metadata_json, created_at,
    integrated_at
  FROM artifacts
`;

const VALIDATION_SELECT = `
  SELECT
    id, build_id, task_id, validation_type, command, exit_code, status,
    log_path, started_at, completed_at, created_at
  FROM validation_runs
`;

const APPROVAL_SELECT = `
  SELECT
    id, build_id, task_id, approval_type, status, reason, requested_at,
    decided_at, decided_by, decision_note
  FROM approvals
`;

export interface AssignWorkerInput {
  workerId: string;
  taskId: string;
  processId?: number | null;
  attemptId?: string;
  occurredAt?: string;
}

export class WorkerRepository {
  private readonly tasks: TaskRepository;

  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {
    this.tasks = new TaskRepository(database, clock);
  }

  create(input: CreateWorkerInput): WorkerEntity {
    const createdAt = input.createdAt ?? this.clock();
    return inImmediateTransaction(this.database, () => {
      this.database
        .prepare<{
          id: string;
          buildId: string;
          taskId: string | null;
          processId: number | null;
          status: WorkerStatus;
          startedAt: string | null;
          heartbeatAt: string | null;
          stoppedAt: string | null;
          createdAt: string;
        }>(
          `INSERT INTO workers (
             id, build_id, task_id, process_id, status, started_at,
             heartbeat_at, stopped_at, created_at
           ) VALUES (
             @id, @buildId, @taskId, @processId, @status, @startedAt,
             @heartbeatAt, @stoppedAt, @createdAt
           )`,
        )
        .run({
          id: input.id,
          buildId: input.buildId,
          taskId: input.taskId ?? null,
          processId: input.processId ?? null,
          status: input.status ?? "idle",
          startedAt: input.startedAt ?? null,
          heartbeatAt: input.heartbeatAt ?? null,
          stoppedAt: input.stoppedAt ?? null,
          createdAt,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: input.buildId,
          taskId: input.taskId ?? null,
          type: "worker.created",
          payload: { workerId: input.id, status: input.status ?? "idle" },
          occurredAt: createdAt,
        },
        this.clock,
      );
      return this.getById(input.id);
    });
  }

  getById(id: string): WorkerEntity {
    const row = this.database
      .prepare<[string], WorkerRow>(`${WORKER_SELECT} WHERE id = ?`)
      .get(id);
    return mapWorker(requireEntity("worker", id, row));
  }

  listForBuild(buildId: string): WorkerEntity[] {
    return this.database
      .prepare<[string], WorkerRow>(
        `${WORKER_SELECT}
         WHERE build_id = ?
         ORDER BY created_at, id`,
      )
      .all(buildId)
      .map(mapWorker);
  }

  assign(input: AssignWorkerInput): WorkerEntity {
    return inImmediateTransaction(this.database, () => {
      const worker = this.getById(input.workerId);
      const task = this.tasks.getById(input.taskId);
      if (worker.buildId !== task.buildId) {
        throw new Error("Worker and task must belong to the same build");
      }
      if (worker.status !== "idle" || worker.taskId !== null) {
        throw new Error(`Worker ${worker.id} is not idle`);
      }
      if (task.state !== "ready") {
        throw new Error(`Task ${task.id} is not ready`);
      }

      const occurredAt = input.occurredAt ?? this.clock();
      const attempt = task.attempt === 0 ? 1 : task.attempt;
      const existingAttempt = this.database
        .prepare<[string, number], { id: string; status: string }>(
          `SELECT id, status
           FROM task_attempts
           WHERE task_id = ? AND attempt = ?`,
        )
        .get(task.id, attempt);
      if (existingAttempt === undefined) {
        this.database
          .prepare<{
            id: string;
            taskId: string;
            buildId: string;
            attempt: number;
            workerId: string;
            startedAt: string;
            createdAt: string;
          }>(
            `INSERT INTO task_attempts (
               id, task_id, build_id, attempt, worker_id, status, started_at,
               created_at
             ) VALUES (
               @id, @taskId, @buildId, @attempt, @workerId, 'running',
               @startedAt, @createdAt
             )`,
          )
          .run({
            id: input.attemptId ?? createId("attempt"),
            taskId: task.id,
            buildId: task.buildId,
            attempt,
            workerId: worker.id,
            startedAt: occurredAt,
            createdAt: occurredAt,
          });
      } else {
        if (existingAttempt.status !== "queued") {
          throw new Error(
            `Task ${task.id} attempt ${attempt} is not queued`,
          );
        }
        const attemptUpdate = this.database
          .prepare<{
            taskId: string;
            attempt: number;
            workerId: string;
            startedAt: string;
          }>(
            `UPDATE task_attempts
             SET worker_id = @workerId,
                 status = 'running',
                 started_at = @startedAt
             WHERE task_id = @taskId
               AND attempt = @attempt
               AND status = 'queued'`,
          )
          .run({
            taskId: task.id,
            attempt,
            workerId: worker.id,
            startedAt: occurredAt,
          });
        if (attemptUpdate.changes !== 1) {
          throw new Error(
            `Task ${task.id} attempt ${attempt} changed concurrently`,
          );
        }
      }

      const workerUpdate = this.database
        .prepare<{
          id: string;
          taskId: string;
          processId: number | null;
          startedAt: string;
        }>(
          `UPDATE workers
           SET task_id = @taskId,
               process_id = @processId,
               status = 'running',
               started_at = @startedAt,
               heartbeat_at = @startedAt,
               stopped_at = NULL
           WHERE id = @id AND status = 'idle' AND task_id IS NULL`,
        )
        .run({
          id: worker.id,
          taskId: task.id,
          processId: input.processId ?? null,
          startedAt: occurredAt,
        });
      if (workerUpdate.changes !== 1) {
        throw new Error(`Worker ${worker.id} changed concurrently`);
      }
      const taskUpdate = this.database
        .prepare<{
          id: string;
          attempt: number;
          startedAt: string;
        }>(
          `UPDATE tasks
           SET state = 'running',
               attempt = @attempt,
               started_at = @startedAt,
               completed_at = NULL,
               error_code = NULL,
               error_message = NULL
           WHERE id = @id AND state = 'ready'`,
        )
        .run({ id: task.id, attempt, startedAt: occurredAt });
      if (taskUpdate.changes !== 1) {
        throw new Error(`Task ${task.id} changed concurrently`);
      }

      insertBuildEvent(
        this.database,
        {
          buildId: task.buildId,
          taskId: task.id,
          type: "task.state_changed",
          payload: {
            from: task.state,
            to: "running",
            attempt,
            workerId: worker.id,
          },
          occurredAt,
        },
        this.clock,
      );
      insertBuildEvent(
        this.database,
        {
          buildId: task.buildId,
          taskId: task.id,
          type: "worker.assigned",
          payload: {
            workerId: worker.id,
            processId: input.processId ?? null,
            attempt,
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(worker.id);
    });
  }

  heartbeat(id: string, heartbeatAt = this.clock()): WorkerEntity {
    const result = this.database
      .prepare<{ id: string; heartbeatAt: string }>(
        `UPDATE workers
         SET heartbeat_at = @heartbeatAt
         WHERE id = @id AND status = 'running'`,
      )
      .run({ id, heartbeatAt });
    if (result.changes !== 1) {
      throw new Error(`Worker ${id} is not running`);
    }
    return this.getById(id);
  }

  updateProcessId(id: string, processId: number): WorkerEntity {
    const result = this.database
      .prepare<{ id: string; processId: number }>(
        `UPDATE workers
         SET process_id = @processId
         WHERE id = @id AND status = 'running'`,
      )
      .run({ id, processId });
    if (result.changes !== 1) {
      throw new Error(`Worker ${id} is not running`);
    }
    return this.getById(id);
  }

  release(
    id: string,
    status: Extract<WorkerStatus, "stopped" | "failed"> = "stopped",
    occurredAt = this.clock(),
  ): WorkerEntity {
    return inImmediateTransaction(this.database, () => {
      const worker = this.getById(id);
      this.database
        .prepare<{
          id: string;
          status: WorkerStatus;
          stoppedAt: string;
        }>(
          `UPDATE workers
           SET status = @status,
               stopped_at = @stoppedAt,
               heartbeat_at = @stoppedAt
           WHERE id = @id`,
        )
        .run({ id, status, stoppedAt: occurredAt });
      insertBuildEvent(
        this.database,
        {
          buildId: worker.buildId,
          taskId: worker.taskId,
          type: status === "failed" ? "worker.failed" : "worker.stopped",
          payload: { workerId: id, from: worker.status, to: status },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  recycle(id: string, occurredAt = this.clock()): WorkerEntity {
    return inImmediateTransaction(this.database, () => {
      const worker = this.getById(id);
      if (!["stopped", "failed"].includes(worker.status)) {
        throw new Error(`Worker ${id} must be stopped before it is recycled`);
      }
      this.database
        .prepare<{ id: string; occurredAt: string }>(
          `UPDATE workers
           SET task_id = NULL,
               process_id = NULL,
               status = 'idle',
               started_at = NULL,
               heartbeat_at = @occurredAt,
               stopped_at = NULL
           WHERE id = @id AND status IN ('stopped','failed')`,
        )
        .run({ id, occurredAt });
      insertBuildEvent(
        this.database,
        {
          buildId: worker.buildId,
          taskId: worker.taskId,
          type: "worker.recycled",
          payload: { workerId: id, from: worker.status, to: "idle" },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }
}

export class ArtifactRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  publish(input: PublishArtifactInput): ArtifactEntity {
    const createdAt = input.createdAt ?? this.clock();
    return inImmediateTransaction(this.database, () => {
      this.database
        .prepare<{
          id: string;
          buildId: string;
          producerTaskId: string;
          name: string;
          artifactType: string;
          version: string;
          repositoryPath: string | null;
          storagePath: string | null;
          sha256: string | null;
          status: ArtifactStatus;
          metadataJson: string;
          createdAt: string;
          integratedAt: string | null;
        }>(
          `INSERT INTO artifacts (
             id, build_id, producer_task_id, name, artifact_type, version,
             repository_path, storage_path, sha256, status, metadata_json,
             created_at, integrated_at
           ) VALUES (
             @id, @buildId, @producerTaskId, @name, @artifactType, @version,
             @repositoryPath, @storagePath, @sha256, @status, @metadataJson,
             @createdAt, @integratedAt
           )`,
        )
        .run({
          id: input.id,
          buildId: input.buildId,
          producerTaskId: input.producerTaskId,
          name: input.name,
          artifactType: input.artifactType,
          version: input.version,
          repositoryPath: input.repositoryPath ?? null,
          storagePath: input.storagePath ?? null,
          sha256: input.sha256 ?? null,
          status: input.status ?? "produced",
          metadataJson: encodeJson(input.metadata ?? {}),
          createdAt,
          integratedAt: input.integratedAt ?? null,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: input.buildId,
          taskId: input.producerTaskId,
          type: "artifact.published",
          payload: {
            artifactId: input.id,
            name: input.name,
            version: input.version,
            status: input.status ?? "produced",
          },
          occurredAt: createdAt,
        },
        this.clock,
      );
      return this.getById(input.id);
    });
  }

  getById(id: string): ArtifactEntity {
    const row = this.database
      .prepare<[string], ArtifactRow>(`${ARTIFACT_SELECT} WHERE id = ?`)
      .get(id);
    return mapArtifact(requireEntity("artifact", id, row));
  }

  listForBuild(buildId: string): ArtifactEntity[] {
    return this.database
      .prepare<[string], ArtifactRow>(
        `${ARTIFACT_SELECT}
         WHERE build_id = ?
         ORDER BY created_at, name, version`,
      )
      .all(buildId)
      .map(mapArtifact);
  }

  findExact(
    buildId: string,
    name: string,
    version: string,
  ): ArtifactEntity | undefined {
    const row = this.database
      .prepare<[string, string, string], ArtifactRow>(
        `${ARTIFACT_SELECT}
         WHERE build_id = ? AND name = ? AND version = ?`,
      )
      .get(buildId, name, version);
    return row === undefined ? undefined : mapArtifact(row);
  }

  setStatus(
    id: string,
    status: ArtifactStatus,
    occurredAt = this.clock(),
  ): ArtifactEntity {
    return inImmediateTransaction(this.database, () => {
      const artifact = this.getById(id);
      this.database
        .prepare<{
          id: string;
          status: ArtifactStatus;
          integratedAt: string | null;
        }>(
          `UPDATE artifacts
           SET status = @status, integrated_at = @integratedAt
           WHERE id = @id`,
        )
        .run({
          id,
          status,
          integratedAt:
            status === "integrated" ? occurredAt : artifact.integratedAt,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: artifact.buildId,
          taskId: artifact.producerTaskId,
          type: "artifact.status_changed",
          payload: {
            artifactId: id,
            from: artifact.status,
            to: status,
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }

  replaceValidated(
    id: string,
    input: {
      artifactType: string;
      repositoryPath: string | null;
      storagePath: string | null;
      sha256: string | null;
      metadata: Record<string, unknown>;
    },
    occurredAt = this.clock(),
  ): ArtifactEntity {
    return inImmediateTransaction(this.database, () => {
      const artifact = this.getById(id);
      if (artifact.status === "integrated") {
        throw new Error(`Integrated artifact ${id} is immutable`);
      }
      this.database
        .prepare<{
          id: string;
          artifactType: string;
          repositoryPath: string | null;
          storagePath: string | null;
          sha256: string | null;
          metadataJson: string;
          occurredAt: string;
        }>(
          `UPDATE artifacts
           SET artifact_type = @artifactType,
               repository_path = @repositoryPath,
               storage_path = @storagePath,
               sha256 = @sha256,
               status = 'validated',
               metadata_json = @metadataJson,
               created_at = @occurredAt,
               integrated_at = NULL
           WHERE id = @id AND status IN ('produced','validated','invalidated')`,
        )
        .run({
          id,
          artifactType: input.artifactType,
          repositoryPath: input.repositoryPath,
          storagePath: input.storagePath,
          sha256: input.sha256,
          metadataJson: encodeJson(input.metadata),
          occurredAt,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: artifact.buildId,
          taskId: artifact.producerTaskId,
          type: "artifact.republished",
          payload: {
            artifactId: id,
            name: artifact.name,
            version: artifact.version,
            previousSha256: artifact.sha256,
            sha256: input.sha256,
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }
}

export class ValidationRunRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateValidationRunInput): ValidationRunEntity {
    const createdAt = input.createdAt ?? this.clock();
    this.database
      .prepare<{
        id: string;
        buildId: string;
        taskId: string | null;
        validationType: ValidationType;
        command: string;
        exitCode: number | null;
        status: ValidationStatus;
        logPath: string | null;
        startedAt: string | null;
        completedAt: string | null;
        createdAt: string;
      }>(
        `INSERT INTO validation_runs (
           id, build_id, task_id, validation_type, command, exit_code, status,
           log_path, started_at, completed_at, created_at
         ) VALUES (
           @id, @buildId, @taskId, @validationType, @command, @exitCode,
           @status, @logPath, @startedAt, @completedAt, @createdAt
         )`,
      )
      .run({
        id: input.id,
        buildId: input.buildId,
        taskId: input.taskId ?? null,
        validationType: input.validationType,
        command: input.command,
        exitCode: input.exitCode ?? null,
        status: input.status ?? "queued",
        logPath: input.logPath ?? null,
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        createdAt,
      });
    return this.getById(input.id);
  }

  getById(id: string): ValidationRunEntity {
    const row = this.database
      .prepare<[string], ValidationRunRow>(`${VALIDATION_SELECT} WHERE id = ?`)
      .get(id);
    return mapValidationRun(requireEntity("validation run", id, row));
  }

  listForBuild(buildId: string): ValidationRunEntity[] {
    return this.database
      .prepare<[string], ValidationRunRow>(
        `${VALIDATION_SELECT}
         WHERE build_id = ?
         ORDER BY created_at, id`,
      )
      .all(buildId)
      .map(mapValidationRun);
  }

  setStatus(
    id: string,
    status: ValidationStatus,
    input: {
      exitCode?: number | null;
      logPath?: string | null;
      occurredAt?: string;
    } = {},
  ): ValidationRunEntity {
    return inImmediateTransaction(this.database, () => {
      const current = this.getById(id);
      const occurredAt = input.occurredAt ?? this.clock();
      const startedAt =
        status === "running" && current.startedAt === null
          ? occurredAt
          : current.startedAt;
      const completedAt = [
        "passed",
        "failed",
        "cancelled",
        "timed_out",
      ].includes(status)
        ? occurredAt
        : null;
      this.database
        .prepare<{
          id: string;
          status: ValidationStatus;
          exitCode: number | null;
          logPath: string | null;
          startedAt: string | null;
          completedAt: string | null;
        }>(
          `UPDATE validation_runs
           SET status = @status,
               exit_code = @exitCode,
               log_path = @logPath,
               started_at = @startedAt,
               completed_at = @completedAt
           WHERE id = @id`,
        )
        .run({
          id,
          status,
          exitCode:
            input.exitCode === undefined ? current.exitCode : input.exitCode,
          logPath: input.logPath === undefined ? current.logPath : input.logPath,
          startedAt,
          completedAt,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: current.buildId,
          taskId: current.taskId,
          type: "validation.status_changed",
          payload: {
            validationRunId: id,
            from: current.status,
            to: status,
            exitCode:
              input.exitCode === undefined
                ? current.exitCode
                : input.exitCode,
          },
          occurredAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }
}

export class ApprovalRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateApprovalInput): ApprovalEntity {
    const requestedAt = input.requestedAt ?? this.clock();
    return inImmediateTransaction(this.database, () => {
      this.database
        .prepare<{
          id: string;
          buildId: string;
          taskId: string | null;
          approvalType: ApprovalEntity["approvalType"];
          status: ApprovalStatus;
          reason: string;
          requestedAt: string;
          decidedAt: string | null;
          decidedBy: string | null;
          decisionNote: string | null;
        }>(
          `INSERT INTO approvals (
             id, build_id, task_id, approval_type, status, reason,
             requested_at, decided_at, decided_by, decision_note
           ) VALUES (
             @id, @buildId, @taskId, @approvalType, @status, @reason,
             @requestedAt, @decidedAt, @decidedBy, @decisionNote
           )`,
        )
        .run({
          id: input.id,
          buildId: input.buildId,
          taskId: input.taskId ?? null,
          approvalType: input.approvalType,
          status: input.status ?? "pending",
          reason: input.reason,
          requestedAt,
          decidedAt: input.decidedAt ?? null,
          decidedBy: input.decidedBy ?? null,
          decisionNote: input.decisionNote ?? null,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: input.buildId,
          taskId: input.taskId ?? null,
          type: "approval.requested",
          payload: {
            approvalId: input.id,
            approvalType: input.approvalType,
            reason: input.reason,
          },
          occurredAt: requestedAt,
        },
        this.clock,
      );
      return this.getById(input.id);
    });
  }

  getById(id: string): ApprovalEntity {
    const row = this.database
      .prepare<[string], ApprovalRow>(`${APPROVAL_SELECT} WHERE id = ?`)
      .get(id);
    return mapApproval(requireEntity("approval", id, row));
  }

  listPending(buildId: string, taskId?: string): ApprovalEntity[] {
    if (taskId === undefined) {
      return this.database
        .prepare<[string], ApprovalRow>(
          `${APPROVAL_SELECT}
           WHERE build_id = ? AND status = 'pending'
           ORDER BY requested_at, id`,
        )
        .all(buildId)
        .map(mapApproval);
    }
    return this.database
      .prepare<[string, string], ApprovalRow>(
        `${APPROVAL_SELECT}
         WHERE build_id = ? AND task_id = ? AND status = 'pending'
         ORDER BY requested_at, id`,
      )
      .all(buildId, taskId)
      .map(mapApproval);
  }

  listForBuild(buildId: string): ApprovalEntity[] {
    return this.database
      .prepare<[string], ApprovalRow>(
        `${APPROVAL_SELECT}
         WHERE build_id = ?
         ORDER BY requested_at, id`,
      )
      .all(buildId)
      .map(mapApproval);
  }

  decide(
    id: string,
    status: Extract<ApprovalStatus, "approved" | "rejected" | "cancelled">,
    input: {
      decidedBy?: string | null;
      decisionNote?: string | null;
      decidedAt?: string;
    } = {},
  ): ApprovalEntity {
    return inImmediateTransaction(this.database, () => {
      const approval = this.getById(id);
      if (approval.status !== "pending") {
        throw new Error(`Approval ${id} has already been decided`);
      }
      const decidedAt = input.decidedAt ?? this.clock();
      this.database
        .prepare<{
          id: string;
          status: ApprovalStatus;
          decidedAt: string;
          decidedBy: string | null;
          decisionNote: string | null;
        }>(
          `UPDATE approvals
           SET status = @status,
               decided_at = @decidedAt,
               decided_by = @decidedBy,
               decision_note = @decisionNote
           WHERE id = @id AND status = 'pending'`,
        )
        .run({
          id,
          status,
          decidedAt,
          decidedBy: input.decidedBy ?? null,
          decisionNote: input.decisionNote ?? null,
        });
      insertBuildEvent(
        this.database,
        {
          buildId: approval.buildId,
          taskId: approval.taskId,
          type: `approval.${status}`,
          payload: { approvalId: id, status },
          occurredAt: decidedAt,
        },
        this.clock,
      );
      return this.getById(id);
    });
  }
}
