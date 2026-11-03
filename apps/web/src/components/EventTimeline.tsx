import { useId } from "react";
import type { BuildEvent } from "../api/types.js";

interface EventTimelineProps {
  events: BuildEvent[];
  connected: boolean;
  title?: string;
  emptyMessage?: string;
}

const outcomeTypes = new Set(["governor.intervention_acknowledged", "governor.evaluation_failed"]);
const actions = new Set(["CONTINUE", "DELEGATE_RETRY", "REQUEST_REPAIR", "REQUEST_RECONSIDER", "BLOCK_INTEGRATION", "PAUSE_FOR_REVIEW", "PROPOSE_REPLAN", "CANCEL"]);
const buildStates = new Set(["planning", "ready", "running", "paused", "interrupted", "completed", "failed", "cancelled", "recovering"]);
const numericSignals = ["repeatCount", "attempt", "maxAttempts", "attemptsRemaining"];
const labelSignals = ["violationCode", "evidenceDelta", "classification"];
const listSignals = ["unauthorizedPaths", "unexpectedImpactedPaths", "activeTaskCollisions", "missingEvidence", "contradictedEvidence"];

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function digest(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : "Unknown";
}
function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 ||
      /secret|token|password|bearer|credential|authorization|api[_ -]?key/i.test(value) ||
      !/^[\p{L}\p{N}_. /@*+-]+$/u.test(value) || /^(?:\/|[a-z]:)/i.test(value)) return undefined;
  return value;
}
function state(value: unknown): string {
  return typeof value === "string" && buildStates.has(value) ? value : "Unknown";
}
function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
function signals(value: unknown): Array<[string, string]> {
  const input = object(value);
  const result: Array<[string, string]> = [];
  if (digest(input.failureFingerprint) !== "Unknown") result.push(["failureFingerprint", digest(input.failureFingerprint)]);
  for (const key of numericSignals) {
    const item = input[key];
    if (typeof item === "number" && Number.isSafeInteger(item) && item >= 0) result.push([key, String(item)]);
  }
  for (const key of labelSignals) {
    const label = safeLabel(input[key]);
    if (label !== undefined) result.push([key, label]);
  }
  for (const key of listSignals) {
    const items = input[key];
    if (!Array.isArray(items)) continue;
    const labels = items.slice(0, 8).map(safeLabel).filter((item): item is string => item !== undefined);
    result.push([key, labels.length === 0 ? "Recorded values unavailable" : labels.join(", ") + (items.length > labels.length ? " (some values not displayed)" : "")]);
  }
  if (typeof input.concern === "string" && input.concern.length > 0) result.push(["concern", "Structural concern recorded; free-form details are not displayed"]);
  return result;
}

function OutcomeFacts({ event }: { event: BuildEvent }): React.JSX.Element {
  const payload = object(event.payload);
  const details = object(payload.details);
  const returned = typeof payload.acknowledged === "boolean" ? payload.acknowledged : undefined;
  let available: boolean | undefined;
  if (typeof details.acknowledgementAvailable === "boolean") {
    if (details.acknowledgementAvailable && returned !== undefined) available = true;
    else if (!details.acknowledgementAvailable && returned !== true) available = false;
  } else if (event.type === "governor.intervention_acknowledged" && returned !== undefined) available = true;
  const error = event.type === "governor.evaluation_failed";
  return (
    <div className="governor-result">
      <h4>{error ? "Native error record" : "Native acknowledgement record"} #{event.sequence}</h4>
      <dl className="metadata-grid governor-facts">
        <Fact label="Decision reference"><code>{digest(payload.decisionRecordHash)}</code></Fact>
        <Fact label="Acknowledgement availability">{available === undefined ? "Unknown" : available ? "Available" : "Unavailable"}</Fact>
        <Fact label="Acknowledgement value">{available !== true ? "Unknown (no acknowledgement confirmed)" : returned ? "Received" : "Not acknowledged"}</Fact>
        <Fact label="Applied effect">Unknown; an acknowledgement is not proof of an applied effect.</Fact>
        {error ? <>
          <Fact label="Receipt write attempt">{details.receiptPersistAttempted === true ? "Attempted" : details.receiptPersistAttempted === false ? "Not attempted" : "Unknown"}</Fact>
          <Fact label="Durable ACK write">Not confirmed by this error record.</Fact>
          <Fact label="Catch-time readback before">{state(details.observedBuildStatusBefore)}</Fact>
          <Fact label="Catch-time readback after">{state(details.observedBuildStatusAfter)}</Fact>
        </> : null}
      </dl>
      {error ? <p className="data-boundary-note">Catch-time readback is not the final build state or proof of cause. Later protective actions may change state. Error messages and logs are not displayed here.</p> : null}
    </div>
  );
}

function GovernorRecord({ event, events }: { event: BuildEvent; events: BuildEvent[] }): React.JSX.Element {
  const payload = object(event.payload);
  const decision = object(payload.decision);
  const authority = object(payload.authorityObservation);
  const isDecision = event.type === "governor.decision";
  const isOutcome = outcomeTypes.has(event.type);
  const hash = digest(payload.recordHash);
  const linked = hash === "Unknown" ? [] : events.filter((candidate) =>
    candidate.buildId === event.buildId && outcomeTypes.has(candidate.type) && object(candidate.payload).decisionRecordHash === hash,
  );
  const policy = payload.policyVersion === "governor.v1" && decision.policyVersion === "governor.v1" ? "governor.v1" : "Unknown";
  const action = typeof decision.action === "string" && actions.has(decision.action) ? decision.action : "Unknown";
  const rule = typeof decision.ruleId === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(decision.ruleId) ? safeLabel(decision.ruleId) ?? "Unknown" : "Unknown";
  const supported = payload.schema === "traffic-control/governor-decision-record@1" && policy !== "Unknown" && action !== "Unknown" && rule !== "Unknown";
  const proposal = decision.authorityEffect === "PROPOSAL_ONLY" || action === "PROPOSE_REPLAN" || action === "REQUEST_RECONSIDER";
  const knownSignals = supported ? signals(decision.signals) : [];
  return (
    <details className="governor-record">
      <summary>{isDecision ? "Inspect Governor decision" : isOutcome ? "Inspect Governor result" : "Inspect Governor record"}</summary>
      <div className="governor-content">
        {isDecision ? <>
          <h3>Recent recorded decision</h3>
          {!supported ? <p className="data-boundary-note">Unsupported or incomplete native decision. No authority or runtime result has been inferred.</p> : null}
          {proposal ? <p className="data-boundary-note"><strong>Proposal only.</strong> This record does not authorize execution or replace approved intent.</p> : null}
          <dl className="metadata-grid governor-facts">
            <Fact label="Policy version">{policy}</Fact>
            <Fact label="Recorded action"><code>{action}</code></Fact>
            <Fact label="Recorded rule"><code>{rule}</code></Fact>
            <Fact label="Contract digest"><code>{digest(payload.contractHash)}</code></Fact>
            <Fact label="Observation digest"><code>{digest(payload.observationHash)}</code></Fact>
            <Fact label="Record digest"><code>{hash}</code></Fact>
            <Fact label="Previous record digest"><code>{payload.previousRecordHash === null ? "None recorded" : digest(payload.previousRecordHash)}</code></Fact>
            <Fact label="Recorded authority digest"><code>{digest(authority.authorityStateSha256)}</code></Fact>
            <Fact label="Current authority">Unknown; the recorded snapshot does not establish current authority.</Fact>
            <Fact label="Proof boundary">Unknown; not supplied as verified context by this event.</Fact>
            <Fact label="Record-chain verification">Unverified; recent records are not a complete verified chain.</Fact>
          </dl>
          <h4>Known signals</h4>
          {knownSignals.length === 0 ? <p>No supported signal values supplied.</p> : <dl className="governor-signals">{knownSignals.map(([name, value]) => <Fact key={name} label={name}><code>{value}</code></Fact>)}</dl>}
          <p className="data-boundary-note">A recorded decision does not establish the cause of the current build state. Inspect current native state and governing evidence before continuing.</p>
          {linked.length === 0 ? <p>No matching result is present in this recent window. Its outcome remains unconfirmed here.</p> : linked.map((result) => <OutcomeFacts key={result.sequence} event={result} />)}
        </> : isOutcome ? <OutcomeFacts event={event} /> : <p>Unsupported native Governor record. No runtime result has been inferred.</p>}
      </div>
    </details>
  );
}


export function EventTimeline({
  events,
  connected,
  title = "Recent events",
  emptyMessage = "No native events have been received in this view yet.",
}: EventTimelineProps): React.JSX.Element {
  const titleId = useId();
  const visibleEvents = events.slice().reverse();
  return (
    <section className="build-panel event-panel" aria-labelledby={titleId}>
      <header className="panel-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          <p>{connected ? "Live SSE connection" : "Reconnecting SSE stream"}</p>
        </div>
        <span
          className={connected ? "stream-state is-live" : "stream-state"}
          role="status"
        >
          {connected ? "Live" : "Reconnecting"}
        </span>
      </header>
      <p className="event-window-note">Recent event window; older records may not be shown. Live connection does not verify history or authority.</p>
      {visibleEvents.length === 0 ? (
        <p className="panel-empty">{connected ? emptyMessage : "Waiting for native events or reconnection."}</p>
      ) : (
        <ol className="event-list">
          {visibleEvents.map((event) => {
              const type = typeof event.type === "string" ? event.type : "Unknown event";
              const governor = type.startsWith("governor.");
              const date = new Date(event.occurredAt);
            const isRecovery = /(recover|reconcil|reattach|interrupt)/i.test(
                type,
            );
            return (
              <li className={isRecovery ? "is-recovery" : undefined} key={event.sequence}>
                <span className="mono">#{event.sequence}</span>
                <span>
                    <strong>{governor && type !== "governor.decision" && !outcomeTypes.has(type) ? "Governor record (unsupported type)" : type.replaceAll("_", " ")}</strong>
                  {event.taskId === null ? null : (
                    <span className="mono">{event.taskId}</span>
                  )}
                </span>
                <time dateTime={event.occurredAt}>
                    {Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "Time unavailable"}
                </time>
                  {governor ? <GovernorRecord event={event} events={events} /> : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
