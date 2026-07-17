export interface LiteratureResult {
  output: string;
  count: number;
  /** Distinct library papers retrieved (KNOWLEDGE search), with fragment counts. */
  papers?: { title: string; chunks: number }[];
}
