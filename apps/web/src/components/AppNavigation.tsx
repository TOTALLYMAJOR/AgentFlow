import {
  ActivityIcon,
  ChartLineIcon,
  FolderOpenIcon,
  HouseIcon,
  PlusCircleIcon,
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
  { id: "overview", label: "Home", icon: HouseIcon },
  { id: "repositories", label: "Projects", icon: FolderOpenIcon },
  { id: "planner", label: "New task", icon: PlusCircleIcon },
  { id: "build", label: "Activity", icon: ActivityIcon },
  { id: "results", label: "Completed", icon: ChartLineIcon },
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
          <span>Guided project work</span>
        </div>
      </div>
      <ul>
        {navigationItems.map(({ id, label, icon: NavigationIcon }) => (
          <li key={id}>
            <button
              type="button"
              className={active === id ? "nav-button is-active" : "nav-button"}
              aria-current={active === id ? "page" : undefined}
              aria-label={label}
              title={label}
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
