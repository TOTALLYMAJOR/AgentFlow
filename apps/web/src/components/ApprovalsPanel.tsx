import { Button, Flash } from "@primer/react";
import {
  CheckIcon,
  ProhibitIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ApprovalSummary } from "../api/types.js";
import { StatusBadge } from "./StatusBadge.js";

interface ApprovalsPanelProps {
  approvals: ApprovalSummary[];
  loading: boolean;
  error: string | null;
  pendingApprovalId: string | null;
  onDecide: (
    approvalId: string,
    status: "approved" | "rejected" | "cancelled",
  ) => void;
}

export function ApprovalsPanel({
  approvals,
  loading,
  error,
  pendingApprovalId,
  onDecide,
}: ApprovalsPanelProps): React.JSX.Element {
  return (
    <section className="build-panel" aria-labelledby="approval-title">
      <header className="panel-heading">
        <div>
          <h2 id="approval-title">Approval gates</h2>
          <p>Consequential actions remain paused for a local decision.</p>
        </div>
        <span className="queue-count">
          {approvals.filter((approval) => approval.status === "pending").length}
        </span>
      </header>
      {error === null ? null : (
        <Flash variant="danger" className="panel-flash">
          {error}
        </Flash>
      )}
      {loading ? (
        <p className="panel-empty" aria-live="polite">
          Loading approvals…
        </p>
      ) : approvals.length === 0 ? (
        <p className="panel-empty">No approval gates have been requested.</p>
      ) : (
        <ul className="approval-list">
          {approvals.map((approval) => {
            const isPending = approval.status === "pending";
            const isSubmitting = pendingApprovalId === approval.id;
            return (
              <li key={approval.id}>
                <div>
                  <span className="eyebrow">
                    {approval.approvalType.replaceAll("_", " ")}
                  </span>
                  <strong>{approval.reason}</strong>
                  <span className="mono">{approval.taskId ?? "Build gate"}</span>
                </div>
                <div className="approval-actions">
                  <StatusBadge status={approval.status} />
                  {isPending ? (
                    <>
                      <Button
                        size="small"
                        variant="primary"
                        leadingVisual={CheckIcon}
                        disabled={isSubmitting}
                        onClick={() => {
                          onDecide(approval.id, "approved");
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        size="small"
                        leadingVisual={XIcon}
                        disabled={isSubmitting}
                        onClick={() => {
                          onDecide(approval.id, "rejected");
                        }}
                      >
                        Reject
                      </Button>
                      <Button
                        size="small"
                        leadingVisual={ProhibitIcon}
                        disabled={isSubmitting}
                        onClick={() => {
                          onDecide(approval.id, "cancelled");
                        }}
                      >
                        Cancel gate
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
