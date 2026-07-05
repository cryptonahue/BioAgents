/**
 * Unit tests for the WebSocket payload extension in the queue
 * notify module (api-cost-guard-rails PR #3, task 3.14).
 *
 * Coverage matrix:
 *   1. `notifyRunApiCall(runId, cost, calls)` publishes a payload
 *      with `type: "run:api_call"` and the cost/calls fields.
 *   2. `IngestionProgressNotification` accepts the new optional
 *      `apiCost` / `apiCallsCount` fields.
 *   3. `JSON.stringify({...base, apiCost: undefined})` omits the
 *      `apiCost` key (the dashboard treats absence as "no spend
 *      yet").
 *   4. `notifyIngestionProgress(..., options?)` forwards
 *      `apiCost` / `apiCallsCount` into the payload.
 *   5. `notifyIngestionProgress(..., undefined)` produces a payload
 *      with both new fields absent.
 *
 * We mock the Redis publisher so no real Pub/Sub happens. The
 * captured payload is the source of truth for assertions.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __notifyTestPublished: any[] | undefined;
}

function setPublished(arr: any[]) {
  globalThis.__notifyTestPublished = arr;
}

mock.module("../connection", () => ({
  getPublisher: () => ({
    publish: async (channel: string, message: string) => {
      const arr = globalThis.__notifyTestPublished ?? [];
      arr.push({ channel, message: JSON.parse(message) });
      return 1;
    },
  }),
}));

// SUT import (post-mock)
import {
  notifyRunApiCall,
  notifyIngestionProgress,
} from "../notify";
import type { IngestionProgressNotification } from "../types";

beforeEach(() => {
  setPublished([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notify — apiCost payload (PR #3 task 3.14)", () => {
  it("notifyRunApiCall publishes a 'run:api_call' payload with apiCost/apiCallsCount", async () => {
    await notifyRunApiCall("run-1", 1.23, 4);
    const published = globalThis.__notifyTestPublished ?? [];
    expect(published).toHaveLength(1);
    expect(published[0].channel).toBe("run:run-1");
    expect(published[0].message).toEqual({
      type: "run:api_call",
      runId: "run-1",
      apiCost: 1.23,
      apiCallsCount: 4,
    });
  });

  it("IngestionProgressNotification accepts new optional fields", () => {
    const notif: IngestionProgressNotification = {
      type: "ingestion:progress",
      runId: "r1",
      apiCost: 2.5,
      apiCallsCount: 10,
    };
    // Type-level smoke: the object compiles and contains the new
    // fields.
    expect(notif.apiCost).toBe(2.5);
    expect(notif.apiCallsCount).toBe(10);
    expect(notif.llmCost).toBeUndefined();
  });

  it("JSON.stringify omits apiCost when undefined", () => {
    const payload: IngestionProgressNotification = {
      type: "ingestion:progress",
      runId: "r1",
      apiCost: undefined,
      llmCost: 0.5,
    };
    const json = JSON.stringify(payload);
    expect(json).not.toContain("apiCost");
    expect(json).toContain("llmCost");
  });

  it("JSON.stringify omits apiCallsCount when undefined", () => {
    const payload: IngestionProgressNotification = {
      type: "ingestion:progress",
      runId: "r1",
      apiCallsCount: undefined,
    };
    const json = JSON.stringify(payload);
    expect(json).not.toContain("apiCallsCount");
  });

  it("notifyIngestionProgress forwards options.apiCost / apiCallsCount", async () => {
    await notifyIngestionProgress(
      "run-2",
      "src.pdf",
      "processing",
      { processed: 1, skipped: 0, failed: 0, total: 5 },
      undefined,
      { apiCost: 0.75, apiCallsCount: 2 },
    );
    const published = globalThis.__notifyTestPublished ?? [];
    expect(published).toHaveLength(1);
    expect(published[0].message).toEqual({
      type: "ingestion:progress",
      runId: "run-2",
      filePath: "src.pdf",
      status: "processing",
      progress: { processed: 1, skipped: 0, failed: 0, total: 5 },
      apiCost: 0.75,
      apiCallsCount: 2,
    });
  });

  it("notifyIngestionProgress without options yields absent apiCost/apiCallsCount", async () => {
    await notifyIngestionProgress(
      "run-3",
      "x.pdf",
      "processed",
      { processed: 1, skipped: 0, failed: 0, total: 1 },
    );
    const published = globalThis.__notifyTestPublished ?? [];
    const json = JSON.stringify(published[0].message);
    expect(json).not.toContain("apiCost");
    expect(json).not.toContain("apiCallsCount");
  });
});
