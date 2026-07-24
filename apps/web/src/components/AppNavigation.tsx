import {
  ActivityIcon,
  ChartLineIcon,
  GitBranchIcon,
  GraphIcon,
  StackIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { ScreenId } from "../api/types.js";

interface AppNavigationProps {
  active: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

interface NavigationItem {
  id: ScreenId;
  label: string;
  icon: Icon;
}

const navigationItems: NavigationItem[] = [
  { id: "overview", label: "Overview", icon: ActivityIcon },
  { id: "repositories", label: "Repositories", icon: GitBranchIcon },
  { id: "planner", label: "Planner", icon: GraphIcon },
  { id: "build", label: "Active build", icon: StackIcon },
  { id: "results", label: "Results", icon: ChartLineIcon },
];

export function AppNavigation({
  active,
  onNavigate,
}: AppNavigationProps): React.JSX.Element {
  return (
    <nav className="side-navigation" aria-label="AgentFlow">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          AF
        </span>
        <div>
          <strong>AgentFlow</strong>
          <span>Local control plane</span>
        </div>
      </div>
      <ul>
        {navigationItems.map(({ id, label, icon: NavigationIcon }) => (
          <li key={id}>
            <button
              type="button"
              className={active === id ? "nav-button is-active" : "nav-button"}
              aria-current={active === id ? "page" : undefined}
              onClick={() => {
                onNavigate(id);
              }}
            >
              <NavigationIcon aria-hidden="true" size={18} weight="regular" />
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="trust-boundary">
        <strong>Loopback only</strong>
        <span>127.0.0.1:4782</span>
      </div>
    </nav>
  );
}
