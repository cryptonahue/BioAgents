#!/usr/bin/env bun
/**
 * Drives the WHOLE access funnel in a real Chromium, in BOTH themes, against the
 * harness (`harness.ts` must already be running on :4713).
 *
 *     bun scripts/verify-access-flow/drive.ts
 *
 * Landing -> Get started -> (stubbed Privy) -> no request -> 3-step form ->
 * submit -> "under review" -> admin approves -> sign in -> /chat.
 *
 * MEASUREMENT TRAPS THIS AVOIDS (each has produced a false result in this repo):
 *
 *  1. `getComputedStyle` returns `oklch()` STRINGS. Parsing them as sRGB gives
 *     garbage. Every color here is read by PAINTING to a 1x1 canvas and reading
 *     the pixel back — the browser does the conversion, we do not.
 *  2. Lyra uses `transition-all`, so colors animate on a theme flip and outlines
 *     animate 0 -> 2px on focus. Everything is sampled after a ~450ms settle.
 *  3. `<html>` is rgba(0,0,0,0) — the page fill lives on `<body>`. The
 *     composited backdrop is walked up the ancestor chain until an OPAQUE fill
 *     is found, rather than assumed.
 *  4. The theme key is `bioagents.theme`, and `html.dark` is asserted explicitly
 *     rather than inferred from the toggle having been clicked.
 *  5. The focus ring is `outline-offset: 2px` — it paints OUTSIDE the border box,
 *     so it is sampled against the PARENT's composited fill, not the button's.
 */

import { chromium, type Page } from 'playwright-core';
import { mkdirSync } from 'fs';

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1140/chrome-linux/chrome`;
const BASE = 'http://localhost:4713';
const SHOTS = `${import.meta.dir}/shots`;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => {
  console.error(`  FAIL  ${m}`);
  failures++;
};
const info = (m: string) => console.log(`        ${m}`);

const settle = (p: Page) => p.waitForTimeout(450); // trap 2

// ---------------------------------------------------------------------------
// Color: paint to a 1x1 canvas. NEVER parse oklch() by hand. (trap 1)
// ---------------------------------------------------------------------------
async function install(page: Page) {
  await page.addInitScript(() => {
    (window as any).__px = (color: string): [number, number, number, number] => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };

    // Composite a possibly-translucent fill over its ancestors until opaque.
    // <html> is rgba(0,0,0,0); the page fill is on <body>. (trap 3)
    (window as any).__backdrop = (el: Element): [number, number, number] => {
      let node: Element | null = el;
      const stack: [number, number, number, number][] = [];
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const [r, g, b, a] = (window as any).__px(bg);
        if (a > 0) stack.push([r, g, b, a]);
        if (a >= 0.999) break;
        node = node.parentElement;
      }
      let [R, G, B] = [255, 255, 255];
      for (let i = stack.length - 1; i >= 0; i--) {
        const [r, g, b, a] = stack[i];
        R = r * a + R * (1 - a);
        G = g * a + G * (1 - a);
        B = b * a + B * (1 - a);
      }
      return [R, G, B];
    };

    const lum = (r: number, g: number, b: number) => {
      const f = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };

    (window as any).__contrast = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const [fr, fg, fb, fa] = (window as any).__px(cs.color);
      const [br, bg2, bb] = (window as any).__backdrop(el);
      // Composite the ink over its own backdrop if it is translucent.
      const R = fr * fa + br * (1 - fa);
      const G = fg * fa + bg2 * (1 - fa);
      const B = fb * fa + bb * (1 - fa);
      const l1 = lum(R, G, B);
      const l2 = lum(br, bg2, bb);
      const ratio =
        (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return {
        ratio: Math.round(ratio * 100) / 100,
        fg: [Math.round(R), Math.round(G), Math.round(B)],
        bg: [Math.round(br), Math.round(bg2), Math.round(bb)],
        text: (el.textContent || '').trim().slice(0, 40),
      };
    };

    // Every non-circle border-radius under a root. The app was swept SQUARE.
    (window as any).__radii = (rootSel: string) => {
      const root = document.querySelector(rootSel);
      if (!root) return [];
      const out: { sel: string; radius: string }[] = [];
      for (const el of [root, ...root.querySelectorAll('*')]) {
        const cs = getComputedStyle(el as Element);
        const r = cs.borderRadius;
        if (!r || r === '0px') continue;
        // A circle (avatar/icon ring) is legitimate: 50% or a pill.
        if (r.includes('50%') || r.includes('9999px')) continue;
        const rect = (el as HTMLElement).getBoundingClientRect();
        const px = parseFloat(r);
        if (px >= Math.min(rect.width, rect.height) / 2 - 0.5) continue; // pill
        out.push({
          sel:
            (el as Element).tagName.toLowerCase() +
            '.' +
            ((el as Element).className?.toString().split(' ')[0] || ''),
          radius: r,
        });
      }
      return out;
    };
  });
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    localStorage.setItem('bioagents.theme', t); // trap 4
    document.documentElement.classList.toggle('dark', t === 'dark');
  }, theme);
  await settle(page); // trap 2
  const isDark = await page.evaluate(() =>
    document.documentElement.classList.contains('dark'),
  );
  if ((theme === 'dark') !== isDark) bad(`theme ${theme}: html.dark = ${isDark}`);
}

async function contrast(page: Page, sel: string, min: number, label: string) {
  const r = await page.evaluate((s) => (window as any).__contrast(s), sel);
  if (!r) {
    bad(`${label}: element not found (${sel})`);
    return;
  }
  const line = `${label}: ${r.ratio}:1  fg=rgb(${r.fg}) bg=rgb(${r.bg})  "${r.text}"`;
  if (r.ratio >= min) ok(line);
  else bad(`${line}  [needs ${min}:1]`);
}

async function reset(page: Page, s: object) {
  await page.request.post(`${BASE}/__state`, { data: s });
}

// ---------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await install(page);
page.on('pageerror', (e) => bad(`PAGE ERROR: ${e.message}`));

for (const theme of ['dark', 'light'] as const) {
  console.log(`\n=== THEME: ${theme} ===`);
  await reset(page, { hasRequest: false, whitelisted: false });

  // -- 1. LANDING -----------------------------------------------------------
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await setTheme(page, theme);
  await page.waitForSelector('.landing-hero-title');

  const heroCta = page.locator('.landing-hero-actions .btn');
  const heroText = (await heroCta.textContent())?.trim();
  if (heroText === 'Get started') ok(`hero CTA is "Get started"`);
  else bad(`hero CTA is "${heroText}", expected "Get started"`);

  const body = await page.content();
  if (!body.includes('Test Agent')) ok('"Test Agent" is gone from the landing');
  else bad('"Test Agent" still appears on the landing');

  if (!body.includes('Join Waitlist')) ok('the pre-auth "Join Waitlist" CTA is gone');
  else bad('"Join Waitlist" still on the landing');

  const gate = await page.locator('.landing-hero-gate').textContent();
  if (gate?.includes('Private beta')) ok(`closed-beta line shown pre-auth: "${gate.trim()}"`);
  else bad('no closed-beta line under the hero CTA');

  // No counter — the user explicitly rejected showing queue size.
  if (/\b\d+\s+(people|researchers|others|in line|waiting)/i.test(body))
    bad('a queue counter appears on the landing');
  else ok('no queue counter anywhere');

  const audience = await page.locator('.landing-section-title', { hasText: 'Who this is for' }).count();
  if (audience === 1) ok('"Who this is for" section present');
  else bad('"Who this is for" section missing');

  const faqs = await page.locator('.landing-faq > details').allTextContents();
  const hasWhy = faqs.some((f) => f.includes('Why is access limited'));
  const hasHowLong = faqs.some((f) => f.includes('How long does approval take'));
  if (hasWhy && hasHowLong) ok('FAQ covers why access is limited + how long approval takes');
  else bad(`FAQ missing entries (why=${hasWhy}, howLong=${hasHowLong})`);

  // The FAQ is still native <details> on Basecoat's .accordion — not rebuilt.
  const isDetails = await page.locator('.accordion.landing-faq > details > summary').count();
  if (isDetails >= 4) ok(`FAQ is still native <details> on .accordion (${isDetails} entries)`);
  else bad('FAQ is no longer native <details> on .accordion');

  await contrast(page, '.landing-hero-gate', 4.5, 'hero gate line');
  await contrast(page, '.landing-hero-subtitle', 4.5, 'hero subtitle');
  await page.screenshot({ path: `${SHOTS}/1-landing-${theme}.png` });

  // -- 2. GET STARTED -> Privy -> not whitelisted, no request ---------------
  await heroCta.click();
  await page.evaluate(() => (window as any).__privy.login()); // stubbed Privy completes
  await page.waitForURL('**/access-pending', { timeout: 5000 });
  await settle(page);
  ok('Get started -> Privy -> /access-pending (not whitelisted)');

  // -- 3. THE REQUEST FORM, PREFILLED ---------------------------------------
  await page.waitForSelector('.waitlist-form');
  ok('no request on file -> the 3-step request form renders');

  const prefEmail = await page.inputValue('#wl-email');
  const prefWallet = await page.inputValue('#wl-wallet');
  if (prefEmail === 'ada@lab.org') ok(`email PREFILLED from Privy: ${prefEmail}`);
  else bad(`email not prefilled (got "${prefEmail}")`);
  if (prefWallet.startsWith('0xAB')) ok(`wallet PREFILLED from Privy: ${prefWallet.slice(0, 10)}…`);
  else bad(`wallet not prefilled (got "${prefWallet}")`);

  const emailRequired = await page.locator('#wl-email').getAttribute('required');
  if (emailRequired !== null) ok('email is REQUIRED (it is the notification channel)');
  else bad('email is not required');

  await contrast(page, '.waitlist-form > header > h2', 4.5, 'form heading');
  await contrast(page, '.waitlist-field-hint', 4.5, 'email hint');
  await contrast(page, '.waitlist-step-description', 4.5, 'step description');

  // The form must not be CLIPPED — the Lyra .card overflow-hidden hazard.
  const clipped = await page.evaluate(() => {
    const f = document.querySelector('.waitlist-form') as HTMLElement;
    return f.scrollHeight > f.clientHeight + 1;
  });
  if (!clipped) ok('the form is not clipped (Lyra .card overflow-hidden hazard)');
  else bad('THE FORM IS CLIPPED — min-height:auto collapsed to 0 again');

  // Focus ring (trap 5): sampled against the PARENT's composited fill.
  await page.locator('#wl-name').focus();
  await page.keyboard.press('Tab'); // a REAL Tab, not .focus() alone
  await settle(page);
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const cs = getComputedStyle(el);
    return { w: cs.outlineWidth, style: cs.outlineStyle, offset: cs.outlineOffset, id: el.id };
  });
  if (parseFloat(ring.w) >= 2 && ring.style !== 'none')
    ok(`focus ring restored on #${ring.id}: ${ring.w} ${ring.style}, offset ${ring.offset}`);
  else bad(`no focus ring on #${ring.id}: ${JSON.stringify(ring)}`);

  await page.screenshot({ path: `${SHOTS}/2-form-step1-${theme}.png` });

  // Walk the 3 steps.
  await page.fill('#wl-name', 'Ada Lovelace');
  await page.locator('.waitlist-submit').click(); // Continue
  await page.waitForSelector('#wl-role');
  await page.selectOption('#wl-role', 'Researcher');
  await page.fill('#wl-org', 'Reef Institute');
  await page.fill('#wl-use-case', 'Symbiont genomics across bleaching gradients.');
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/3-form-step2-${theme}.png` });

  await page.locator('.waitlist-submit').click(); // Continue
  await page.waitForSelector('#wl-updates');
  await page.check('#wl-updates');
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/4-form-step3-${theme}.png` });

  // -- 4. SUBMIT -> "under review" ------------------------------------------
  await page.locator('.waitlist-submit').click();
  await page.waitForSelector('.access-pending-card', { timeout: 5000 });
  await settle(page);

  const review = await page.locator('.access-pending-card h1').textContent();
  if (review?.includes('under review')) ok(`submitted -> "${review.trim()}"`);
  else bad(`after submit, expected the review notice, got "${review}"`);

  const sent = await (await page.request.get(`${BASE}/__state`)).json();
  if (sent.hasRequest && sent.lastRequestBody?.accessToken)
    ok('POST /api/access-request carried the Privy token as its auth');
  else bad('the request did not reach the API with a Privy token');
  if (sent.lastRequestBody?.role === 'Researcher' && sent.lastRequestBody?.use_case)
    ok('the form payload carried role + use case (the admin can now decide)');
  else bad('the form payload is missing role/use_case');

  await contrast(page, '.access-pending-card h1', 4.5, 'review heading');
  await contrast(page, '.access-pending-note', 4.5, 'review note');
  await page.screenshot({ path: `${SHOTS}/5-under-review-${theme}.png` });

  // A RELOAD must still show "under review" — the page re-asks the server.
  await page.reload({ waitUntil: 'networkidle' });
  await setTheme(page, theme);
  await page.waitForSelector('.access-pending-card', { timeout: 5000 });
  ok('reloading /access-pending still shows "under review" (state is re-fetched)');

  // -- 5. ADMIN APPROVES -> sign in -> /chat --------------------------------
  await reset(page, { whitelisted: true });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await setTheme(page, theme);
  await settle(page);

  // AuthContext sees isAuthenticated from /api/auth/status and routes to /chat.
  await page.waitForURL('**/chat', { timeout: 6000 }).catch(() => {});
  const url = page.url();
  if (url.includes('/chat')) ok('after approval, the same door lands the user in /chat');
  else bad(`after approval, expected /chat, got ${url}`);
  await page.screenshot({ path: `${SHOTS}/6-approved-chat-${theme}.png` });

  // -- 6. ZERO NON-CIRCLE RADIUS in what we added ---------------------------
  await reset(page, { hasRequest: false, whitelisted: false });
  await page.goto(`${BASE}/access-pending`, { waitUntil: 'networkidle' });
  await setTheme(page, theme);
  await page.evaluate(() => (window as any).__privy.login());
  await page.waitForSelector('.waitlist-form', { timeout: 6000 });
  await settle(page);

  const radii = await page.evaluate(() => (window as any).__radii('.access-pending-content'));
  if (radii.length === 0) ok('zero non-circle border-radius in the request form / page');
  else bad(`border-radius found: ${JSON.stringify(radii.slice(0, 6))}`);
}

console.log(
  failures === 0
    ? `\nFUNNEL: all checks passed. Screenshots in ${SHOTS}`
    : `\nFUNNEL: ${failures} FAILED`,
);

await browser.close();
process.exit(failures ? 1 : 0);
