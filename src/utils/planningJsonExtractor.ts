import logger from "./logger";
import type { PlanTask } from "../types/core";

export type PlanningResult = {
  /**
   * Triage decision for the pipeline.
   * - "research": run the full deep-research cycle (default, backward-safe).
   * - "clarify": the message is a greeting/smalltalk/off-topic with no research
   *   topic yet; the pipeline should short-circuit with a conversational reply.
   * Only the initial planning (no existing plan) can ever produce "clarify".
   */
  mode: "clarify" | "research";
  /**
   * Short, warm, user-facing message used when mode === "clarify".
   */
  clarificationReply?: string;
  currentObjective: string;
  plan: Array<PlanTask>;
};

/**
 * Extract planning result from LLM response using multiple strategies.
 * Never throws - always returns a usable result.
 */
export function extractPlanningResult(
  rawContent: string,
  fallbackObjective?: string
): PlanningResult {
  let method = "unknown";

  // Strategy 1: Direct parse
  try {
    const result = JSON.parse(rawContent) as PlanningResult;
    method = "direct";
    logExtractionResult(method, true, result.plan?.length || 0);
    return normalizeResult(result);
  } catch {}

  // Strategy 2: Extract from markdown code block
  const codeBlockMatch = rawContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    try {
      const result = JSON.parse(codeBlockMatch[1]) as PlanningResult;
      method = "code_block";
      logExtractionResult(method, true, result.plan?.length || 0);
      return normalizeResult(result);
    } catch {}
  }

  // Strategy 3: Find largest JSON object that looks like a planning result
  const jsonObjects = rawContent.match(/\{[\s\S]*\}/g);
  if (jsonObjects) {
    // Sort by length descending, try largest first
    const sorted = jsonObjects.sort((a, b) => b.length - a.length);
    for (const jsonStr of sorted) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.plan || parsed.currentObjective) {
          method = "json_match";
          logExtractionResult(method, true, parsed.plan?.length || 0);
          return normalizeResult(parsed as PlanningResult);
        }
      } catch {}
    }
  }

  // Strategy 4: Field-by-field regex extraction
  const extracted = extractFieldsWithRegex(rawContent);
  if (extracted.plan.length > 0 || extracted.currentObjective) {
    method = "regex";
    logExtractionResult(method, true, extracted.plan.length);
    return extracted;
  }

  // Strategy 5: Return minimal default with fallback objective
  method = "default";
  const defaultResult: PlanningResult = {
    mode: "research",
    currentObjective:
      fallbackObjective || "Continue research based on user query",
    plan: fallbackObjective
      ? [
          {
            type: "LITERATURE" as const,
            objective: fallbackObjective,
            datasets: [],
            level: 1,
            output: "",
          },
        ]
      : [],
  };

  logger.error(
    { rawContentPreview: rawContent.substring(0, 500) },
    "planning_json_extraction_failed_using_default"
  );
  logExtractionResult(method, false, defaultResult.plan.length);

  return defaultResult;
}

/**
 * Extract planning fields using regex patterns
 */
function extractFieldsWithRegex(content: string): PlanningResult {
  const result: PlanningResult = {
    // Regex extraction only detects tasks, never a clarify decision.
    mode: "research",
    currentObjective: "",
    plan: [],
  };

  // Extract currentObjective
  const objectiveMatch = content.match(
    /"currentObjective"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/
  );
  if (objectiveMatch?.[1]) {
    result.currentObjective = objectiveMatch[1].replace(/\\"/g, '"');
  }

  // Extract plan tasks - look for LITERATURE or ANALYSIS task patterns
  const taskPattern =
    /"type"\s*:\s*"(LITERATURE|ANALYSIS)"[\s\S]*?"objective"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match;
  while ((match = taskPattern.exec(content)) !== null) {
    const task: PlanTask = {
      type: match[1] as "LITERATURE" | "ANALYSIS",
      objective: match[2]?.replace(/\\"/g, '"') || "",
      datasets: [],
      level: result.plan.length + 1,
      output: "",
    };
    result.plan.push(task);
  }

  return result;
}

/**
 * Normalize result to ensure all required fields exist
 */
function normalizeResult(result: Partial<PlanningResult>): PlanningResult {
  // Backward-safe: only an explicit "clarify" gates the pipeline. A missing or
  // invalid mode defaults to "research" so a real query is never dropped.
  const mode: "clarify" | "research" =
    result.mode === "clarify" ? "clarify" : "research";
  const clarificationReply =
    typeof result.clarificationReply === "string" &&
    result.clarificationReply.trim()
      ? result.clarificationReply
      : undefined;

  return {
    mode,
    ...(clarificationReply ? { clarificationReply } : {}),
    currentObjective: result.currentObjective || "",
    plan: (result.plan || []).map((task, index) => ({
      ...task,
      type: task.type || "LITERATURE",
      objective: task.objective || "",
      datasets: task.datasets || [],
      level: task.level ?? index + 1,
      output: task.output || "",
    })),
  };
}

/**
 * Log extraction result for monitoring
 */
function logExtractionResult(
  method: string,
  success: boolean,
  planTaskCount: number
): void {
  logger.info(
    { method, success, planTaskCount },
    "planning_json_extraction_result"
  );
}
