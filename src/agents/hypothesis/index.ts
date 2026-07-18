import type { ConversationState, Message, PlanTask } from "../../types/core";
import type { EvidencePack } from "../../services/researchBrain/types";
import logger from "../../utils/logger";
import { generateHypothesis, type HypothesisDoc } from "./utils";

type HypothesisResult = {
  hypothesis: string;
  thought?: string;
  start: string;
  end: string;
  mode: "create" | "update";
};

/**
 * Hypothesis agent for deep research
 * Independent agent that generates or updates hypothesis without modifying state
 *
 * Flow:
 * 1. Take objective, message, and completed task results
 * 2. Pull relevant context from conversation state
 * 3. Determine if creating new hypothesis or updating existing one
 * 4. Use task outputs directly (with their objectives) to generate/update hypothesis
 * 5. Return hypothesis with timing information
 */
export async function hypothesisAgent(input: {
  objective: string;
  message: Message;
  conversationState: ConversationState;
  completedTasks: PlanTask[];
  evidencePack?: EvidencePack | null;
}): Promise<HypothesisResult> {
  const { objective, message, conversationState, completedTasks } = input;
  const evidencePack =
    input.evidencePack ?? conversationState.values.researchBrainEvidence ?? null;
  const start = new Date().toISOString();

  // Determine if we're creating or updating
  const currentHypothesis = conversationState.values.currentHypothesis;
  const mode: "create" | "update" = currentHypothesis ? "update" : "create";

  logger.info(
    {
      objective,
      mode,
      taskCount: completedTasks.length,
      hasCurrentHypothesis: !!currentHypothesis,
    },
    "hypothesis_agent_started",
  );

  try {
    // Build simple docs from task outputs
    const hypDocs: HypothesisDoc[] = [];

    // The researchBrain passages are the paper text the reply agent and the
    // verifier reason from — the SAME grounded evidence that produced the
    // answer the user sees. Without them, when the current level's task.output
    // is empty (a level whose literature returned nothing, or an output not yet
    // populated on this task reference) the hypothesis prompt collapses to
    // world-state only and the model declares "insufficient evidence / no
    // hits", flatly contradicting the answer. Feed the passages in so the
    // hypothesis is grounded in the same evidence, not starved beside it.
    // Cap the passages: they are similarity-ranked, so the top few carry the
    // answer, and dumping all ~20 verbatim chunks bloats the prompt enough to
    // push the model into an empty/truncated response (which downstream blanks
    // the whole hypothesis). Top 10, each trimmed, keeps it grounded and lean.
    const passages = evidencePack?.passages ?? [];
    passages.slice(0, 10).forEach((p, index) => {
      const content = p.content?.trim();
      if (!content) return;
      hypDocs.push({
        title: p.sourceTitle
          ? `Evidence Passage — ${p.sourceTitle}`
          : `Evidence Passage ${index + 1}`,
        text: content.length > 1500 ? `${content.slice(0, 1500)}…` : content,
        context: "Paper text retrieved for this question — treat as evidence",
      });
    });

    // Add task outputs with their objectives
    completedTasks.forEach((task, index) => {
      logger.info(
        {
          taskIndex: index,
          taskType: task.type,
          hasOutput: !!task.output,
          outputLength: task.output?.length || 0,
          outputPreview: task.output?.substring(0, 100),
        },
        "processing_completed_task_for_hypothesis",
      );

      if (task.output && task.output.trim()) {
        hypDocs.push({
          title: `${task.type} Task Output`,
          text: `Task Objective: ${task.objective}\n\nOutput:\n${task.output}`,
          context: `Output from ${task.type} task`,
        });
      }
    });

    // Add current hypothesis if updating
    if (currentHypothesis) {
      hypDocs.push({
        title: "Current Hypothesis",
        text: currentHypothesis,
        context: "Existing hypothesis to be updated with new findings",
      });
    }

    // Add conversation context
    const contextParts: string[] = [];
    if (conversationState.values.objective) {
      contextParts.push(
        `Main Objective: ${conversationState.values.objective}`,
      );
    }
    if (conversationState.values.evolvingObjective) {
      contextParts.push(
        `Evolving Research Direction: ${conversationState.values.evolvingObjective}`,
      );
    }
    if (conversationState.values.currentObjective) {
      contextParts.push(
        `Current Objective: ${conversationState.values.currentObjective}`,
      );
    }
    if (conversationState.values.methodology) {
      contextParts.push(`Methodology: ${conversationState.values.methodology}`);
    }
    if (conversationState.values.keyInsights?.length) {
      contextParts.push(
        `Key Insights:\n${conversationState.values.keyInsights.join("\n")}`,
      );
    }

    if (contextParts.length > 0) {
      hypDocs.push({
        title: "Research Context",
        text: contextParts.join("\n\n"),
        context: "Overall research context",
      });
    }

    if (hypDocs.length === 0) {
      throw new Error("No data available for hypothesis generation");
    }

    logger.info({ docCount: hypDocs.length, mode }, "generating_hypothesis");

    // Generate or update hypothesis
    const { text, thought } = await generateHypothesis(
      message.question || objective,
      hypDocs,
      {
        maxTokens: 4000,
        thinking: true,
        thinkingBudget: 2048,
        mode,
        messageId: message.id,
        usageType: "deep-research",
      },
    );

    const end = new Date().toISOString();

    logger.info(
      {
        mode,
        fullHypothesis: text,
        fullHypDocs: hypDocs,
      },
      "hypothesis_agent_completed",
    );

    return {
      hypothesis: text,
      thought,
      start,
      end,
      mode,
    };
  } catch (err) {
    logger.error({ err, mode }, "hypothesis_agent_failed");
    throw err;
  }
}
