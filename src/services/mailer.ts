/**
 * Mailer — the ONLY mail infrastructure in this repo.
 *
 * One job today: telling a researcher their CoralGPT access request was
 * approved.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RESEND REST API AND NOT AN SMTP TRANSPORT
 *
 * This is a `fetch` against `POST https://api.resend.com/emails`. It is NOT
 * nodemailer, and it is NOT the `resend` npm SDK. Do not "improve" it into
 * either — the shape is the point:
 *
 *   - ZERO DEPENDENCIES. An SDK for one POST is a supply-chain liability with
 *     no upside.
 *   - NO TDZ HAZARD. CLAUDE.md documents that module-level `const`/`let` blow
 *     up in Bun workers, and an SMTP transport is the textbook way to trip it:
 *     the natural shape is `const transport = createTransport({...})` at module
 *     scope, which reads env at import time AND parks a live socket pool in a
 *     module binding. A `fetch` per send has no pool, no persistent connection,
 *     and nothing to cache — so there is nothing to initialise at import time
 *     and no singleton to get wrong. Every config read below is INSIDE a
 *     function.
 *   - FAILURE IS AN HTTP STATUS, not a hung socket.
 *
 * ---------------------------------------------------------------------------
 * ENVIRONMENT (both optional — see "degrades to a no-op")
 *
 *   RESEND_API_KEY    THE FEATURE SWITCH. Unset => the mailer is disabled and
 *                     every send is a logged no-op.
 *   RESEND_FROM       The verified sender, e.g. `CoralGPT <no-reply@yourdomain>`.
 *                     Resend rejects a From on an unverified domain, so there is
 *                     no sane default and the mailer stays off without it.
 *   CORALGPT_APP_URL  The link in the email. Defaults to https://coralgpt.xyz
 *
 * ---------------------------------------------------------------------------
 * IT DEGRADES TO A NO-OP. IT NEVER THROWS. IT DOES NOT CRASH ON BOOT.
 *
 * `sendMail()` NEVER rejects. Unconfigured, network error, 401, 429, 500 — all
 * of it comes back as `{ sent: false, reason }`. That is not defensive habit,
 * it is the contract: the caller is the whitelist-grant handler, and AN
 * APPROVAL THAT ROLLS BACK BECAUSE RESEND 500'd IS STRICTLY WORSE THAN AN
 * APPROVAL WITH NO EMAIL. The grant is what the user is waiting for; the
 * notification is a courtesy layered on top of a committed write.
 *
 * ---------------------------------------------------------------------------
 * THE ERROR BODY IS NOT PART OF THE CONTRACT
 *
 * Resend's docs enumerate error CODES (`validation_error`, `invalid_api_key`,
 * `rate_limit_exceeded`, `application_error`…) but do not commit to a JSON
 * envelope for them. So the branch below keys on `response.ok` / the HTTP
 * STATUS, which IS documented, and treats any parsed body as best-effort detail
 * for the log line only. Nothing downstream depends on a field Resend never
 * promised.
 *
 * ---------------------------------------------------------------------------
 * LOGGING: NO KEY, NO BODY.
 *
 * We log the recipient, the HTTP status, and a coarse reason. We never log
 * RESEND_API_KEY (not even a prefix), and never the rendered email body.
 */

import logger from "../utils/logger";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface MailerConfig {
  apiKey: string;
  from: string;
}

export type SendFailureReason = "not_configured" | "api_error" | "network_error";

export type SendResult =
  | { sent: true; id?: string }
  | { sent: false; reason: SendFailureReason };

/**
 * Read config from the environment. `null` means the mailer is OFF.
 *
 * INSIDE a function on purpose (TDZ — see the header). This is not a hot path;
 * re-reading env per send costs nothing and keeps module init empty.
 */
export function getMailerConfig(): MailerConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM?.trim();

  // BOTH are required. A key without a verified `from` cannot send: Resend
  // rejects an unverified sender domain, so guessing a default would turn a
  // config mistake into a per-approval 422 instead of an obvious "mail is off".
  if (!apiKey || !from) return null;

  return { apiKey, from };
}

export function isMailerConfigured(): boolean {
  return getMailerConfig() !== null;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send one email. NEVER THROWS — see the contract in the header.
 */
export async function sendMail(message: MailMessage): Promise<SendResult> {
  const config = getMailerConfig();

  if (!config) {
    logger.info(
      { event: "mail_skipped_not_configured", to: message.to },
      "mail is not configured; no email sent",
    );
    return { sent: false, reason: "not_configured" };
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        // Resend accepts a string or an array; an array is unambiguous.
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      // A black-holed API must not pin the approval handler's request open.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // DNS failure, connection refused, TLS error, or the abort above.
    logger.error(
      {
        event: "mail_send_failed",
        to: message.to,
        reason: "network_error",
        error: err instanceof Error ? err.message : "unknown error",
      },
      "mail_send_failed",
    );
    return { sent: false, reason: "network_error" };
  }

  if (!response.ok) {
    // Best-effort detail for the log ONLY. The docs do not commit to an error
    // envelope, so nothing branches on this — the STATUS is the signal.
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { name?: string; message?: string };
      detail = body?.name || body?.message;
    } catch {
      detail = undefined;
    }

    logger.error(
      {
        event: "mail_send_failed",
        to: message.to,
        reason: "api_error",
        status: response.status,
        detail,
      },
      "mail_send_failed",
    );
    return { sent: false, reason: "api_error" };
  }

  let id: string | undefined;
  try {
    id = ((await response.json()) as { id?: string })?.id;
  } catch {
    // A 2xx with an unparseable body is still a send. Do not fail it.
    id = undefined;
  }

  logger.info({ event: "mail_sent", to: message.to, id }, "mail_sent");
  return { sent: true, id };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function appUrl(): string {
  return process.env.CORALGPT_APP_URL?.trim() || "https://coralgpt.xyz";
}

/** Escapes the one interpolated value that reaches the HTML part. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The approval email: a plain-text part AND a simple HTML part.
 *
 * Plain text is the one that ALWAYS renders, so it carries the whole message
 * rather than a "view this in HTML" stub. The HTML is inline-styled and
 * table-free — no external stylesheet survives a mail client, and this is four
 * paragraphs and a link, not a newsletter.
 */
export function buildApprovalEmail(params: { name?: string | null }): Omit<
  MailMessage,
  "to"
> {
  const url = appUrl();
  const greeting = params.name?.trim() ? `Hi ${params.name.trim()},` : "Hi,";

  const text = [
    greeting,
    "",
    "Your CoralGPT access is ready. Sign in with the same account you used to request access.",
    "",
    `Sign in: ${url}`,
    "",
    "What you can do:",
    "  - Ask research questions and get answers grounded in peer-reviewed papers,",
    "    with every claim traced back to the exact passage, table, or figure.",
    "  - Chat with any single paper in the Library and get answers grounded only",
    "    in its content.",
    "  - Explore the bioprospecting map of the organisms, compounds, and locations",
    "    extracted from the literature.",
    "",
    "If you did not request access to CoralGPT, you can ignore this email.",
    "",
    "- The CoralGPT team",
  ].join("\n");

  const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px">
  <p>${escapeHtml(greeting)}</p>
  <p><strong>Your CoralGPT access is ready.</strong> Sign in with the same account you used to request access.</p>
  <p>
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#0b7285;color:#ffffff;text-decoration:none;font-weight:600">Sign in to CoralGPT</a>
  </p>
  <p>What you can do:</p>
  <ul>
    <li>Ask research questions and get answers grounded in peer-reviewed papers, with every claim traced back to the exact passage, table, or figure.</li>
    <li>Chat with any single paper in the Library and get answers grounded only in its content.</li>
    <li>Explore the bioprospecting map of the organisms, compounds, and locations extracted from the literature.</li>
  </ul>
  <p style="color:#666;font-size:13px">If you did not request access to CoralGPT, you can ignore this email.</p>
  <p style="color:#666;font-size:13px">- The CoralGPT team</p>
</div>`.trim();

  return { subject: "Your CoralGPT access is ready", text, html };
}

/**
 * Notify a user that their access was granted. Resolves to WHETHER the mail
 * actually went out, so the admin UI can tell the truth about it. Never throws.
 */
export async function sendApprovalEmail(params: {
  to: string;
  name?: string | null;
}): Promise<SendResult> {
  return sendMail({ ...buildApprovalEmail({ name: params.name }), to: params.to });
}
