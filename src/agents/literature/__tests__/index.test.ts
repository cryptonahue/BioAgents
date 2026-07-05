/**
 * Unit tests for the per-source provenance refactor of literatureAgent
 * (commit 516440e).
 *
 * Tests the WRAPPING logic of literatureAgent (status inference,
 * durationMs, error capture, output sanitization) using the natural
 * failure paths of the real source implementations (which throw when
 * their env vars are not set). This avoids mocking concerns entirely
 * and exercises the production code path end-to-end.
 *
 * Coverage:
 *  - KNOWLEDGE without KNOWLEDGE_DOCS_PATH → status="failed"
 *  - OPENSCHOLAR without API URL → status="failed", error captured
 *  - EDISON without API URL → status="failed", jobId undefined
 *  - BIOLIT without API URL → status="failed", jobId undefined
 *  - durationMs is positive (>= 0) in all cases
 *  - output contains the source name and error message on failure
 *  - sourceName is correctly populated regardless of failure
 *
 * Note: testing the "ok" path requires external services. Those
 * scenarios are covered by integration tests in production (the
 * bioprospecting worker runs the full literature pipeline against
 * the 12 Marine Drugs PDFs).
 */

import { describe, it, expect } from "bun:test";

// Env vars are unset in the test environment, so every source fn should
// throw and literatureAgent() should mark the result as status="failed".

import { literatureAgent } from "../index";

describe("literatureAgent — per-source provenance (no-env failure paths)", () => {
  it("KNOWLEDGE without KNOWLEDGE_DOCS_PATH returns status=failed", async () => {
    const result = await literatureAgent({
      objective: "anything",
      type: "KNOWLEDGE",
    });

    expect(result.status).toBe("failed");
    expect(result.sourceName).toBe("KNOWLEDGE");
    expect(result.error).toBeDefined();
    expect(result.output).toContain("Error searching literature");
    expect(result.output).toContain("KNOWLEDGE");
    expect(result.count).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.start).toBeDefined();
    expect(result.end).toBeDefined();
  });

  it("OPENSCHOLAR without API URL returns status=failed with error captured", async () => {
    const result = await literatureAgent({
      objective: "anything",
      type: "OPENSCHOLAR",
    });

    expect(result.status).toBe("failed");
    expect(result.sourceName).toBe("OPENSCHOLAR");
    expect(result.error).toContain("OpenScholar");
    expect(result.output).toContain("OpenScholar");
    expect(result.count).toBe(0);
  });

  it("EDISON without API URL returns status=failed and never throws", async () => {
    const result = await literatureAgent({
      objective: "anything",
      type: "EDISON",
    });

    expect(result.status).toBe("failed");
    expect(result.sourceName).toBe("EDISON");
    expect(result.error).toContain("Edison");
    expect(result.jobId).toBeUndefined();
  });

  it("BIOLIT without API URL returns status=failed and never throws", async () => {
    const result = await literatureAgent({
      objective: "anything",
      type: "BIOLIT",
    });

    expect(result.status).toBe("failed");
    expect(result.sourceName).toBe("BIOLIT");
    expect(result.jobId).toBeUndefined();
  });

  it("BIOLITDEEP without API URL returns status=failed and never throws", async () => {
    const result = await literatureAgent({
      objective: "anything",
      type: "BIOLITDEEP",
    });

    expect(result.status).toBe("failed");
    expect(result.sourceName).toBe("BIOLITDEEP");
    expect(result.jobId).toBeUndefined();
  });

  it("always returns positive durationMs even when source throws", async () => {
    const result = await literatureAgent({
      objective: "anything",
      type: "KNOWLEDGE",
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.durationMs).toBe("number");
  });

  it("does not throw — fan-out resilience: a sibling source would still run", async () => {
    // The whole point of the refactor: a failing source must not throw,
    // so the deep-research worker fan-out can keep the other sources
    // (OpenScholar, Knowledge) running in parallel.
    let threw = false;
    try {
      await literatureAgent({ objective: "x", type: "EDISON" });
      await literatureAgent({ objective: "x", type: "OPENSCHOLAR" });
      await literatureAgent({ objective: "x", type: "KNOWLEDGE" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});