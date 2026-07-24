import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openDatabase,
  type AgentFlowDatabase,
} from "../../src/db/index.js";

export interface DatabaseFixture {
  directory: string;
  databasePath: string;
  database: AgentFlowDatabase;
  cleanup: () => void;
}
export function createDatabaseFixture(): DatabaseFixture {
  const directory = mkdtempSync(path.join(tmpdir(), "agentflow-database-test-"));
  const databasePath = path.join(directory, "agentflow.db");
  const database = openDatabase(databasePath);

  return {
    directory,
    databasePath,
    database,
    cleanup: () => {
      if (database.open) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
