import type {
  LiteratureSourceResult,
  LiteratureSourceStatus,
  OnPollUpdate,
} from "../../types/core";
import logger from "../../utils/logger";
import { searchBioLiterature } from "./bio";
import { searchEdison } from "./edison";
import { searchKnowledge } from "./knowledge";
import { searchOpenScholar } from "./openscholar";

export type LiteratureType =
  | "OPENSCHOLAR"
  | "KNOWLEDGE"
  | "EDISON"
  | "BIOLIT"
  | "BIOLITDEEP";

export type BioLiteratureMode = "fast" | "deep";

/**
 * Backward-compatible flat result. The deep-research worker also reads
 * `status`, `durationMs`, `error`, etc. directly off this object to populate
 * `task.sources[]` and emit per-source notifications.
 */
export type LiteratureResult = {
  objective: string;
  output: string;
  count?: number;
  jobId?: string; // Job ID from Edison or BioLit
  reasoning?: string[]; // Real-time reasoning trace from external agent
  start: string;
  end: string;
  // --- New per-source provenance fields ---
  sourceName: LiteratureSourceResult["sourceName"];
  status: LiteratureSourceStatus;
  durationMs: number;
  error?: string;
};

/**
 * Literature agent for deep research
 * Independent agent that searches literature without modifying state
 *
 * Flow:
 * 1. Convert objective to literature query
 * 2. Search literature based on type:
 *    - OPENSCHOLAR: Search academic papers via OpenScholar API
 *    - KNOWLEDGE: Search local knowledge base via vector search
 *    - EDISON: Deep search via Edison AI agent
 *    - BIOLIT: Search via BioLiterature API
 * 3. Return results with timing + per-source provenance
 *
 * Errors are caught and surfaced as `status: "failed"` so that one failed
 * source does not block the rest of the literature fan-out (worker treats
 * each source independently).
 */
export async function literatureAgent(input: {
  objective: string;
  type: LiteratureType;
  onPollUpdate?: OnPollUpdate;
}): Promise<LiteratureResult> {
  const { objective, type, onPollUpdate } = input;
  const start = new Date().toISOString();
  const startedAtMs = Date.now();

  logger.info({ objective, type }, "literature_agent_started");

  let output: string;
  let count: number | undefined;
  let jobId: string | undefined;
  let reasoning: string[] | undefined;
  let status: LiteratureSourceStatus = "ok";
  let error: string | undefined;

  try {
    switch (type) {
      case "OPENSCHOLAR": {
        const result = await searchOpenScholar(objective);
        output = result.output;
        count = result.count;
        if ((count ?? 0) === 0) status = "empty";
        break;
      }
      case "KNOWLEDGE": {
        const result = await searchKnowledge(objective);
        output = result.output;
        count = result.count;
        if ((count ?? 0) === 0) status = "empty";
        break;
      }
      case "BIOLIT": {
        const result = await searchBioLiterature(objective, "fast", onPollUpdate);
        output = result.output;
        jobId = result.jobId;
        reasoning = result.reasoning;
        break;
      }
      case "BIOLITDEEP": {
        const result = await searchBioLiterature(objective, "deep", onPollUpdate);
        output = result.output;
        jobId = result.jobId;
        reasoning = result.reasoning;
        break;
      }
      case "EDISON": {
        const result = await searchEdison(
          objective +
            "/n/nMANDATORY: Make sure that the final literature search result is returned along with inline citations for each claim made in the result. MANDATORY FORMAT: Each claim should be in the following format: (claim goes in the parentheses)[DOI] or (claim goes in the parentheses)[URL]. If there are general statements, it is alright to not include citations for them. DOI URL is totally enough, you don't need to include formats like [pelaezvico2025integrativeanalysisof pages 1-4].\n\nMANDATORY CITATION COUNT: Do your absolute best to cite at least 5 sources in your answer.",
        );
        output = result.output;
        jobId = result.jobId;
        break;
      }
      default:
        throw new Error(`Unknown literature type: ${type}`);
    }
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Unknown error";
    logger.error({ err, objective, type }, "literature_agent_failed");
    output = `Error searching literature (${type}): ${errorMsg}`;
    count = 0;
    status = "failed";
    error = errorMsg;
  }

  const end = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;

  logger.info(
    {
      objective,
      type,
      sourceName: type,
      status,
      durationMs,
      outputLength: output.length,
      count,
      error,
    },
    "literature_agent_completed",
  );

  return {
    objective,
    output,
    count,
    jobId,
    reasoning,
    start,
    end,
    sourceName: type,
    status,
    durationMs,
    error,
  };
}
