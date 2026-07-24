import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BaseStyles, ThemeProvider } from "@primer/react";
import { App } from "./App.js";
import "./styles.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("AgentFlow root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider colorMode="auto">
      <BaseStyles>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <App />
      </BaseStyles>
    </ThemeProvider>
  </StrictMode>,
);
