/**
 * Research Brain search tool for strict evidence-first chat.
 * Self-registers on import.
 */

import { z } from "zod";
import logger from "../../utils/logger";
import { registerTool } from "../registry";

const InputSchema = z.object({
  query: z.string(),
  trustTier: z.enum(["internal", "external", "all"]).default("internal"),
  includeExternal: z.boolean().default(false),
  measurementMin: z.number().optional(),
  measurementMax: z.number().optional(),
  measurementUnit: z.string().optional(),
  measurementDirection: z
    .enum(["increase", "decrease", "no_change", "mixed"])
    .optional(),
  condition: z.string().optional(),
  reviewStatus: z
    .enum([
      "unreviewed",
      "verified",
      "needs_review",
      "incorrect",
      "quarantined",
      "all",
    ])
    .optional(),
  evidenceStrength: z
    .enum(["direct", "indirect", "hypothesis", "unknown", "all"])
    .optional(),
  sourceId: z.string().optional(),
  sourceTrustTier: z.enum(["internal", "external", "all"]).optional(),
});

registerTool({
  name: "research_brain_search",
  description:
    "Search the BioAgents Research Brain for structured scientific evidence from loaded papers, extracted claims, contradictions, open questions, and classified bioprospecting facts. Use this before literature_search for scientific factual claims.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Scientific question or claim to check against the Research Brain",
      },
      trustTier: {
        type: "string",
        enum: ["internal", "external", "all"],
        description:
          "Evidence tier to search. internal = loaded papers/datasets, external = external literature results, all = both.",
      },
      includeExternal: {
        type: "boolean",
        description:
          "Whether external evidence may be included. Keep false unless internal evidence is insufficient.",
      },
      measurementMin: {
        type: "number",
        description:
          "Optional minimum structured measurement value, for example 500 for >500%.",
      },
      measurementMax: {
        type: "number",
        description:
          "Optional maximum structured measurement value, for example 100 for <100%.",
      },
      measurementUnit: {
        type: "string",
        description:
          "Optional measurement unit filter, for example %, fold-change.",
      },
      measurementDirection: {
        type: "string",
        enum: ["increase", "decrease", "no_change", "mixed"],
        description: "Optional measurement direction filter.",
      },
      condition: {
        type: "string",
        description:
          "Optional experimental condition filter, for example thermal stress.",
      },
      reviewStatus: {
        type: "string",
        enum: [
          "unreviewed",
          "verified",
          "needs_review",
          "incorrect",
          "quarantined",
          "all",
        ],
        description:
          "Optional human review filter. Default search excludes incorrect/quarantined facts; use verified to prefer human-checked facts or all for review workflows.",
      },
      evidenceStrength: {
        type: "string",
        enum: ["direct", "indirect", "hypothesis", "unknown", "all"],
        description:
          "Optional answer-time evidence strength filter for bioprospecting facts.",
      },
      sourceId: {
        type: "string",
        description:
          "Optional Research Brain source id to restrict bioprospecting facts to one loaded source.",
      },
      sourceTrustTier: {
        type: "string",
        enum: ["internal", "external", "all"],
        description:
          "Optional source trust tier filter for bioprospecting facts.",
      },
    },
    required: ["query"],
  },
  execute: async (input) => {
    const parsed = InputSchema.parse(input);
    logger.info(parsed, "research_brain_search_tool_started");

    const { researchBrainSearch } =
      await import("../../services/researchBrain");
    const evidencePack = await researchBrainSearch({
      query: parsed.query,
      trustTier: parsed.trustTier,
      includeExternal: parsed.includeExternal,
      measurementMin: parsed.measurementMin,
      measurementMax: parsed.measurementMax,
      measurementUnit: parsed.measurementUnit,
      measurementDirection: parsed.measurementDirection,
      condition: parsed.condition,
      reviewStatus: parsed.reviewStatus,
      evidenceStrength: parsed.evidenceStrength,
      sourceId: parsed.sourceId,
      sourceTrustTier: parsed.sourceTrustTier,
    });

    return {
      content: JSON.stringify(evidencePack, null, 2),
    };
  },
});
