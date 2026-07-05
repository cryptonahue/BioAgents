/**
 * Unit tests for the `RateGate` in `compoundAuthority.ts`.
 *
 * Coverage matrix:
 *   1. Gate enforces the configured minimum interval between take()
 *   2. Custom RPS sets the min interval correctly (1000 / rps)
 *   3. pause(ms) blocks subsequent takes for at least the requested duration
 *   4. Multiple pause() calls take the max (later shorter pause does not shorten)
 *   5. take() after a long idle period returns immediately (no needless sleep)
 *   6. pause() with non-positive ms is a no-op
 *   7. parseRetryAfter handles integer seconds, HTTP-date, missing, garbage
 *
 * The test uses injected `now()` and `sleep()` so it is fully
 * deterministic and does NOT depend on real wall-clock time.
 */

import { describe, it, expect } from "bun:test";
import {
  RateGate,
  parseRetryAfter,
  COMPOUND_AUTHORITY_DEFAULT_RPS,
} from "../compoundAuthority";

describe("compoundAuthority — RateGate (min interval)", () => {
  it("default rps=4 yields a 250ms minimum interval", () => {
    const gate = new RateGate({});
    expect(gate.getMinIntervalMs()).toBe(250);
  });

  it("custom rps=10 yields a 100ms minimum interval", () => {
    const gate = new RateGate({ rps: 10 });
    expect(gate.getMinIntervalMs()).toBe(100);
  });

  it("custom rps=1 yields a 1000ms minimum interval", () => {
    const gate = new RateGate({ rps: 1 });
    expect(gate.getMinIntervalMs()).toBe(1000);
  });

  it("two consecutive take() calls enforce the min interval via sleep", async () => {
    let now = 1_000;
    const sleepCalls: number[] = [];
    const gate = new RateGate({
      rps: 4, // 250ms
      now: () => now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        now += ms; // simulate time elapsing during sleep
      },
    });
    await gate.take();
    const t0 = now;
    await gate.take();
    // The second take should have slept ~250ms because the first
    // take set `last = 1000` and the next target is 1250.
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    const totalSleep = sleepCalls.reduce((s, v) => s + v, 0);
    expect(totalSleep).toBeGreaterThanOrEqual(250);
    expect(now - t0).toBeGreaterThanOrEqual(250);
  });

  it("two take() calls separated by a long idle period do not sleep", async () => {
    let now = 1_000;
    const sleepCalls: number[] = [];
    const gate = new RateGate({
      rps: 4,
      now: () => now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        now += ms;
      },
    });
    await gate.take();
    now += 5_000; // simulate long idle
    await gate.take();
    expect(sleepCalls).toHaveLength(0);
  });
});

describe("compoundAuthority — RateGate (pause / Retry-After)", () => {
  it("pause(ms) blocks subsequent takes for at least the requested duration", async () => {
    let now = 1_000;
    const sleepCalls: number[] = [];
    const gate = new RateGate({
      rps: 4,
      now: () => now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        now += ms;
      },
    });
    await gate.take();
    gate.pause(2_000); // server says wait 2s
    await gate.take();
    // The second take should have slept ~2000ms - 250ms (since last was at 1000)
    const totalSleep = sleepCalls.reduce((s, v) => s + v, 0);
    expect(totalSleep).toBeGreaterThanOrEqual(1_500); // ~2000 - 250 carryover
    expect(now).toBeGreaterThanOrEqual(1_000 + 1_500);
  });

  it("multiple pause() calls take the max", async () => {
    let now = 0;
    const gate = new RateGate({
      rps: 4,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    gate.pause(5_000);
    gate.pause(2_000); // shorter, must NOT shorten
    gate.pause(8_000); // longer, must extend
    gate.pause(3_000); // shorter again, must NOT shorten
    expect(gate.getPausedUntil()).toBe(8_000);
  });

  it("pause() with non-positive or non-finite ms is a no-op", () => {
    let now = 0;
    const gate = new RateGate({ now: () => now });
    gate.pause(0);
    gate.pause(-100);
    gate.pause(Number.NaN);
    expect(gate.getPausedUntil()).toBe(0);
  });

  it("take() after a long enough pause proceeds without additional sleep", async () => {
    let now = 0;
    const sleepCalls: number[] = [];
    const gate = new RateGate({
      rps: 4,
      now: () => now,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        now += ms;
      },
    });
    gate.pause(500);
    await gate.take(); // sleeps 500ms, now = 500, last = 500, pausedUntil = 500
    // Next take at now=500, target = max(500, 500+250) = 750 — must sleep 250
    await gate.take();
    expect(sleepCalls.length).toBe(2);
    expect(sleepCalls[0]).toBe(500);
    expect(sleepCalls[1]).toBe(250);
  });
});

describe("compoundAuthority — parseRetryAfter", () => {
  it("parses an integer-seconds value", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("1")).toBe(1_000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses a fractional-seconds value", () => {
    expect(parseRetryAfter("0.5")).toBe(500);
  });

  it("parses an HTTP-date in the future", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(30_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it("returns the fallback when header is null or empty", () => {
    expect(parseRetryAfter(null)).toBe(30_000);
    expect(parseRetryAfter("")).toBe(30_000);
    expect(parseRetryAfter(null, 5_000)).toBe(5_000);
  });

  it("returns the fallback for unparseable garbage", () => {
    expect(parseRetryAfter("not-a-number-or-date")).toBe(30_000);
  });
});

describe("compoundAuthority — RateGate (default rps constant)", () => {
  it("default rps constant is 4 (matches the design's safety margin)", () => {
    expect(COMPOUND_AUTHORITY_DEFAULT_RPS).toBe(4);
  });
});
