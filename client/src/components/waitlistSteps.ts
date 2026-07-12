/**
 * The waitlist form's step machine.
 *
 * This is a PURE module on purpose. The step/validation logic is real state
 * logic and is worth testing directly, and `ui/Tabs.tsx` and `ui/Menu.tsx`
 * already establish that components in this project must stay invokable as plain
 * functions — a hook at the top level throws in the test runner. Keeping the
 * machine out of the component sidesteps that entirely: every function here is
 * `(input) => output` and needs no DOM, no Preact and no hooks to exercise.
 *
 * The component owns exactly one piece of state the machine does not: `form`.
 * That is what makes BACK lossless. The step index selects which fields are
 * RENDERED; it never owns their values, so walking back and forward again cannot
 * drop anything the user typed.
 */

/** The POST /api/waitlist body. This shape is the API contract — do not reorder
 *  or rename without changing the server. */
export interface WaitlistForm {
  full_name: string;
  email: string;
  wallet_address: string;
  role: string;
  organization: string;
  use_case: string;
  referral_source: string;
  twitter_handle: string;
  agreed_to_updates: boolean;
}

export const EMPTY_WAITLIST_FORM: WaitlistForm = {
  full_name: "",
  email: "",
  wallet_address: "",
  role: "",
  organization: "",
  use_case: "",
  referral_source: "",
  twitter_handle: "",
  agreed_to_updates: false,
};

export const ROLES = [
  "Researcher",
  "Conservation",
  "Investor",
  "Developer",
  "Student",
  "Other",
] as const;

export interface WaitlistStepDef {
  /** Stable key, used for the heading's id and for tests. */
  id: string;
  title: string;
  description: string;
  /** The control that takes focus when the step is entered. */
  firstFieldId: string;
  /** Required field names, checked in this order so the FIRST empty one is the
   *  error the user is shown. */
  required: (keyof WaitlistForm)[];
}

/**
 * THE GROUPING IS DERIVED FROM THE FIELDS, and it follows one rule: every
 * REQUIRED field lives in steps 1 and 2, so the final step can never block a
 * submit.
 *
 *   1. Identity — who you are and how we reach you. `wallet_address` belongs
 *      here and not with the "context" questions: a 0x address is an identity
 *      credential, the same kind of thing as an email, not a fact about the
 *      user's work.
 *   2. Context — the two questions the team actually reads (role, use case),
 *      plus the organization that gives the role its meaning. These are the
 *      qualifying answers, so they get a step to themselves rather than being
 *      buried under contact details.
 *   3. Attribution and consent — every field OPTIONAL by construction. A user
 *      who reaches step 3 has already satisfied every requirement, so the last
 *      screen is always submittable and never dead-ends them.
 */
export const WAITLIST_STEPS: WaitlistStepDef[] = [
  {
    id: "identity",
    title: "Who you are",
    description: "How we will recognise and reach you.",
    firstFieldId: "wl-name",
    required: ["full_name", "email"],
  },
  {
    id: "context",
    title: "Your work",
    description: "What you do, and what you would use CoralGPT for.",
    firstFieldId: "wl-role",
    required: ["role", "use_case"],
  },
  {
    id: "consent",
    title: "Finishing up",
    description: "Optional details, then you are done.",
    firstFieldId: "wl-referral",
    required: [],
  },
];

export const STEP_COUNT = WAITLIST_STEPS.length;
export const LAST_STEP = STEP_COUNT - 1;

/** Deliberately permissive: the server is the authority on deliverability. This
 *  only catches the typo class of error (missing @, missing dot, whitespace). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MESSAGES: Record<string, string> = {
  full_name: "Enter your full name.",
  email: "Enter your email address.",
  role: "Select the role that best describes you.",
  use_case: "Tell us what you would use CoralGPT for.",
};

/**
 * The error to show for a step, or `null` when it may be left.
 * Reports the FIRST problem only — a wall of messages for a three-field step is
 * noise, and focus can only go to one place anyway.
 */
export function validateStep(index: number, form: WaitlistForm): string | null {
  const step = WAITLIST_STEPS[index];
  if (!step) return null;

  for (const field of step.required) {
    const value = form[field];
    if (typeof value !== "string" || value.trim() === "") {
      return MESSAGES[field] ?? "This field is required.";
    }
  }

  // Format checks run only once the field is non-empty, so an empty email
  // reports "enter your email", not "that is not a valid email".
  if (step.required.includes("email") && !EMAIL.test(form.email.trim())) {
    return "Enter a valid email address.";
  }

  return null;
}

/** Every step's error, first one wins. Guards the final submit against a form
 *  that was somehow advanced without passing (e.g. a restored draft). */
export function validateAll(form: WaitlistForm): string | null {
  for (let i = 0; i < STEP_COUNT; i++) {
    const error = validateStep(i, form);
    if (error) return error;
  }
  return null;
}

export function isLastStep(index: number): boolean {
  return index >= LAST_STEP;
}

/**
 * Advance. Returns the step to land on and the error to show — the step is
 * UNCHANGED when the current one does not validate, which is what stops the user
 * moving past a missing required field.
 */
export function advance(
  index: number,
  form: WaitlistForm,
): { step: number; error: string | null } {
  const error = validateStep(index, form);
  if (error) return { step: index, error };
  return { step: Math.min(index + 1, LAST_STEP), error: null };
}

/** Go back. Never validates: retreating from a half-filled step is allowed, and
 *  the values survive because the component, not the step, owns `form`. */
export function goBack(index: number): number {
  return Math.max(0, index - 1);
}

/** 1-based, for "Step 2 of 3" and for the progress bar's `aria-valuenow`. */
export function stepNumber(index: number): number {
  return Math.min(Math.max(index, 0), LAST_STEP) + 1;
}

export function progressPercent(index: number): number {
  return (stepNumber(index) / STEP_COUNT) * 100;
}
