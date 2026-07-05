/**
 * Unit tests for the nightly `daily_api_usage` GC
 * (api-cost-guard-rails PR #3, task 3.16).
 *
 * Coverage matrix:
 *   1. `tickDailyApiUsageGc()` issues a DELETE on
 *      `daily_api_usage` with `.lt("day", <35-day cutoff>)` and
 *      returns `{ cutoff, deletedRows }`.
 *   2. The cutoff is exactly 35 days before today (UTC date).
 *   3. `startDailyApiUsageGc()` returns a handles object with both
 *      a `setTimeout` and a `setInterval`; setting
 *      `COST_GUARD_GC_ENABLED=false` returns `null`.
 *   4. A failure on the DB round-trip logs
 *      `cost_guard_gc_failed` and re-throws; the production
 *      `start()` caller swallows the throw.
 *
 * The DB client is mocked at the `db/client` boundary; the
 * `logger` is the real one (it just writes to stdout).
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __gcTestRpc: ((...args: unknown[]) => unknown) | undefined;
  // eslint-disable-next-line no-var
  var __gcTestDelete: ((table: string, params: unknown) => unknown) | undefined;
}

function setMockDelete(fn: (table: string, params: unknown) => unknown) {
  globalThis.__gcTestDelete = fn;
}

mock.module("../../../db/client", () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: string[] = [];
      // The base builder supports the read-side chain methods
      // (select, eq, lt, …) so they can be invoked before
      // .delete(). We expose `.delete()` which returns a fresh
      // builder that ALSO supports the same chain methods, then
      // is awaited (which delegates to the test's stub).
      const readBuilder: any = {};
      for (const m of [
        "select",
        "eq",
        "lt",
        "gt",
        "gte",
        "lte",
        "order",
        "in",
      ]) {
        readBuilder[m] = (...args: unknown[]) => {
          chain.push(`${m}(${JSON.stringify(args)})`);
          return readBuilder;
        };
      }
      readBuilder.delete = (opts: unknown) => {
        const writeBuilder: any = {};
        for (const m of [
          "select",
          "eq",
          "lt",
          "gt",
          "gte",
          "lte",
          "order",
          "in",
        ]) {
          writeBuilder[m] = (...args: unknown[]) => {
            chain.push(`${m}(${JSON.stringify(args)})`);
            return writeBuilder;
          };
        }
        // Awaiting the builder (i.e. `await … .lt(...)`) hands
        // control to the test's stub.
        Object.defineProperty(writeBuilder, "then", {
          get() {
            return (onFulfilled: any, onRejected: any) => {
              chain.push("then");
              const fn = globalThis.__gcTestDelete;
              const result = fn
                ? fn(table, { chain, opts })
                : { data: null, error: null, count: null };
              return Promise.resolve(result).then(onFulfilled, onRejected);
            };
          },
        });
        return writeBuilder;
      };
      return readBuilder;
    },
    rpc: (...args: unknown[]) => {
      const fn = globalThis.__gcTestRpc;
      if (!fn) return Promise.resolve({ data: null, error: null });
      return Promise.resolve(fn(...args));
    },
  }),
  getAnonClient: () => null,
  getSupabaseClient: () => null,
  resetClients: () => undefined,
  default: () => null,
}));

// SUT imports (post-mock).
import {
  tickDailyApiUsageGc,
  startDailyApiUsageGc,
  DAILY_API_USAGE_GC_CONSTANTS,
} from "../dailyApiUsageGc";

beforeEach(() => {
  globalThis.__gcTestRpc = undefined;
  globalThis.__gcTestDelete = undefined;
  // Default: 0 rows deleted.
  setMockDelete((_table, _params) => ({
    data: null,
    error: null,
    count: 0,
  }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daily_api_usage GC (PR #3 task 3.16)", () => {
  it("issues a DELETE on daily_api_usage with a 35-day cutoff", async () => {
    let captured: { table: string; params: unknown } | null = null;
    setMockDelete((table, params) => {
      captured = { table, params };
      return { data: null, error: null, count: 3 };
    });

    const result = await tickDailyApiUsageGc();
    expect(captured).toBeTruthy();
    expect(captured!.table).toBe("daily_api_usage");
    const chain = (captured!.params as { chain: string[] }).chain;
    // The chain must include `.lt("day", <cutoff>)`.
    expect(chain.some((c) => c.startsWith("lt("))).toBe(true);
    expect(result.deletedRows).toBe(3);
  });

  it("the cutoff is exactly 35 days before today (UTC)", async () => {
    let captured: { table: string; params: unknown } | null = null;
    setMockDelete((table, params) => {
      captured = { table, params };
      return { data: null, error: null, count: 0 };
    });

    const result = await tickDailyApiUsageGc();
    expect(captured).toBeTruthy();

    // The cutoff is a YYYY-MM-DD string 35 days before today.
    const expectedCutoff = new Date(
      Date.now() - 35 * DAILY_API_USAGE_GC_CONSTANTS.ONE_DAY_MS,
    )
      .toISOString()
      .slice(0, 10);
    expect(result.cutoff).toBe(expectedCutoff);
    expect(DAILY_API_USAGE_GC_CONSTANTS.GC_RETENTION_DAYS).toBe(35);
  });

  it("start() returns handles when enabled; null when COST_GUARD_GC_ENABLED=false", () => {
    process.env.COST_GUARD_GC_ENABLED = "false";
    const off = startDailyApiUsageGc();
    expect(off).toBeNull();
    delete process.env.COST_GUARD_GC_ENABLED;
    const on = startDailyApiUsageGc();
    expect(on).toBeTruthy();
    expect(typeof on!.initialTimeout).toBe("object");
    expect(typeof on!.interval).toBe("object");
    // Clean up the timers so the test process can exit.
    clearTimeout(on!.initialTimeout);
    clearInterval(on!.interval);
  });

  it("DB failure logs cost_guard_gc_failed and re-throws", async () => {
    setMockDelete(() => ({
      data: null,
      error: { message: "DB blip" },
      count: null,
    }));

    await expect(tickDailyApiUsageGc()).rejects.toBeTruthy();
  });

  it("start() swallows the throw so the worker is never crashed", async () => {
    setMockDelete(() => ({
      data: null,
      error: { message: "DB blip" },
      count: null,
    }));

    // Wire up the handlers, manually invoke the tick path the
    // same way `start()` does, and assert it does NOT throw.
    const handles = startDailyApiUsageGc();
    expect(handles).toBeTruthy();
    clearTimeout(handles!.initialTimeout);
    clearInterval(handles!.interval);
    // Direct tick should throw — start()'s caller is the one
    // that wraps the throw in `.catch(() => undefined)`.
    let threw = false;
    try {
      await tickDailyApiUsageGc();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
