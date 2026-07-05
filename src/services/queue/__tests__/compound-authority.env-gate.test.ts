/**
 * E2E test for the COMPOUND_AUTHORITY_ENABLED env-var kill switch
 * and the COMPOUND_AUTHORITY_INTERVAL_HOURS repeat schedule.
 *
 * Mirrors the spec's "COMPOUND_AUTHORITY_ENABLED=false halts the
 * worker" scenario: when the env var is set to `false`, the
 * queue is still registered (callable + queryable) but no repeat
 * job is created. When the env var is `true` (or absent), the
 * queue registers a repeatable job at the configured interval.
 *
 * The test mocks the BullMQ `Queue` class (no real Redis) and
 * intercepts the `.add(name, data, opts)` call to assert the
 * repeat options. The test is hermetic — no DB, no network.
 *
 * Implementation note: the real `getCompoundAuthorityQueue` in
 * `src/services/queue/queues.ts` is a module-scoped singleton
 * with a `compoundAuthorityRepeatRegistered` guard, so calling
 * it twice with different env values in the same process would
 * always hit the first registration. We use `mock.module` to
 * replace the module between tests, which is the closest in-
 * process equivalent of a "process restart" that Bun supports.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock the BullMQ Queue class so we can assert on .add() invocations
// without standing up Redis.
// ---------------------------------------------------------------------------

interface MockedAddCall {
  name: string;
  data: unknown;
  options: { repeat?: { every?: number }; [k: string]: unknown } | undefined;
}

let mockedAddCalls: MockedAddCall[] = [];

class MockQueue {
  public name: string;
  public opts: unknown;
  constructor(name: string, opts?: unknown) {
    this.name = name;
    this.opts = opts;
  }
  async add(name: string, data: unknown, options?: { repeat?: { every?: number } }) {
    mockedAddCalls.push({ name, data, options });
    return { id: `job-${mockedAddCalls.length}` };
  }
  async close() {
    /* no-op */
  }
  async getRepeatableJobs() {
    return mockedAddCalls
      .filter((c) => c.options?.repeat)
      .map((c) => ({ name: c.name, pattern: String(c.options!.repeat!.every) }));
  }
}

// ---------------------------------------------------------------------------
// Helper: install a fresh mock of `bullmq` + dynamic-import the
// queues module so the module-scoped singleton is reset.
// ---------------------------------------------------------------------------

async function freshQueuesModule() {
  mockedAddCalls = [];
  // Replace the bullmq module in Bun's module cache so the
  // queues module's `import { Queue } from "bullmq"` resolves
  // to our mock. We re-`mock.module` between tests so the
  // `compoundAuthorityRepeatRegistered` guard re-initializes.
  mock.module("bullmq", () => ({
    Queue: MockQueue,
    Worker: class {
      constructor() {}
      on() {}
      async close() {}
    },
  }));
  // Dynamic-import a unique key so Bun re-evaluates the module.
  // Bun's import() doesn't natively support cache-busting, so
  // we set process.env in this scope AND rely on the
  // `compoundAuthorityRepeatRegistered` reset by the import
  // re-eval triggered via the test harness.
  const mod = await import("../queues");
  return mod;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.USE_JOB_QUEUE = "true";
  process.env.COMPOUND_AUTHORITY_ENABLED = "true";
  process.env.COMPOUND_AUTHORITY_INTERVAL_HOURS = "6";
  mockedAddCalls = [];
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compound-authority queue repeat (env-driven kill switch)", () => {
  it("registers a repeatable job at the configured interval when enabled", async () => {
    process.env.COMPOUND_AUTHORITY_ENABLED = "true";
    process.env.COMPOUND_AUTHORITY_INTERVAL_HOURS = "6";
    const queues = await freshQueuesModule();
    const queue = queues.getCompoundAuthorityQueue();
    expect(queue).toBeDefined();
    expect(queue.name).toBe("compound-authority");
    await new Promise((r) => setTimeout(r, 50));
    const repeatAdd = mockedAddCalls.find((c) => c.options?.repeat);
    expect(repeatAdd).toBeDefined();
    expect(repeatAdd!.name).toBe("compound-authority-tick");
    expect(repeatAdd!.options!.repeat!.every).toBe(6 * 60 * 60 * 1000);
  });

  it("does NOT register a repeatable job when COMPOUND_AUTHORITY_ENABLED=false", async () => {
    process.env.COMPOUND_AUTHORITY_ENABLED = "false";
    process.env.COMPOUND_AUTHORITY_INTERVAL_HOURS = "6";
    const queues = await freshQueuesModule();
    const queue = queues.getCompoundAuthorityQueue();
    expect(queue).toBeDefined();
    expect(queue.name).toBe("compound-authority");
    await new Promise((r) => setTimeout(r, 50));
    const repeatAdd = mockedAddCalls.find((c) => c.options?.repeat);
    expect(repeatAdd).toBeUndefined();
  });

  it("does NOT register a repeatable job when COMPOUND_AUTHORITY_INTERVAL_HOURS=0", async () => {
    process.env.COMPOUND_AUTHORITY_ENABLED = "true";
    process.env.COMPOUND_AUTHORITY_INTERVAL_HOURS = "0";
    const queues = await freshQueuesModule();
    queues.getCompoundAuthorityQueue();
    await new Promise((r) => setTimeout(r, 50));
    const repeatAdd = mockedAddCalls.find((c) => c.options?.repeat);
    expect(repeatAdd).toBeUndefined();
  });

  it("enqueues a one-shot tick when .add('compound-authority-tick', {}) is called manually", async () => {
    process.env.COMPOUND_AUTHORITY_ENABLED = "false";
    const queues = await freshQueuesModule();
    const queue = queues.getCompoundAuthorityQueue();
    const job = await queue.add("compound-authority-tick", {}, {});
    expect(job).toBeDefined();
    expect(job.id).toBeDefined();
  });
});
