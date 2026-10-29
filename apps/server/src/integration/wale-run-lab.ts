import { GitCommandRunner } from "../git/index.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  BuildEventEntity,
  PlanEntity,
} from "../db/index.js";
import { AgentFlowError } from "../http/errors.js";
import { canonicalJsonSha256, nativeValidationEvidenceProfileErrors, backlogHandoffErrors } from "./design-intelligence.js";
import type { GovernedTaskHandoff } from "./design-intelligence.js";

const EXPERIMENT_EVENT_TYPE = "wale.experiment.bound";
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{16}$/;
function isSafeReference(value: string): boolean {
  if (value.length > 80 || value.trim().length === 0 || value.includes("/") || value.includes("\\")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const SafeReference = z.string().refine(isSafeReference, "reference is invalid");

const Fingerprint = z.string().regex(FINGERPRINT_PATTERN);

const RepositorySnapshot = z.object({
  state: z.literal("VERIFIED"),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  tree: z.string().regex(/^[0-9a-f]{64}$/),
  gitTree: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  reason: z.null(),
}).strict();

const FrozenTask = z.object({
  state: z.literal("VERIFIED"),
  ids: z.array(Fingerprint).min(1),
  titleFingerprints: z.array(Fingerprint).min(1),
}).strict();

const FrozenRequirements = z.object({
  state: z.literal("UNKNOWN"),
  items: z.array(z.never()).length(0),
  reason: z.literal("FROZEN_REQUIREMENTS_NOT_RETAINED_SEPARATELY"),
}).strict();

const AcceptanceCriteria = z.object({
  state: z.literal("VERIFIED"),
  count: z.number().int().positive(),
  items: z.array(z.object({
    id: Fingerprint,
    fingerprint: Fingerprint,
  }).strict()).min(1),
}).strict().superRefine((value, context) => {
  if (value.count !== value.items.length) {
    context.addIssue({ code: "custom", path: ["count"], message: "count does not match items" });
  }
});

const RequiredCheckBinding = z.object({
  id: SafeReference,
  retainedReference: SafeReference,
}).strict();

const Parameters = z.object({
  deliverySize: z.number().int().min(1).max(10_000),
  overflowBehavior: z.literal("SPLIT_OR_REPLAN"),
  humanInterruptionBudget: z.number().int().nonnegative(),
  authorityEscalationRequired: z.literal(true),
  strategy: z.enum(["NORMAL_EXECUTION", "MINIMUM_WORKING_STATE"]),
  verificationProfile: SafeReference,
  verificationProfileReference: SafeReference,
  requiredCheckBindings: z.array(RequiredCheckBinding).min(1),
  requiredChecksCannotBeBypassed: z.literal(true),
  agentModel: z.null(),
}).strict().superRefine((value, context) => {
  const ids = value.requiredCheckBindings.map((binding) => binding.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["requiredCheckBindings"], message: "check bindings must be unique" });
  }
});

export const WaleRunLabExperimentSchema = z.object({
  experimentId: z.string().regex(/^exp_[0-9a-f]{64}$/),
  runId: z.string().regex(/^run_[A-Za-z0-9]+$/),
  repositorySnapshot: RepositorySnapshot,
  frozenTask: FrozenTask,
  frozenRequirements: FrozenRequirements,
  acceptanceCriteria: AcceptanceCriteria,
  parameters: Parameters,
  authorityStateReference: z.string().regex(/^authority-[0-9a-f]{24}$/),
  strategy: z.enum(["NORMAL_EXECUTION", "MINIMUM_WORKING_STATE"]),
  executionResult: z.object({
    status: z.literal("UNKNOWN"),
    completionState: z.literal("UNKNOWN"),
    reason: z.literal("EXPERIMENT_NOT_EXECUTED"),
  }).strict(),
  verificationEvidence: z.object({
    state: z.literal("UNKNOWN"),
    reason: z.literal("EXPERIMENT_NOT_EXECUTED"),
  }).strict(),
  comparisonEligibility: z.object({
    state: z.literal("UNKNOWN"),
    reason: z.literal("EXACT_CASE_COMPARISON_NOT_BOUND"),
  }).strict(),
  candidateApplication: z.object({
    authorized: z.literal(false),
    reason: z.literal("SEPARATE_AUTHORITY_BOUND_STEP_REQUIRED"),
  }).strict(),
  claimBoundary: z.literal("Result applies to this exact run."),
}).strict();

export type WaleRunLabExperiment = z.infer<typeof WaleRunLabExperimentSchema>;

interface AdmissionAuthority {
  plan: PlanEntity;
  handoff?: GovernedTaskHandoff;
  buildBaseCommit?: string;
  governedGitTree?: string | undefined;
}

interface ExperimentEventRepository {
  append(input: {
    buildId: string;
    type: string;
    payload: Record<string, unknown>;
  }): BuildEventEntity;
  listForBuild(buildId: string, options?: { afterSequence?: number; limit?: number }): BuildEventEntity[];
}

function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function equalOrdered(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function invalidExperiment(): never {
  throw new AgentFlowError(
    "WALE_EXPERIMENT_INVALID",
    "The Wale Run Lab experiment does not match the immutable execution authority",
    409,
  );
}

export function validateWaleExperimentAdmission(
  input: unknown,
  authority: AdmissionAuthority,
): WaleRunLabExperiment {
  const governed = authority.plan.normalizedPlan.governedHandoff;
  if (governed === undefined || authority.handoff === undefined) {
    throw new AgentFlowError(
      "WALE_EXPERIMENT_REQUIRES_GOVERNED_PLAN",
      "A Wale Run Lab experiment requires a currently governed immutable plan",
      409,
    );
  }

  const parsed = WaleRunLabExperimentSchema.safeParse(input);
  if (!parsed.success) invalidExperiment();
  const experiment = parsed.data;
  const executionBaseCommit = governed.executionBaseCommit;
  const handoff = authority.handoff;
  if (nativeValidationEvidenceProfileErrors(handoff, true).length > 0) throw new AgentFlowError("WALE_EVIDENCE_BINDING_UNSUPPORTED", "The immutable task does not declare a supported native evidence binding", 409);
  if (
    executionBaseCommit === undefined ||
    handoff.handoffId !== governed.id ||
    canonicalJsonSha256(handoff) !== governed.sha256 ||
    experiment.repositorySnapshot.commit !== handoff.repository.baseCommit ||
    experiment.repositorySnapshot.commit !== governed.governedBaseCommit ||
    (authority.buildBaseCommit !== undefined && authority.buildBaseCommit !== executionBaseCommit) ||
    experiment.repositorySnapshot.tree !== handoff.repository.snapshotSha256 ||
    (experiment.repositorySnapshot.gitTree !== undefined && experiment.repositorySnapshot.gitTree !== authority.governedGitTree) ||
    experiment.authorityStateReference !== `authority-${handoff.authority.stateSha256.slice(0, 24)}` ||
    experiment.strategy !== experiment.parameters.strategy
  ) invalidExperiment();

  const tasks = authority.plan.normalizedPlan.tasks;
  if (backlogHandoffErrors(tasks, handoff).length > 0) invalidExperiment();
  const expectedTaskIds = tasks.map((task) => fingerprint(task.id));
  const expectedTitleFingerprints = tasks.map((task) => fingerprint(task.title));
  const expectedCriteria = tasks.flatMap((task) =>
    task.acceptanceCriteria.map((criterion, index) => ({
      id: fingerprint(`${task.id}:acceptance:${index + 1}`),
      fingerprint: fingerprint(criterion),
    })),
  );
  if (
    !equalOrdered(experiment.frozenTask.ids, expectedTaskIds) ||
    !equalOrdered(experiment.frozenTask.titleFingerprints, expectedTitleFingerprints) ||
    !equalOrdered(experiment.acceptanceCriteria.items, expectedCriteria) ||
    experiment.acceptanceCriteria.count !== expectedCriteria.length
  ) invalidExperiment();
  return experiment;
}

export function loadBoundWaleExperiment(
  events: Pick<ExperimentEventRepository, "listForBuild">,
  buildId: string,
): WaleRunLabExperiment | undefined {
  const bindings: BuildEventEntity[] = [];
  let afterSequence = 0;
  let page: BuildEventEntity[];
  do {
    page = events.listForBuild(buildId, { afterSequence, limit: 10_000 });
    bindings.push(...page.filter((event) => event.type === EXPERIMENT_EVENT_TYPE));
    if (page.length < 10_000) continue;
    const nextSequence = page.at(-1)?.sequence ?? afterSequence;
    if (nextSequence <= afterSequence) {
      throw new AgentFlowError(
        "WALE_EXPERIMENT_BINDING_INVALID",
        "The retained Wale experiment binding event stream is invalid",
        409,
      );
    }
    afterSequence = nextSequence;
  } while (page.length === 10_000);
  if (bindings.length === 0) return undefined;
  if (bindings.length !== 1) {
    throw new AgentFlowError(
      "WALE_EXPERIMENT_BINDING_CONFLICT",
      "The build does not have exactly one retained Wale experiment binding",
      409,
    );
  }
  const parsed = WaleRunLabExperimentSchema.safeParse(bindings[0]?.payload);
  if (!parsed.success) {
    throw new AgentFlowError(
      "WALE_EXPERIMENT_BINDING_INVALID",
      "The retained Wale experiment binding is malformed",
      409,
    );
  }
  return parsed.data;
}

export function appendWaleExperimentBinding(
  events: ExperimentEventRepository,
  buildId: string,
  experiment: WaleRunLabExperiment,
): BuildEventEntity {
  if (loadBoundWaleExperiment(events, buildId) !== undefined) {
    throw new AgentFlowError(
      "WALE_EXPERIMENT_BINDING_CONFLICT",
      "The build already has a retained Wale experiment binding",
      409,
    );
  }
  return events.append({
    buildId,
    type: EXPERIMENT_EVENT_TYPE,
    payload: experiment,
  });
}

export async function verifyWaleExperimentGitTree(experiment: WaleRunLabExperiment, repositoryRoot: string, handoff: GovernedTaskHandoff): Promise<string | undefined> {
  if (experiment.repositorySnapshot.gitTree === undefined) return undefined;
  if (!/^[0-9a-f]{40}$/u.test(handoff.repository.baseCommit)) invalidExperiment();
  try {
    const result = await new GitCommandRunner().run(repositoryRoot, ["rev-parse", `${handoff.repository.baseCommit}^{tree}`]);
    const tree = result.stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(tree) || tree !== experiment.repositorySnapshot.gitTree) invalidExperiment();
    return tree;
  } catch { invalidExperiment(); }
}
