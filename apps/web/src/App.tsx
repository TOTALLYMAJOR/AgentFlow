import { lazy, Suspense, useState } from "react";
import { SkeletonBox } from "@primer/react";
import type { ScreenId } from "./api/types.js";
import { AppNavigation } from "./components/AppNavigation.js";

const BuildScreen = lazy(async () => ({
  default: (await import("./screens/BuildScreen.js")).BuildScreen,
}));
const StartScreen = lazy(async () => ({
  default: (await import("./screens/StartScreen.js")).StartScreen,
}));
const PlannerScreen = lazy(async () => ({
  default: (await import("./screens/PlannerScreen.js")).PlannerScreen,
}));
const RepositoriesScreen = lazy(async () => ({
  default: (await import("./screens/RepositoriesScreen.js")).RepositoriesScreen,
}));
const ResultsScreen = lazy(async () => ({
  default: (await import("./screens/ResultsScreen.js")).ResultsScreen,
}));
const InitiativesScreen = lazy(async () => ({
  default: (await import("./screens/InitiativesScreen.js")).InitiativesScreen,
}));

export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<ScreenId>("overview");
  const [preferredBuildId, setPreferredBuildId] = useState<string | null>(null);
  const [goalDraft, setGoalDraft] = useState<{
    repositoryId: string;
    objective: string;
  } | null>(null);

  return (
    <div className="app-shell">
      <AppNavigation active={screen} onNavigate={setScreen} />
      <main id="main-content" className="main-content">
        <Suspense fallback={<SkeletonBox height="320px" width="100%" />}>
          {screen === "overview" ? (
            <StartScreen
              onStartGoal={(draft) => {
                setGoalDraft(draft);
                setScreen("planner");
              }}
              onOpenActivity={() => {
                setScreen("build");
              }}
            />
          ) : null}
          {screen === "repositories" ? <RepositoriesScreen /> : null}
          {screen === "initiatives" ? <InitiativesScreen /> : null}
          {screen === "planner" ? (
            <PlannerScreen
              onNavigateRepositories={() => {
                setScreen("repositories");
              }}
              onBuildStarted={(buildId) => {
                // Carry the exact receipt forward; choosing the first active build
                // can open an unrelated repository when several builds are active.
                setPreferredBuildId(buildId);
                setScreen("build");
              }}
              initialDraft={goalDraft}
            />
          ) : null}
          {screen === "build" ? (
            <BuildScreen preferredBuildId={preferredBuildId} />
          ) : null}
          {screen === "results" ? <ResultsScreen /> : null}
        </Suspense>
      </main>
    </div>
  );
}
