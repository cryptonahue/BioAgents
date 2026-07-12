import { describe, expect, test } from "bun:test";
import {
  EMPTY_WAITLIST_FORM,
  LAST_STEP,
  STEP_COUNT,
  WAITLIST_STEPS,
  advance,
  goBack,
  isLastStep,
  progressPercent,
  stepNumber,
  validateAll,
  validateStep,
  type WaitlistForm,
} from "../waitlistSteps";

/** A form that passes every step. Individual tests knock one field out. */
const complete: WaitlistForm = {
  full_name: "Ada Lovelace",
  email: "ada@example.org",
  wallet_address: "0xabc",
  role: "Researcher",
  organization: "Analytical Society",
  use_case: "Mapping coral bleaching against temperature series.",
  referral_source: "A friend",
  twitter_handle: "@ada",
  agreed_to_updates: true,
};

describe("step definitions", () => {
  test("every required field lives before the last step, so the final step can always submit", () => {
    expect(WAITLIST_STEPS[LAST_STEP].required).toEqual([]);
    expect(validateStep(LAST_STEP, EMPTY_WAITLIST_FORM)).toBeNull();
  });

  test("the required fields cover exactly the four the API treats as mandatory", () => {
    const required = WAITLIST_STEPS.flatMap((s) => s.required);
    expect([...required].sort()).toEqual(["email", "full_name", "role", "use_case"]);
  });

  test("each step names a control to focus on entry", () => {
    for (const step of WAITLIST_STEPS) {
      expect(step.firstFieldId).toMatch(/^wl-/);
    }
  });
});

describe("validateStep", () => {
  test("a complete form clears every step", () => {
    for (let i = 0; i < STEP_COUNT; i++) {
      expect(validateStep(i, complete)).toBeNull();
    }
  });

  test("step 1 requires a name", () => {
    expect(validateStep(0, { ...complete, full_name: "" })).toBe("Enter your full name.");
  });

  test("whitespace is not a value", () => {
    expect(validateStep(0, { ...complete, full_name: "   " })).toBe("Enter your full name.");
  });

  test("an empty email reports as missing, not as malformed", () => {
    expect(validateStep(0, { ...complete, email: "" })).toBe("Enter your email address.");
  });

  test("a malformed email is caught once it is non-empty", () => {
    for (const bad of ["ada", "ada@", "@example.org", "ada@example", "a b@c.d"]) {
      expect(validateStep(0, { ...complete, email: bad })).toBe("Enter a valid email address.");
    }
  });

  test("step 2 requires a role and a use case", () => {
    expect(validateStep(1, { ...complete, role: "" })).toBe(
      "Select the role that best describes you.",
    );
    expect(validateStep(1, { ...complete, use_case: "" })).toBe(
      "Tell us what you would use CoralGPT for.",
    );
  });

  test("the first problem wins -- one message, one place for focus to go", () => {
    expect(validateStep(1, { ...complete, role: "", use_case: "" })).toBe(
      "Select the role that best describes you.",
    );
  });

  test("step 3 is optional all the way down", () => {
    const bare = { ...complete, referral_source: "", twitter_handle: "", agreed_to_updates: false };
    expect(validateStep(2, bare)).toBeNull();
  });

  test("an out-of-range index does not throw", () => {
    expect(validateStep(99, EMPTY_WAITLIST_FORM)).toBeNull();
    expect(validateStep(-1, EMPTY_WAITLIST_FORM)).toBeNull();
  });
});

describe("advance", () => {
  test("a valid step moves on and clears the error", () => {
    expect(advance(0, complete)).toEqual({ step: 1, error: null });
    expect(advance(1, complete)).toEqual({ step: 2, error: null });
  });

  test("an invalid step does NOT move -- this is the gate", () => {
    const result = advance(0, { ...complete, email: "nope" });
    expect(result.step).toBe(0);
    expect(result.error).toBe("Enter a valid email address.");
  });

  test("an empty form cannot leave step 1", () => {
    expect(advance(0, EMPTY_WAITLIST_FORM).step).toBe(0);
  });

  test("advancing never runs past the last step", () => {
    expect(advance(LAST_STEP, complete).step).toBe(LAST_STEP);
  });
});

describe("goBack", () => {
  test("retreats one step", () => {
    expect(goBack(2)).toBe(1);
    expect(goBack(1)).toBe(0);
  });

  test("never goes below the first step", () => {
    expect(goBack(0)).toBe(0);
    expect(goBack(-5)).toBe(0);
  });

  test("back does not validate -- a half-filled step may be abandoned", () => {
    // goBack takes no form at all, which is the point: there is nothing it could
    // reject, so a user can always retreat.
    expect(goBack(1)).toBe(0);
  });
});

describe("back is lossless", () => {
  test("walking forward, back and forward again preserves every field", () => {
    // The machine never touches `form` -- it only ever returns an index. That is
    // the invariant that makes Back lossless, and this asserts it directly.
    let step = 0;
    const form = { ...complete };

    step = advance(step, form).step; // 0 -> 1
    step = advance(step, form).step; // 1 -> 2
    step = goBack(step); // 2 -> 1
    step = goBack(step); // 1 -> 0
    step = advance(step, form).step; // 0 -> 1
    step = advance(step, form).step; // 1 -> 2

    expect(step).toBe(LAST_STEP);
    expect(form).toEqual(complete);
  });
});

describe("validateAll", () => {
  test("passes a complete form", () => {
    expect(validateAll(complete)).toBeNull();
  });

  test("reports the earliest step's problem, so focus can be sent to the right screen", () => {
    expect(validateAll({ ...complete, full_name: "", role: "" })).toBe("Enter your full name.");
  });

  test("catches a step-2 problem even when step 1 is fine", () => {
    expect(validateAll({ ...complete, use_case: "" })).toBe(
      "Tell us what you would use CoralGPT for.",
    );
  });
});

describe("progress reporting", () => {
  test("isLastStep", () => {
    expect(isLastStep(0)).toBe(false);
    expect(isLastStep(LAST_STEP)).toBe(true);
  });

  test("stepNumber is 1-based and clamped", () => {
    expect(stepNumber(0)).toBe(1);
    expect(stepNumber(LAST_STEP)).toBe(STEP_COUNT);
    expect(stepNumber(-3)).toBe(1);
    expect(stepNumber(99)).toBe(STEP_COUNT);
  });

  test("progress runs from a non-zero start to exactly 100 on the last step", () => {
    // Step 1 of 3 must not render an EMPTY bar -- the user has arrived somewhere.
    expect(progressPercent(0)).toBeGreaterThan(0);
    expect(progressPercent(LAST_STEP)).toBe(100);
  });

  test("progress increases monotonically", () => {
    for (let i = 1; i < STEP_COUNT; i++) {
      expect(progressPercent(i)).toBeGreaterThan(progressPercent(i - 1));
    }
  });
});
