import type Database from "better-sqlite3";
import {
  BuildRepository,
  type BuildTransitionOptions,
} from "./build-repository.js";
import { BuildEventRepository } from "./event-repository.js";
import { TaskManifestRepository } from "./manifest-repository.js";
import { PlanRepository } from "./plan-repository.js";
import { RepositoryRepository } from "./repository-repository.js";
import { SchedulerStateRepository } from "./scheduler-repository.js";
import { RunnerRepository } from "./runner-repository.js";
import { RemoteJobRepository } from "./remote-job-repository.js";
import { RetryScheduleRepository } from "./retry-schedule-repository.js";
import { VisualComparisonRepository } from "./visual-comparison-repository.js";
import { KnowledgeRepository } from "./knowledge-repository.js";
import {
  ApprovalRepository,
  ArtifactRepository,
  ValidationRunRepository,
  WorkerRepository,
  type AssignWorkerInput,
} from "./runtime-repositories.js";
import {
  TaskRepository,
  type IntegrationFailureInput,
  type IntegrationSuccessInput,
  type TaskTransitionOptions,
} from "./task-repository.js";
import {
  inImmediateTransaction,
  systemClock,
  type Clock,
} from "./shared.js";
import type {
  ArtifactEntity,
  BuildEntity,
  BuildStatus,
  CreateBuildInput,
  PublishArtifactInput,
  TaskEntity,
  TaskStatus,
  WorkerEntity,
} from "./types.js";

export class DatabaseRepositories {
  readonly repositories: RepositoryRepository;
  readonly plans: PlanRepository;
  readonly builds: BuildRepository;
  readonly tasks: TaskRepository;
  readonly workers: WorkerRepository;
  readonly artifacts: ArtifactRepository;
  readonly validations: ValidationRunRepository;
  readonly approvals: ApprovalRepository;
  readonly events: BuildEventRepository;
  readonly manifests: TaskManifestRepository;
  readonly scheduler: SchedulerStateRepository;
  readonly runners: RunnerRepository;
  readonly remoteJobs: RemoteJobRepository;
  readonly retrySchedules: RetryScheduleRepository;
  readonly visualComparisons: VisualComparisonRepository;
  readonly knowledge: KnowledgeRepository;

  constructor(
    readonly database: Database.Database,
    clock: Clock = systemClock,
  ) {
    this.repositories = new RepositoryRepository(database, clock);
    this.plans = new PlanRepository(database, clock);
    this.builds = new BuildRepository(database, clock);
    this.tasks = new TaskRepository(database, clock);
    this.workers = new WorkerRepository(database, clock);
    this.artifacts = new ArtifactRepository(database, clock);
    this.validations = new ValidationRunRepository(database, clock);
    this.approvals = new ApprovalRepository(database, clock);
    this.events = new BuildEventRepository(database, clock);
    this.manifests = new TaskManifestRepository(database, clock);
    this.scheduler = new SchedulerStateRepository(database, clock);
    this.runners = new RunnerRepository(database, clock);
    this.remoteJobs = new RemoteJobRepository(database, clock);
    this.retrySchedules = new RetryScheduleRepository(database, clock);
    this.visualComparisons = new VisualComparisonRepository(database, clock);
    this.knowledge = new KnowledgeRepository(database, clock);
  }

  transaction<T>(operation: (repositories: DatabaseRepositories) => T): T {
    return inImmediateTransaction(this.database, () => operation(this));
  }

  createBuild(input: CreateBuildInput): BuildEntity {
    return this.builds.create(input);
  }

  transitionBuild(
    id: string,
    to: BuildStatus,
    options: BuildTransitionOptions = {},
  ): BuildEntity {
    return this.builds.transition(id, to, options);
  }

  transitionTask(
    id: string,
    to: TaskStatus,
    options: TaskTransitionOptions = {},
  ): TaskEntity {
    return this.tasks.transition(id, to, options);
  }

  assignWorker(input: AssignWorkerInput): WorkerEntity {
    return this.workers.assign(input);
  }

  recordIntegrationSuccess(
    taskId: string,
    input: IntegrationSuccessInput,
  ): TaskEntity {
    return this.tasks.markIntegrationSuccess(taskId, input);
  }

  recordIntegrationFailure(
    taskId: string,
    input: IntegrationFailureInput,
  ): TaskEntity {
    return this.tasks.markIntegrationFailure(taskId, input);
  }

  publishArtifact(input: PublishArtifactInput): ArtifactEntity {
    return this.artifacts.publish(input);
  }
}

export function createDatabaseRepositories(
  database: Database.Database,
  clock: Clock = systemClock,
): DatabaseRepositories {
  return new DatabaseRepositories(database, clock);
}

export const createRepositories = createDatabaseRepositories;
export const AgentFlowStore = DatabaseRepositories;
