import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

import type {
  ConsumedArtifact,
  PlannedTask,
  ProducedArtifact,
} from "../domain/types.js";
import { planningError } from "./errors.js";
import type {
  BacklogParserOptions,
  ParsedBacklog,
  PlanningValidationError,
} from "./types.js";

interface SourceLine {
  text: string;
  start: number;
  end: number;
  line: number;
}

interface TaskSection {
  id: string;
  title: string;
  line: number;
  bodyStart: number;
  end: number;
}

interface SourceRange {
  start: number;
  end: number;
}

interface YamlBlock extends SourceRange {
  content: string;
  contentLine: number;
  closed: boolean;
}

interface AcceptanceBlock extends SourceRange {
  criteria: string[];
}

interface Fence {
  character: "`" | "~";
  length: number;
}

const TASK_HEADING =
  /^##[ \t]+([A-Za-z][A-Za-z0-9_-]*-\d+)(?:[ \t]*(?:—|–|:)[ \t]*|[ \t]+-[ \t]+)?(.*?)[ \t]*#*[ \t]*$/;
const ACCEPTANCE_HEADING =
  /^###[ \t]+Acceptance[ \t]+Criteria[ \t]*#*[ \t]*$/i;
const ANY_SECTION_HEADING = /^#{1,3}[ \t]+\S/;
const YAML_FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*(?:yaml|yml)[ \t]*$/i;
const GENERIC_FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})(?:[ \t].*|[^`~].*)?$/;
const LIST_ITEM = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(.+?)\s*$/;

function sourceLines(source: string, baseOffset = 0, baseLine = 1): SourceLine[] {
  const rawLines = source.split("\n");
  let offset = baseOffset;
  return rawLines.map((rawLine, index) => {
    const text = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const newlineLength = index < rawLines.length - 1 ? 1 : 0;
    const line = {
      text,
      start: offset,
      end: offset + rawLine.length + newlineLength,
      line: baseLine + index,
    };
    offset = line.end;
    return line;
  });
}

function openingFence(line: string): Fence | undefined {
  const match = line.match(GENERIC_FENCE_OPEN);
  const marker = match?.[1];
  if (marker === undefined) {
    return undefined;
  }
  const character = marker[0];
  if (character !== "`" && character !== "~") {
    return undefined;
  }
  return { character, length: marker.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const escaped = fence.character === "`" ? "`" : "~";
  const match = line.match(
    new RegExp(`^[ \\t]*(${escaped}{${fence.length},})[ \\t]*$`),
  );
  return match !== null;
}

function findTaskSections(markdown: string): TaskSection[] {
  const sections: TaskSection[] = [];
  let fence: Fence | undefined;

  for (const line of sourceLines(markdown)) {
    if (fence !== undefined) {
      if (closesFence(line.text, fence)) {
        fence = undefined;
      }
      continue;
    }

    const openedFence = openingFence(line.text);
    if (openedFence !== undefined) {
      fence = openedFence;
      continue;
    }

    const heading = line.text.match(TASK_HEADING);
    if (heading === null) {
      continue;
    }

    const id = heading[1];
    if (id === undefined) {
      continue;
    }
    if (sections.length > 0) {
      const previous = sections[sections.length - 1];
      if (previous !== undefined) {
        previous.end = line.start;
      }
    }
    sections.push({
      id: id.trim(),
      title: (heading[2] ?? "").trim(),
      line: line.line,
      bodyStart: line.end,
      end: markdown.length,
    });
  }

  return sections;
}

function findYamlBlock(
  body: string,
  bodyOffset: number,
  bodyLine: number,
): YamlBlock | undefined {
  const lines = sourceLines(body, bodyOffset, bodyLine);
  let otherFence: Fence | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    if (otherFence !== undefined) {
      if (closesFence(line.text, otherFence)) {
        otherFence = undefined;
      }
      continue;
    }

    const yamlOpening = line.text.match(YAML_FENCE_OPEN);
    if (yamlOpening !== null) {
      const marker = yamlOpening[1];
      const character = marker?.[0];
      if (
        marker === undefined ||
        (character !== "`" && character !== "~")
      ) {
        continue;
      }
      const fence: Fence = { character, length: marker.length };
      const contentStart = line.end;
      for (
        let closingIndex = index + 1;
        closingIndex < lines.length;
        closingIndex += 1
      ) {
        const closingLine = lines[closingIndex];
        if (
          closingLine !== undefined &&
          closesFence(closingLine.text, fence)
        ) {
          return {
            start: line.start,
            end: closingLine.end,
            content: body.slice(
              contentStart - bodyOffset,
              closingLine.start - bodyOffset,
            ),
            contentLine: line.line + 1,
            closed: true,
          };
        }
      }
      return {
        start: line.start,
        end: bodyOffset + body.length,
        content: body.slice(contentStart - bodyOffset),
        contentLine: line.line + 1,
        closed: false,
      };
    }

    otherFence = openingFence(line.text);
  }

  return undefined;
}

function criteriaFromMarkdown(markdown: string): string[] {
  const criteria: string[] = [];
  let currentIndex = -1;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const item = rawLine.match(LIST_ITEM);
    if (item?.[1] !== undefined && item[1].trim().length > 0) {
      criteria.push(item[1].trim());
      currentIndex = criteria.length - 1;
      continue;
    }

    const trimmed = rawLine.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith("<!--") ||
      trimmed.endsWith("-->")
    ) {
      continue;
    }

    if (/^[ \t]+/.test(rawLine) && currentIndex >= 0) {
      const current = criteria[currentIndex];
      if (current !== undefined) {
        criteria[currentIndex] = `${current} ${trimmed}`;
      }
      continue;
    }

    criteria.push(trimmed);
    currentIndex = criteria.length - 1;
  }

  return criteria;
}

function findAcceptanceBlock(
  body: string,
  bodyOffset: number,
  bodyLine: number,
): AcceptanceBlock | undefined {
  const lines = sourceLines(body, bodyOffset, bodyLine);
  let fence: Fence | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (fence !== undefined) {
      if (closesFence(line.text, fence)) {
        fence = undefined;
      }
      continue;
    }
    const openedFence = openingFence(line.text);
    if (openedFence !== undefined) {
      fence = openedFence;
      continue;
    }
    if (!ACCEPTANCE_HEADING.test(line.text)) {
      continue;
    }

    const contentStart = line.end;
    let blockEnd = bodyOffset + body.length;
    let nestedFence: Fence | undefined;
    for (
      let followingIndex = index + 1;
      followingIndex < lines.length;
      followingIndex += 1
    ) {
      const followingLine = lines[followingIndex];
      if (followingLine === undefined) {
        continue;
      }
      if (nestedFence !== undefined) {
        if (closesFence(followingLine.text, nestedFence)) {
          nestedFence = undefined;
        }
        continue;
      }
      const followingFence = openingFence(followingLine.text);
      if (followingFence !== undefined) {
        nestedFence = followingFence;
        continue;
      }
      if (ANY_SECTION_HEADING.test(followingLine.text)) {
        blockEnd = followingLine.start;
        break;
      }
    }

    return {
      start: line.start,
      end: blockEnd,
      criteria: criteriaFromMarkdown(
        body.slice(contentStart - bodyOffset, blockEnd - bodyOffset),
      ),
    };
  }

  return undefined;
}

function removeRanges(
  source: string,
  sourceOffset: number,
  ranges: readonly SourceRange[],
): string {
  let result = source;
  const localRanges = ranges
    .map((range) => ({
      start: Math.max(0, range.start - sourceOffset),
      end: Math.min(source.length, range.end - sourceOffset),
    }))
    .sort((left, right) => right.start - left.start);

  for (const range of localRanges) {
    result = `${result.slice(0, range.start)}${result.slice(range.end)}`;
  }
  return result.replace(/\r\n/g, "\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function metadataError(
  errors: PlanningValidationError[],
  taskId: string,
  field: string,
  message: string,
  line: number,
): void {
  errors.push(
    planningError("INVALID_METADATA_FIELD", message, {
      taskId,
      field,
      line,
    }),
  );
}

function readStringArray(
  metadata: Record<string, unknown>,
  field: string,
  taskId: string,
  line: number,
  errors: PlanningValidationError[],
): { present: boolean; values: string[] } {
  const raw = metadata[field];
  if (raw === undefined || raw === null) {
    return { present: false, values: [] };
  }
  if (!Array.isArray(raw)) {
    metadataError(
      errors,
      taskId,
      field,
      `${taskId}.${field} must be an array of non-empty strings`,
      line,
    );
    return { present: true, values: [] };
  }

  const values: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      metadataError(
        errors,
        taskId,
        `${field}[${index}]`,
        `${taskId}.${field}[${index}] must be a non-empty string`,
        line,
      );
      return;
    }
    values.push(entry.trim());
  });
  return { present: true, values };
}

function readEstimate(
  metadata: Record<string, unknown>,
  taskId: string,
  line: number,
  errors: PlanningValidationError[],
): number {
  const estimate = metadata.estimate_hours;
  if (
    typeof estimate !== "number" ||
    !Number.isFinite(estimate) ||
    estimate <= 0
  ) {
    errors.push(
      planningError(
        "INVALID_ESTIMATE",
        `${taskId}.estimate_hours must be a finite number greater than zero`,
        { taskId, field: "estimate_hours", line },
      ),
    );
    return 0;
  }
  return estimate;
}

function readBoolean(
  metadata: Record<string, unknown>,
  field: string,
  defaultValue: boolean,
  taskId: string,
  line: number,
  errors: PlanningValidationError[],
): boolean {
  const value = metadata[field];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    metadataError(
      errors,
      taskId,
      field,
      `${taskId}.${field} must be a boolean`,
      line,
    );
    return defaultValue;
  }
  return value;
}

function readRiskScore(
  metadata: Record<string, unknown>,
  taskId: string,
  line: number,
  errors: PlanningValidationError[],
): number {
  const value = metadata.risk_score;
  if (value === undefined || value === null) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    metadataError(
      errors,
      taskId,
      "risk_score",
      `${taskId}.risk_score must be a finite non-negative number`,
      line,
    );
    return 0;
  }
  return value;
}

function requiredArtifactString(
  record: Record<string, unknown>,
  field: string,
  taskId: string,
  collection: "consumes" | "produces",
  index: number,
  line: number,
  errors: PlanningValidationError[],
): string {
  const value = record[field];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  const errorCode =
    field === "version" ? "ARTIFACT_VERSION_REQUIRED" : "INVALID_ARTIFACT";
  errors.push(
    planningError(
      errorCode,
      `${taskId}.${collection}[${index}].${field} must be a non-empty string`,
      {
        taskId,
        field: `${collection}[${index}].${field}`,
        line,
      },
    ),
  );
  return "";
}

function readConsumes(
  metadata: Record<string, unknown>,
  taskId: string,
  line: number,
  errors: PlanningValidationError[],
): ConsumedArtifact[] {
  const raw = metadata.consumes;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    metadataError(
      errors,
      taskId,
      "consumes",
      `${taskId}.consumes must be an array of artifact declarations`,
      line,
    );
    return [];
  }

  return raw.flatMap((entry, index): ConsumedArtifact[] => {
    if (!isRecord(entry)) {
      errors.push(
        planningError(
          "INVALID_ARTIFACT",
          `${taskId}.consumes[${index}] must be an object`,
          { taskId, field: `consumes[${index}]`, line },
        ),
      );
      return [];
    }
    return [
      {
        task: requiredArtifactString(
          entry,
          "task",
          taskId,
          "consumes",
          index,
          line,
          errors,
        ),
        artifact: requiredArtifactString(
          entry,
          "artifact",
          taskId,
          "consumes",
          index,
          line,
          errors,
        ),
        version: requiredArtifactString(
          entry,
          "version",
          taskId,
          "consumes",
          index,
          line,
          errors,
        ),
      },
    ];
  });
}

function readProduces(
  metadata: Record<string, unknown>,
  taskId: string,
  line: number,
  errors: PlanningValidationError[],
): ProducedArtifact[] {
  const raw = metadata.produces;
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    metadataError(
      errors,
      taskId,
      "produces",
      `${taskId}.produces must be an array of artifact declarations`,
      line,
    );
    return [];
  }

  return raw.flatMap((entry, index): ProducedArtifact[] => {
    if (!isRecord(entry)) {
      errors.push(
        planningError(
          "INVALID_ARTIFACT",
          `${taskId}.produces[${index}] must be an object`,
          { taskId, field: `produces[${index}]`, line },
        ),
      );
      return [];
    }

    const name = requiredArtifactString(
      entry,
      "name",
      taskId,
      "produces",
      index,
      line,
      errors,
    );
    const type = requiredArtifactString(
      entry,
      "type",
      taskId,
      "produces",
      index,
      line,
      errors,
    );
    const version = requiredArtifactString(
      entry,
      "version",
      taskId,
      "produces",
      index,
      line,
      errors,
    );
    const rawPath = entry.path;
    let artifactPath: string | undefined;
    if (rawPath !== undefined && rawPath !== null) {
      if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
        errors.push(
          planningError(
            "INVALID_ARTIFACT",
            `${taskId}.produces[${index}].path must be a non-empty string when present`,
            { taskId, field: `produces[${index}].path`, line },
          ),
        );
      } else {
        artifactPath = rawPath.trim().replaceAll("\\", "/");
      }
    }

    return [
      {
        name,
        type,
        version,
        ...(artifactPath === undefined ? {} : { path: artifactPath }),
      },
    ];
  });
}

function parseMetadata(
  block: YamlBlock | undefined,
  taskId: string,
  taskLine: number,
  errors: PlanningValidationError[],
): Record<string, unknown> {
  if (block === undefined) {
    errors.push(
      planningError(
        "MISSING_YAML_METADATA",
        `${taskId} is missing a fenced YAML metadata block`,
        { taskId, line: taskLine },
      ),
    );
    return {};
  }
  if (!block.closed) {
    errors.push(
      planningError(
        "INVALID_YAML",
        `${taskId} has an unterminated YAML metadata block`,
        { taskId, line: block.contentLine },
      ),
    );
    return {};
  }

  const document = parseDocument(block.content, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      errors.push(
        planningError(
          "INVALID_YAML",
          `${taskId} has invalid YAML: ${error.message}`,
          { taskId, line: block.contentLine },
        ),
      );
    }
    return {};
  }

  const value: unknown = document.toJS();
  if (value === null) {
    return {};
  }
  if (!isRecord(value)) {
    errors.push(
      planningError(
        "INVALID_METADATA",
        `${taskId} YAML metadata must be a mapping`,
        { taskId, line: block.contentLine },
      ),
    );
    return {};
  }
  return value;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function taskFromSection(
  markdown: string,
  section: TaskSection,
  options: BacklogParserOptions,
  errors: PlanningValidationError[],
): PlannedTask {
  const body = markdown.slice(section.bodyStart, section.end);
  const bodyLine = section.line + 1;
  const yamlBlock = findYamlBlock(body, section.bodyStart, bodyLine);
  const acceptanceBlock = findAcceptanceBlock(
    body,
    section.bodyStart,
    bodyLine,
  );
  const metadata = parseMetadata(
    yamlBlock,
    section.id,
    section.line,
    errors,
  );

  if (section.title.length === 0) {
    errors.push(
      planningError(
        "MISSING_TASK_TITLE",
        `${section.id} is missing a task title`,
        { taskId: section.id, line: section.line },
      ),
    );
  }

  const acceptanceCriteria = acceptanceBlock?.criteria ?? [];
  if (acceptanceCriteria.length === 0) {
    errors.push(
      planningError(
        "MISSING_ACCEPTANCE_CRITERIA",
        `${section.id} must contain non-empty Acceptance Criteria`,
        {
          taskId: section.id,
          field: "acceptanceCriteria",
          line: section.line,
        },
      ),
    );
  }

  const dependsOn = readStringArray(
    metadata,
    "depends_on",
    section.id,
    section.line,
    errors,
  );
  const owns = readStringArray(
    metadata,
    "owns",
    section.id,
    section.line,
    errors,
  );
  const validation = readStringArray(
    metadata,
    "validate",
    section.id,
    section.line,
    errors,
  );
  const defaultValidation = [...(options.defaultValidation ?? [])];
  const validate = validation.present
    ? validation.values
    : defaultValidation.map((command) => command.trim());

  const ranges: SourceRange[] = [];
  if (yamlBlock !== undefined) {
    ranges.push(yamlBlock);
  }
  if (acceptanceBlock !== undefined) {
    ranges.push(acceptanceBlock);
  }

  return {
    id: section.id,
    title: section.title,
    description: removeRanges(body, section.bodyStart, ranges),
    acceptanceCriteria,
    estimateHours: readEstimate(
      metadata,
      section.id,
      section.line,
      errors,
    ),
    dependsOn: stableUnique(dependsOn.values),
    owns: stableUnique(owns.values),
    validate,
    consumes: readConsumes(metadata, section.id, section.line, errors),
    produces: readProduces(metadata, section.id, section.line, errors),
    allowNoChanges: readBoolean(
      metadata,
      "allow_no_changes",
      false,
      section.id,
      section.line,
      errors,
    ),
    riskScore: readRiskScore(metadata, section.id, section.line, errors),
    requiresApproval: readBoolean(
      metadata,
      "requires_approval",
      false,
      section.id,
      section.line,
      errors,
    ),
  };
}

export function parseBacklogMarkdown(
  markdown: string,
  options: BacklogParserOptions = {},
): ParsedBacklog {
  const sections = findTaskSections(markdown);
  if (sections.length === 0) {
    return {
      tasks: [],
      errors: [
        planningError(
          "NO_TASKS",
          "The backlog does not contain any valid level-two task headings",
        ),
      ],
    };
  }

  const errors: PlanningValidationError[] = [];
  const tasks = sections.map((section) =>
    taskFromSection(markdown, section, options, errors),
  );
  return { tasks, errors };
}

export async function parseBacklogFile(
  backlogPath: string,
  options: BacklogParserOptions = {},
): Promise<ParsedBacklog> {
  const markdown = await readFile(backlogPath, "utf8");
  return parseBacklogMarkdown(markdown, options);
}
