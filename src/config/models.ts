/**
 * Curated deep-research model list — single source of truth.
 *
 * The dev picks ONE global model from this list in the Settings UI. The
 * backend validates writes against `isAllowedModel`, and the client fetches
 * `DEEP_RESEARCH_MODELS` to render the dropdown. All entries are OpenRouter
 * model slugs; the provider wiring stays "openrouter" for every one of them.
 *
 * To offer a new model, add it here — no other change is required for the
 * validation/list contract.
 */

export type SelectableModel = { id: string; label: string };

export const DEEP_RESEARCH_MODELS: SelectableModel[] = [
  { id: "minimax/minimax-m3", label: "MiniMax M3" },
  { id: "z-ai/glm-5.2", label: "GLM 5.2" },
];

/**
 * Fallback used when no global model has been selected. Kept in sync with the
 * hardcoded `"minimax/minimax-m3"` default the deep-research agents fall back
 * to at the end of their model-resolution chain.
 */
export const DEFAULT_DEEP_RESEARCH_MODEL = "minimax/minimax-m3";

/**
 * True when `id` is one of the curated, selectable models. Used to reject
 * arbitrary model strings on the settings write path.
 */
export function isAllowedModel(id: string): boolean {
  return DEEP_RESEARCH_MODELS.some((m) => m.id === id);
}
