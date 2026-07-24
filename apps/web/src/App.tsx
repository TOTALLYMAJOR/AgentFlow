import { lazy, Suspense, useState } from "react";
import { SkeletonBox } from "@primer/react";
import type { ScreenId } from "./api/types.js";
import { AppNavigation } from "./components/AppNavigation.js";

const BuildScreen = lazy(async () => ({
  default: (await import("./screens/BuildScreen.js")).BuildScreen,
}));
const OverviewScreen = lazy(async () => ({
  default: (await import("./screens/OverviewScreen.js")).OverviewScreen,
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

export function App(): React.JSX.Element {
  const [screen, setScreen] = useState<ScreenId>("overview");

  return (
    <div className="app-shell">
      <AppNavigation active={screen} onNavigate={setScreen} />
      <main id="main-content" className="main-content">
        <Suspense fallback={<SkeletonBox height="320px" width="100%" />}>
          {screen === "overview" ? (
            <OverviewScreen
              onNavigateRepositories={() => {
                setScreen("repositories");
              }}
            />
          ) : null}
          {screen === "repositories" ? <RepositoriesScreen /> : null}
          {screen === "planner" ? <PlannerScreen /> : null}
          {screen === "build" ? <BuildScreen /> : null}
          {screen === "results" ? <ResultsScreen /> : null}
        </Suspense>
      </main>
    </div>
  );
}
