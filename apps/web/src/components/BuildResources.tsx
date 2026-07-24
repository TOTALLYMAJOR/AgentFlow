import type {
  ArtifactSummary,
  TaskManifest,
} from "../api/types.js";
import { StatusBadge } from "./StatusBadge.js";

interface BuildResourcesProps {
  artifacts: ArtifactSummary[];
  manifests: TaskManifest[];
  loading: boolean;
  error: string | null;
  onSelectTask: (taskId: string, trigger: HTMLButtonElement) => void;
}

export function BuildResources({
  artifacts,
  manifests,
  loading,
  error,
  onSelectTask,
}: BuildResourcesProps): React.JSX.Element {
  return (
    <section className="build-panel" aria-labelledby="resource-title">
      <header className="panel-heading">
        <div>
          <h2 id="resource-title">Artifacts and manifests</h2>
          <p>Versioned handoffs and checksummed task records.</p>
        </div>
        <span className="queue-count">{artifacts.length + manifests.length}</span>
      </header>
      {loading ? (
        <p className="panel-empty" aria-live="polite">
          Loading build resources…
        </p>
      ) : error !== null ? (
        <p className="panel-error" role="alert">
          {error}
        </p>
      ) : artifacts.length === 0 && manifests.length === 0 ? (
        <p className="panel-empty">
          No artifacts or manifests have been published yet.
        </p>
      ) : (
        <div className="resource-columns">
          <div>
            <h3>Artifacts</h3>
            {artifacts.length === 0 ? (
              <p className="compact-empty">None published.</p>
            ) : (
              <ul className="resource-list">
                {artifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <button
                      type="button"
                      className="resource-link"
                      onClick={(event) => {
                        onSelectTask(
                          artifact.producerTaskId,
                          event.currentTarget,
                        );
                      }}
                    >
                      <span>
                        <strong>{artifact.name}</strong>
                        <span className="mono">
                          {artifact.artifactType}@{artifact.version}
                        </span>
                      </span>
                      <StatusBadge status={artifact.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>Manifests</h3>
            {manifests.length === 0 ? (
              <p className="compact-empty">None generated.</p>
            ) : (
              <ul className="resource-list">
                {manifests.map((manifest) => (
                  <li key={manifest.id}>
                    <button
                      type="button"
                      className="resource-link"
                      onClick={(event) => {
                        onSelectTask(manifest.taskId, event.currentTarget);
                      }}
                    >
                      <span>
                        <strong>{manifest.schemaVersion}</strong>
                        <span className="path-text">{manifest.manifestPath}</span>
                      </span>
                      <StatusBadge status={manifest.status} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
