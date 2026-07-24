import { useState } from "react";
import { Button, Flash, FormControl, Select, TextInput } from "@primer/react";
import { PlayIcon } from "@phosphor-icons/react";
import useSWR from "swr";
import { apiFetch, postJson } from "../api/client.js";
import type { PlanSummary, RepositorySummary } from "../api/types.js";
import { Metric } from "../components/Metric.js";
import { PageTitle } from "../components/PageTitle.js";

export function PlannerScreen(): React.JSX.Element {
  const repositories = useSWR<RepositorySummary[]>(
    "/api/repositories",
    apiFetch,
  );
  const [repositoryId, setRepositoryId] = useState("");
  const [backlogPath, setBacklogPath] = useState("");
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createPlan(
    event: React.SyntheticEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const result = await postJson<PlanSummary>("/api/plans", {
        repositoryId,
        ...(backlogPath.length === 0 ? {} : { backlogPath }),
      });
      setPlan(result);
    } catch (cause) {
      setPlan(null);
      setError(cause instanceof Error ? cause.message : "Planning failed");
    }
  }

  async function startBuild(): Promise<void> {
    if (plan === null) {
      return;
    }
    await postJson("/api/builds", { planId: plan.id });
  }

  return (
    <>
      <PageTitle
        title="Backlog planner"
        description="Validate dependencies, ownership, artifacts, and expected elapsed time before any worker is dispatched."
        actions={
          plan === null ? null : (
            <Button
              variant="primary"
              leadingVisual={PlayIcon}
              onClick={() => void startBuild()}
            >
              Start build
            </Button>
          )
        }
      />
      <form className="planner-form" onSubmit={(event) => void createPlan(event)}>
        <FormControl required>
          <FormControl.Label>Repository</FormControl.Label>
          <Select
            block
            value={repositoryId}
            onChange={(event) => {
              setRepositoryId(event.target.value);
            }}
          >
            <Select.Option value="">Select repository</Select.Option>
            {repositories.data?.map((repository) => (
              <Select.Option key={repository.id} value={repository.id}>
                {repository.name}
              </Select.Option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormControl.Label>Backlog path override</FormControl.Label>
          <TextInput
            block
            value={backlogPath}
            placeholder="BACKLOG.md"
            onChange={(event) => {
              setBacklogPath(event.target.value);
            }}
          />
          <FormControl.Caption>
            Leave blank to use the repository configuration.
          </FormControl.Caption>
        </FormControl>
        <Button variant="primary" type="submit" disabled={repositoryId.length === 0}>
          Validate plan
        </Button>
      </form>
      {error === null ? null : (
        <Flash variant="danger" className="spaced-flash">
          {error}
        </Flash>
      )}
      {plan === null ? null : (
        <section className="plan-result" aria-labelledby="plan-result-title">
          <header className="section-heading">
            <div>
              <h2 id="plan-result-title">Validated plan</h2>
              <span className="mono">{plan.id}</span>
            </div>
          </header>
          <div className="metrics-grid metrics-grid--compact">
            <Metric
              label="Tasks"
              value={String(plan.tasks.length)}
              detail={`${plan.waves.length} execution waves`}
            />
            <Metric
              label="Sequential"
              value={`${plan.estimates.sequentialHours.toFixed(1)}h`}
            />
            <Metric
              label="Expected"
              value={`${plan.estimates.expectedElapsedHours.toFixed(1)}h`}
              detail={`${plan.estimates.expectedSavingsPercent.toFixed(1)}% savings`}
            />
            <Metric
              label="Concurrency"
              value={String(plan.estimates.maximumTheoreticalConcurrency)}
              detail="theoretical maximum"
            />
          </div>
          <div className="wave-graph" aria-label="Execution waves">
            {plan.waves.map((wave, index) => (
              <div className="wave" key={wave.join(":")}>
                <span>Wave {index + 1}</span>
                <div>
                  {wave.map((taskId) => (
                    <code
                      className={
                        plan.estimates.criticalPathTaskIds.includes(taskId)
                          ? "task-node task-node--critical"
                          : "task-node"
                      }
                      key={taskId}
                    >
                      {taskId}
                    </code>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
