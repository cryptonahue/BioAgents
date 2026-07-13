#!/usr/bin/env bun
/**
 * Builds the REAL client with `@privy-io/react-auth` aliased to a stub, then
 * serves it with a stubbed API, so the whole access funnel can be driven in a
 * real browser.
 *
 *     bun scripts/verify-access-flow/harness.ts        # serve on :4599
 *
 * WHAT IS REAL: the routing, `AuthContext`/`exchangePrivyToken`, LandingPage,
 * AccessPendingPage, AccessRequestForm, `waitlistSteps`, the whole CSS bundle
 * (Tailwind + Basecoat + Lyra + theme.css + coralgpt.css), and the theme toggle.
 *
 * WHAT IS STUBBED: Privy itself (a hosted identity provider — `login()` opens
 * THEIR modal against a real app id and returns a token signed by THEIR keys;
 * there is no honest way to fake that at the network layer, so it is faked at
 * the module seam the app depends on), and the API responses.
 *
 * The API stub is stateful: it remembers whether the user has submitted a
 * request and whether an admin has approved them, so the funnel really does
 * advance from screen to screen rather than each screen being posed.
 */

import { join, resolve } from 'path';
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'fs';
import tailwind from 'bun-plugin-tailwind';

const root = resolve(import.meta.dir, '../..');
const clientDir = join(root, 'client');
const outDir = join(import.meta.dir, 'dist');

mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(clientDir, 'src/index.jsx')],
  outdir: outDir,
  minify: false,
  target: 'browser',
  sourcemap: 'none',
  splitting: false,
  define: {
    // A module-scope client throws on boot without these. The harness never
    // reaches Supabase (every /api/* call is stubbed), so they only need to be
    // well-formed, not real.
    'process.env.SUPABASE_URL': JSON.stringify('http://localhost:9/stub'),
    'process.env.SUPABASE_ANON_KEY': JSON.stringify('stub-anon-key'),
    'process.env.APP_VERSION': JSON.stringify('harness'),
    'process.env.GIT_SHA': JSON.stringify('harness'),
    'process.env.BUILD_DATE': JSON.stringify(new Date().toISOString()),
    'import.meta.env.CDP_PROJECT_ID': JSON.stringify('harness'),
    'import.meta.env.PRIVY_APP_ID': JSON.stringify('harness-app'),
    // The hero <video> will not decode in headless Chromium anyway; point it at
    // nothing so it fails fast and falls back to its poster.
    'import.meta.env.CORALGPT_HERO_VIDEO_URL': JSON.stringify(''),
  },
  plugins: [
    tailwind,
    {
      name: 'harness-aliases',
      setup(build) {
        const nm = resolve(root, 'node_modules');
        const compat = resolve(nm, 'preact', 'compat', 'dist', 'compat.module.js');
        const jsx = resolve(nm, 'preact', 'jsx-runtime', 'dist', 'jsxRuntime.module.js');

        build.onResolve({ filter: /^react$/ }, () => ({ path: compat }));
        build.onResolve({ filter: /^react-dom$/ }, () => ({ path: compat }));
        build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: jsx }));
        // The real build minifies, which makes Bun pick React's PRODUCTION jsx
        // runtime — so `client/build.ts` never needs this alias. The harness
        // builds unminified for readable stack traces, which pulls
        // `react/jsx-dev-runtime` instead. Unaliased, that reaches real React and
        // dies on `undefined.bind(...)` before the app ever mounts.
        build.onResolve({ filter: /^react\/jsx-dev-runtime$/ }, () => ({ path: jsx }));

        // THE SEAM. Everything above it is the real app.
        build.onResolve({ filter: /^@privy-io\/react-auth$/ }, () => ({
          path: join(import.meta.dir, 'privy-stub.tsx'),
        }));
      },
    },
  ],
});

if (!result.success) {
  console.error('harness build failed');
  for (const m of result.logs) console.error(m);
  process.exit(1);
}

// Reuse the real index.html + the real static assets (fonts, images).
writeFileSync(
  join(outDir, 'index.html'),
  readFileSync(join(clientDir, 'public/index.html'), 'utf-8'),
);
const distAssets = join(outDir, 'assets');
cpSync(join(clientDir, 'public'), distAssets, { recursive: true });
const realDistFonts = join(clientDir, 'dist/assets/fonts');
if (existsSync(realDistFonts)) {
  cpSync(realDistFonts, join(distAssets, 'fonts'), { recursive: true });
}

// ---------------------------------------------------------------------------
// The stubbed API. STATEFUL — the funnel really advances.
// ---------------------------------------------------------------------------

const state = {
  hasRequest: false,
  whitelisted: false,
  lastRequestBody: null as any,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const server = Bun.serve({
  port: 4713,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // --- test control plane (not part of the app) ---
    if (path === '/__state') {
      if (req.method === 'POST') {
        Object.assign(state, await req.json());
        return json(state);
      }
      return json(state);
    }

    // --- the real API surface the pages call ---
    if (path === '/api/auth/status') {
      return json({
        isAuthRequired: true,
        // The harness never mints a JWT; `whitelisted` drives the app instead.
        isAuthenticated: state.whitelisted,
        userId: state.whitelisted ? 'u-1' : null,
        coralGptEnabled: true,
        privyAppId: 'harness-app',
      });
    }

    if (path === '/api/auth/config') {
      return json({
        coralGptEnabled: true,
        privyAppId: 'harness-app',
        isAuthRequired: true,
      });
    }

    if (path === '/api/auth/privy' && req.method === 'POST') {
      if (state.whitelisted) {
        return json({
          success: true,
          whitelisted: true,
          // A well-formed JWT so `decodeJWTPayload` in AuthContext is happy.
          token: `${btoa('{"alg":"HS256"}')}.${btoa('{"sub":"u-1","email":"ada@lab.org"}')}.sig`,
          userId: 'u-1',
          email: 'ada@lab.org',
          expiresIn: 86400,
        });
      }
      // THE 403 — now carrying the state the client needs.
      return json(
        {
          success: false,
          whitelisted: false,
          hasRequest: state.hasRequest,
          email: 'ada@lab.org',
          walletAddress: '0xAB0000000000000000000000000000000000CDEF',
          message: 'Access pending approval',
        },
        403,
      );
    }

    if (path === '/api/access-request' && req.method === 'POST') {
      state.lastRequestBody = await req.json();
      state.hasRequest = true;
      return json({ success: true, status: 'pending' });
    }

    if (path.startsWith('/api/')) return json({ ok: true });

    // --- static ---
    let file = path === '/' ? '/index.html' : path;
    let candidate = join(outDir, file);
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      const f = Bun.file(candidate);
      if (await f.exists()) return new Response(f);
    }
    // SPA fallback — /access-pending etc. are client routes.
    return new Response(Bun.file(join(outDir, 'index.html')), {
      headers: { 'Content-Type': 'text/html' },
    });
  },
});

console.log(`harness on http://localhost:${server.port}`);
