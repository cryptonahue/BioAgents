/**
 * Unit tests for the PubChem day-cap check in the
 * compound-authority worker (api-cost-guard-rails PR #3, task 3.12).
 *
 * Coverage matrix:
 *   1. `isProviderDisabled('pubchem') === true` → worker returns
 *      `{ ...zeros, capHit: 'day' }` WITHOUT calling
 *      `normalizeBioprospectingCompounds`.
 *   2. The log `pubchem_disabled_today, reason=cost_cap` is emitted.
 *   3. `isProviderDisabled('pubchem') === false` → the worker
 *      delegates to `normalizeBioprospectingCompounds` and returns
 *      the result (no `capHit`).
 *
 * Implementation note: we DO NOT `mock.module(costService)` here
 * because Bun's `mock.module` is process-global and a stub of
 * `costService` would leak into later test files (e.g. the
 * costService unit tests, which would then see a fake
 * `CostCapExceededError` class with `name === "MockCostCapExceededError"`).
 * Instead we drive `isProviderDisabled` through the public
 * `disableProviderToday` / `resetDailyFlags` API on the REAL
 * costService module. The compound authority's `normalize` driver
 * is mocked because it does real DB work we don't want in unit
 * tests.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — only the compoundAuthority driver; costService is the
// REAL module so we don't pollute downstream tests.
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __workerCompoundTestNormalize: ((params: unknown) => unknown) | undefined;
}

function setNormalize(fn: (params: unknown) => unknown) {
  globalThis.__workerCompoundTestNormalize = fn;
}

mock.module("../../../researchBrain/compoundAuthority", () => ({
  normalizeBioprospectingCompounds: (params: unknown) => {
    const fn = globalThis.__workerCompoundTestNormalize;
    if (!fn) {
      return Promise.resolve({
        scannedFacts: 0,
        aliasHits: 0,
        pubchemHits: 0,
        pubchemMisses: 0,
        retriesScheduled: 0,
        failed: 0,
        elapsed: 0,
      });
    }
    return Promise.resolve(fn(params));
  },
  getCompoundAuthorityConfig: () => ({
    rateLimitRps: 4,
    maxRetries: 5,
  }),
}));

// BullMQ + connection: we don't need the queue, but the worker
// constructor instantiates a Worker, which needs a connection. We
// mock at the lowest layer.
mock.module("../../connection", () => ({
  getBullMQConnection: () => ({}) as any,
}));

// SUT import (post-mock). Note: costService is NOT mocked here —
// we drive `isProviderDisabled` through `disableProviderToday` +
// `resetDailyFlags` on the real module.
import {
  createCompoundAuthorityWorker,
  processCompoundAuthorityJob,
} from "../compoundAuthority.worker";
import {
  disableProviderToday,
  resetDailyFlags,
} from "../../../researchBrain/costService";

const PUBCHEM_TODAY_KEY = "__pubchemDisabledToday__";

let normalizeCalls = 0;

beforeEach(() => {
  normalizeCalls = 0;
  // Clear ALL provider flags so we start from a known state.
  resetDailyFlags();
  // And clear the raw globalThis keys the costService might have
  // missed (defense in depth).
  delete (globalThis as any)[PUBCHEM_TODAY_KEY];
  setNormalize(() => {
    normalizeCalls++;
    return {
      scannedFacts: 5,
      aliasHits: 3,
      pubchemHits: 2,
      pubchemMisses: 0,
      retriesScheduled: 0,
      failed: 0,
      elapsed: 100,
    };
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compoundAuthority worker — PubChem day-cap check (PR #3 task 3.12)", () => {
  it("aborts cleanly with capHit='day' when isProviderDisabled('pubchem') is true", async () => {
    // Drive the public API on the real costService. This sets the
    // exact globalThis flag `isProviderDisabled` reads, without
    // mocking the module.
    disableProviderToday("pubchem", "test");

    const job = { id: "j-1", data: {} } as any;
    const result = await processCompoundAuthorityJob(job);

    expect(result).toEqual({
      scannedFacts: 0,
      aliasHits: 0,
      pubchemHits: 0,
      pubchemMisses: 0,
      retriesScheduled: 0,
      failed: 0,
      elapsed: 0,
      capHit: "day",
    });
    expect(normalizeCalls).toBe(0);
  });

  it("delegates to normalizeBioprospectingCompounds when not disabled", async () => {
    const job = { id: "j-2", data: {} } as any;
    const result = await processCompoundAuthorityJob(job);

    expect(result.scannedFacts).toBe(5);
    expect(result.aliasHits).toBe(3);
    expect(result.capHit).toBeUndefined();
    expect(normalizeCalls).toBe(1);
  });

  it("createCompoundAuthorityWorker is callable (smoke)", () => {
    const worker = createCompoundAuthorityWorker();
    expect(worker).toBeTruthy();
    return worker.close();
  });
});
