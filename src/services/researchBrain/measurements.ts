import { getServiceClient } from "../../db/client";
import logger from "../../utils/logger";
import type { BioprospectingFact } from "./types";

const supabase = getServiceClient();

export type MeasurementBackfillResult = {
  dryRun: boolean;
  scannedFacts: number;
  eligibleFacts: number;
  updatedFacts: number;
  skippedFacts: number;
  examples: Array<{
    factId: string;
    measurementValue?: number;
    measurementUnit?: string;
    measurementDirection?: string;
    measurementMin?: number;
    measurementMax?: number;
    timepoint?: string;
    condition?: string;
  }>;
};

type ParsedMeasurement = {
  measurement_value?: number;
  measurement_unit?: string;
  measurement_direction?: string;
  measurement_min?: number;
  measurement_max?: number;
  timepoint?: string;
  condition?: string;
};

export async function backfillBioprospectingMeasurements(params: {
  limit?: number;
  dryRun?: boolean;
}): Promise<MeasurementBackfillResult> {
  const limit = params.limit || 500;
  const dryRun = params.dryRun ?? false;

  const { data, error } = await supabase
    .from("research_bioprospecting_facts")
    .select("*")
    .is("measurement_value", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const facts = (data || []) as BioprospectingFact[];
  const result: MeasurementBackfillResult = {
    dryRun,
    scannedFacts: facts.length,
    eligibleFacts: 0,
    updatedFacts: 0,
    skippedFacts: 0,
    examples: [],
  };

  for (const fact of facts) {
    const parsed = parseMeasurement(fact);
    if (!parsed) {
      result.skippedFacts += 1;
      continue;
    }

    result.eligibleFacts += 1;
    if (result.examples.length < 10) {
      result.examples.push({
        factId: fact.id,
        measurementValue: parsed.measurement_value,
        measurementUnit: parsed.measurement_unit,
        measurementDirection: parsed.measurement_direction,
        measurementMin: parsed.measurement_min,
        measurementMax: parsed.measurement_max,
        timepoint: parsed.timepoint,
        condition: parsed.condition,
      });
    }

    if (dryRun) continue;

    const { error: updateError } = await supabase
      .from("research_bioprospecting_facts")
      .update(parsed)
      .eq("id", fact.id);
    if (updateError) throw updateError;

    result.updatedFacts += 1;
  }

  logger.info(result, "bioprospecting_measurement_backfill_completed");
  return result;
}

function parseMeasurement(fact: BioprospectingFact): ParsedMeasurement | null {
  const text = [fact.result_summary, fact.quote].filter(Boolean).join(" ");
  if (!text.trim()) return null;

  const percentage = parsePercentage(text);
  const foldChange = parseFoldChange(text);
  const measurement = percentage || foldChange;
  if (!measurement) return null;

  const direction = parseDirection(text);
  const timepoint = parseTimepoint(text);
  const condition = parseCondition(text);

  return {
    ...measurement,
    measurement_direction: direction || undefined,
    timepoint: timepoint || undefined,
    condition: condition || undefined,
  };
}

function parsePercentage(text: string): ParsedMeasurement | null {
  const range = text.match(
    /(\d{2,}(?:\.\d+)?)\s*(?:-|–|to|and)\s*(\d{2,}(?:\.\d+)?)\s*%/i,
  );
  if (range) {
    const first = Number(range[1]);
    const second = Number(range[2]);
    if (Number.isFinite(first) && Number.isFinite(second)) {
      return {
        measurement_value: second,
        measurement_unit: "%",
        measurement_min: Math.min(first, second),
        measurement_max: Math.max(first, second),
      };
    }
  }

  const matches = Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*%/g))
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (matches.length === 0) return null;

  return {
    measurement_value: matches[matches.length - 1],
    measurement_unit: "%",
    measurement_min: Math.min(...matches),
    measurement_max: Math.max(...matches),
  };
}

function parseFoldChange(text: string): ParsedMeasurement | null {
  const matches = Array.from(
    text.matchAll(/(\d+(?:\.\d+)?)\s*(?:fold|fold-change)/gi),
  )
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  if (matches.length === 0) return null;

  return {
    measurement_value: matches[matches.length - 1],
    measurement_unit: "fold-change",
    measurement_min: Math.min(...matches),
    measurement_max: Math.max(...matches),
  };
}

function parseDirection(text: string): string | null {
  if (
    /\b(increase|increased|increases|accumulation|accumulations|elevated)\b/i.test(
      text,
    )
  ) {
    return "increase";
  }
  if (
    /\b(decrease|decreased|decreases|reduction|reduced|decline)\b/i.test(text)
  ) {
    return "decrease";
  }
  if (/\b(no significant change|no change|unchanged)\b/i.test(text)) {
    return "no_change";
  }
  return null;
}

function parseTimepoint(text: string): string | null {
  const match = text.match(
    /\b(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i,
  );
  return match ? `${match[1]} ${match[2].toLowerCase()}` : null;
}

function parseCondition(text: string): string | null {
  if (/\bthermal stress|heat stress|high temperatures?\b/i.test(text)) {
    return "thermal stress";
  }
  if (/\bbleaching\b/i.test(text)) return "bleaching";
  if (/\boxidative stress\b/i.test(text)) return "oxidative stress";
  return null;
}
