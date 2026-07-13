// Must be first - polyfills for pdf-parse/pdfjs-dist
import "./utils/canvas-polyfill";

import path from "node:path";

import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { artifactsRoute } from "./routes/artifacts";
import { libraryRoute } from "./routes/library";
import { researchBrainRoute } from "./routes/research-brain";
import { researchBrainGraphRoute } from "./routes/research-brain-graph";
import { researchBrainCitationsRoute } from "./routes/research-brain-citations";
import { tableMergesRoute } from "./routes/admin/table-merges";
import { authRoute } from "./routes/auth";
import { chatRoute } from "./routes/chat";
import { conversationsRoute } from "./routes/conversations";
import { clarificationRoute } from "./routes/clarification";
import { deepResearchStartRoute } from "./routes/deep-research/start";
import { deepResearchStatusRoute } from "./routes/deep-research/status";
import { deepResearchPaperRoute } from "./routes/deep-research/paper";
import { deepResearchBranchRoute } from "./routes/deep-research/branch";
import { deepResearchDiscoveriesRoute } from "./routes/deep-research/discoveries";
import { filesRoute } from "./routes/files";
import { x402Route } from "./routes/x402";
import { x402ChatRoute } from "./routes/x402/chat";
import { x402DeepResearchRoute } from "./routes/x402/deep-research";
import { x402IndividualAgentsRoute } from "./routes/x402/agents";
import { initializeX402Service } from "./middleware/x402/service";
import { b402Route } from "./routes/b402";
import { b402ChatRoute } from "./routes/b402/chat";
import { b402DeepResearchRoute } from "./routes/b402/deep-research";
import logger from "./utils/logger";

// BullMQ Queue imports (conditional)
import { isJobQueueEnabled, closeConnections } from "./services/queue/connection";
import { websocketHandler, cleanupDeadConnections } from "./services/websocket/handler";
import { startRedisSubscription, stopRedisSubscription } from "./services/websocket/subscribe";
import { waitlistRoute } from "./routes/waitlist";
import { createQueueDashboard } from "./routes/admin/queue-dashboard";
import { adminJobsRoute } from "./routes/admin/jobs";
import { costTotalsRoute } from "./routes/admin/cost-totals";
import { whitelistRoute } from "./routes/admin/whitelist";
import { versionRoute } from "./routes/version";

// ============================================================================
// CORS Configuration - Security Critical
// ============================================================================
// Set ALLOWED_ORIGINS env var in production: comma-separated list of allowed origins
// Example: ALLOWED_ORIGINS=https://bioagent-platform.bioagents.dev,https://app.bioagents.xyz
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
];

const ALLOWED_ORIGINS: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

// Log CORS configuration on startup
if (process.env.NODE_ENV === "production" && !process.env.ALLOWED_ORIGINS) {
  logger.warn(
    { defaultOrigins: DEFAULT_ALLOWED_ORIGINS },
    "cors_security_warning: ALLOWED_ORIGINS not set in production - using localhost defaults only. Set ALLOWED_ORIGINS env var for production domains."
  );
} else {
  logger.info({ allowedOrigins: ALLOWED_ORIGINS }, "cors_configuration");
}

/**
 * CORS origin validator
 * - Allows same-origin requests (no Origin header)
 * - Allows requests from whitelisted origins
 * - Rejects and logs requests from unknown origins
 */
function validateCorsOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  // Allow requests with no origin (same-origin, curl, server-to-server)
  if (!origin) {
    return true;
  }

  // Check against whitelist
  if (ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }

  // Log rejected origin for security monitoring
  logger.warn({ origin, allowedOrigins: ALLOWED_ORIGINS }, "cors_origin_rejected");
  return false;
}

const app = new Elysia()
  // WebSocket handler for real-time notifications (when job queue enabled)
  .use(websocketHandler)
  // Enable CORS with origin whitelist
  .use(
    cors({
      origin: validateCorsOrigin,
      credentials: true,
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "X-Requested-With",
        "X-PAYMENT", // x402 v1 payment proof header (b402 compatibility)
        "PAYMENT-SIGNATURE", // x402 v2 payment proof header
      ],
      exposeHeaders: [
        "Content-Type",
        "X-PAYMENT-RESPONSE", // x402 v1 settlement response (b402 compatibility)
        "PAYMENT-RESPONSE", // x402 v2 settlement response header
        "PAYMENT-REQUIRED", // x402 v2 payment required header
      ],
      maxAge: 86400, // Cache preflight for 24 hours
    }),
  )

  // ============================================================================
  // Security Headers
  // ============================================================================
  .onBeforeHandle(({ set }) => {
    // Prevent MIME-type sniffing attacks
    set.headers["X-Content-Type-Options"] = "nosniff";

    // Prevent clickjacking (iframe embedding)
    set.headers["X-Frame-Options"] = "DENY";

    // Enable browser XSS filter (legacy browsers)
    set.headers["X-XSS-Protection"] = "1; mode=block";

    // Control referrer information leakage
    set.headers["Referrer-Policy"] = "strict-origin-when-cross-origin";

    // Disable unnecessary browser features
    set.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()";

    // Force HTTPS in production (only enable if you have valid SSL)
    if (process.env.NODE_ENV === "production") {
      set.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
    }
  })

  // Basic request logging
  .onRequest(({ request }) => {
    if (!logger) return;
    logger.info(
      { method: request.method, url: request.url },
      "incoming_request",
    );
  })
  .onError(({ code, error }) => {
    if (!logger) return;
    logger.error({ code, err: error }, "unhandled_error");
  })

  // Mount auth routes (no protection needed for auth endpoints)
  .use(authRoute)
  .use(waitlistRoute)

  // Note: We always serve UI files regardless of auth status
  // The frontend (useAuth hook) will check /api/auth/status and show login screen if needed
  // This allows the login UI to render properly

  // Serve the Preact UI (from client/dist) with SEO metadata injection
  .get("/", async () => {
    const htmlFile = Bun.file("client/dist/index.html");
    let htmlContent = await htmlFile.text();

    // Inject SEO metadata from environment variables
    const seoTitle =
      process.env.SEO_TITLE ||
      (process.env.PRIVY_APP_ID ? "CoralGPT — AI Scientist for Coral Reefs" : "BioAgents Chat");
    const seoDescription =
      process.env.SEO_DESCRIPTION ||
      (process.env.PRIVY_APP_ID
        ? "Ask questions, run deep research, and discover evidence-backed insights about coral health, bleaching, and restoration. BioAgent powered by $CRLAI."
        : "AI-powered chat interface");
    const faviconUrl = process.env.FAVICON_URL || "/images/favicon.png";
    const ogImageUrl =
      process.env.OG_IMAGE_URL || "https://bioagents.xyz/og-image.png";

    htmlContent = htmlContent
      .replace(/\{\{SEO_TITLE\}\}/g, seoTitle)
      .replace(/\{\{SEO_DESCRIPTION\}\}/g, seoDescription)
      .replace(/\{\{FAVICON_URL\}\}/g, faviconUrl)
      .replace(/\{\{OG_IMAGE_URL\}\}/g, ogImageUrl);

    return new Response(htmlContent, {
      headers: {
        "Content-Type": "text/html",
        // Stable-URL entry point whose content changes on every deploy.
        // no-cache = must revalidate before use, so Cloudflare/browser
        // can't serve a stale bundle after a deploy (this was causing
        // old UI to persist for hours behind Cloudflare's edge cache).
        "Cache-Control": "no-cache",
      },
    });
  })

  // Serve the bundled Preact app JS file
  .get("/index.js", () => {
    return new Response(Bun.file("client/dist/index.js"), {
      headers: {
        "Content-Type": "application/javascript",
        // Stable filename, content changes per deploy — force
        // revalidation (Bun sets Last-Modified, so unchanged = cheap
        // 304). Prevents Cloudflare from pinning an old bundle.
        "Cache-Control": "no-cache",
      },
    });
  })

  // Serve the pdfjs-dist worker used by the PDF provenance viewer.
  // The frontend bundle imports `pdfjs-dist/build/pdf.mjs` and sets
  // `GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs"` (see
  // `client/src/lib/pdfjs.ts`). We pin the standard build, not the
  // legacy build, because the viewer needs the worker for
  // responsive rendering on multi-page research PDFs.
  .get("/pdfjs/pdf.worker.mjs", () => {
    return new Response(
      Bun.file("node_modules/pdfjs-dist/build/pdf.worker.mjs"),
      {
        headers: {
          // Workers must be served as JS for the browser to execute
          // them; `.mjs` keeps the import/export semantics intact.
          "Content-Type": "application/javascript",
          // The worker bundle is large but stable; cache it for one
          // day at the edge. The frontend bundle re-references the
          // same URL across page loads, so this saves a round-trip
          // on every viewer open.
          "Cache-Control": "public, max-age=86400",
        },
      },
    );
  })

  // Serve the bundled CSS file
  .get("/index.css", () => {
    return new Response(Bun.file("client/dist/index.css"), {
      headers: {
        "Content-Type": "text/css",
        // Same reasoning as /index.js — revalidate so deploys aren't
        // masked by Cloudflare's edge cache.
        "Cache-Control": "no-cache",
      },
    });
  })

  // Serve static UI images (welcome background, etc.)
  // Images live under client/dist/assets/images/ after build:client runs.
  .get("/images/*", async ({ request }) => {
    const url = new URL(request.url);
    const filePath = `client/dist/assets${url.pathname}`;
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }
    const ext = url.pathname.split(".").pop()?.toLowerCase();
    const contentType =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "webp"
            ? "image/webp"
            : ext === "svg"
              ? "image/svg+xml"
              : ext === "gif"
                ? "image/gif"
                : "application/octet-stream";
    return new Response(file, { headers: { "Content-Type": contentType } });
  })

  // Serve bundled assets (videos, fonts, future static files from client/public/*)
  // Supports HTTP Range requests so <video>/<audio> can seek.
  .get("/assets/*", async ({ request }) => {
    const url = new URL(request.url);
    const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    if (!safePath.startsWith("/assets/")) {
      return new Response("Forbidden", { status: 403 });
    }
    const relative = safePath.replace(/^\/assets\//, "");
    const filePath = path.join("client/dist/assets", relative);
    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response("Not Found", { status: 404 });
    }
    const ext = relative.split(".").pop()?.toLowerCase() ?? "";
    const contentType =
      ext === "mp4" ? "video/mp4"
      : ext === "webm" ? "video/webm"
      : ext === "mov" ? "video/quicktime"
      : ext === "ogv" ? "video/ogg"
      : ext === "ogg" ? "audio/ogg"
      : ext === "mp3" ? "audio/mpeg"
      : ext === "wav" ? "audio/wav"
      : ext === "png" ? "image/png"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
      : ext === "svg" ? "image/svg+xml"
      : ext === "woff" ? "font/woff"
      : ext === "woff2" ? "font/woff2"
      : ext === "ttf" ? "font/ttf"
      : ext === "otf" ? "font/otf"
      : "application/octet-stream";

    const rangeHeader = request.headers.get("range");
    if (!rangeHeader) {
      return new Response(file, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=3600",
          "Accept-Ranges": "bytes",
        },
      });
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      return new Response("Malformed Range", { status: 416 });
    }
    const start = match[1] === "" ? null : Number(match[1]);
    const end = match[2] === "" ? null : Number(match[2]);
    const total = file.size;
    const rangeStart = start ?? Math.max(0, total - (end ?? 0));
    const rangeEnd = end ?? (start != null ? total - 1 : total - 1);
    if (rangeStart >= total || rangeEnd >= total || rangeStart > rangeEnd) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${total}` },
      });
    }
    const slice = file.slice(rangeStart, rangeEnd + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(rangeEnd - rangeStart + 1),
        "Content-Range": `bytes ${rangeStart}-${rangeEnd}/${total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
      },
    });
  })

  // Serve source map for debugging
  .get("/index.js.map", () => {
    return new Response(Bun.file("client/dist/index.js.map"), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  })

  // Handle favicon (prevent 404 errors)
  .get("/favicon.ico", () => {
    return new Response(null, { status: 204 });
  })

  // Health check endpoint with optional queue/Redis status
  .get("/api/health", async () => {
    if (logger) logger.info("Health check endpoint hit");

    const health: {
      status: string;
      timestamp: string;
      jobQueue?: {
        enabled: boolean;
        redis?: string;
      };
    } = {
      status: "ok",
      timestamp: new Date().toISOString(),
    };

    // Add job queue status if enabled
    if (isJobQueueEnabled()) {
      try {
        const { getBullMQConnection } = await import("./services/queue/connection");
        const redis = getBullMQConnection();
        await redis.ping();
        health.jobQueue = {
          enabled: true,
          redis: "connected",
        };
      } catch (error) {
        health.jobQueue = {
          enabled: true,
          redis: "disconnected",
        };
        health.status = "degraded";
      }
    } else {
      health.jobQueue = {
        enabled: false,
      };
    }

    return health;
  })

  // Suppress Chrome DevTools 404 error
  .get("/.well-known/appspecific/com.chrome.devtools.json", () => {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  })

  // API routes (not protected by UI auth)
  .use(chatRoute) // GET and POST /api/chat for agent-based chat
  .use(conversationsRoute) // GET /api/conversations/* for authenticated, user-scoped chat history reads
  .use(clarificationRoute) // GET and POST /api/clarification/* for pre-research clarification
  .use(deepResearchStartRoute) // GET and POST /api/deep-research/start for deep research
  .use(deepResearchStatusRoute) // GET /api/deep-research/status/:messageId to check status
  .use(deepResearchBranchRoute) // POST /api/deep-research/branch to fork a conversation with copied state
  .use(deepResearchPaperRoute) // POST /api/deep-research/conversations/:conversationId/paper for paper generation
  .use(deepResearchDiscoveriesRoute) // GET /api/deep-research/conversations/:conversationId/discoveries (discovery-persistence v1, PR #2)
  .use(artifactsRoute) // GET /api/artifacts/download for artifact downloads
  .use(libraryRoute) // GET/POST /api/library/* for paper library + per-paper Q&A
  .use(researchBrainRoute) // GET/POST /api/research-brain/* for evidence-first Research Brain
  .use(researchBrainGraphRoute) // GET /api/research-brain/graph/compounds/search for v1 knowledge graph (PR #1 of bioprospecting-knowledge-graph)
  .use(researchBrainCitationsRoute) // GET /api/research-brain/citations/:sourceId for paper-to-paper related-work graph (LLM-free)
  .use(tableMergesRoute) // POST/DELETE/GET /api/research-brain/tables/* for admin table-merge overrides (PR #3 of bioprospecting-multipage-table-merge)
  .use(filesRoute) // POST /api/files/* for direct S3 file uploads
  .use(versionRoute) // GET /api/version for build metadata (version, sha, buildDate)

  // x402 payment routes - Base (USDC)
  .use(x402Route) // GET /api/x402/* for config, pricing, payments, health
  .use(x402ChatRoute) // POST /api/x402/chat for payment-gated chat
  .use(x402DeepResearchRoute) // POST /api/x402/deep-research/start, GET /api/x402/deep-research/status/:messageId
  .use(x402IndividualAgentsRoute) // POST /api/x402/agents/* for individual agent access

  // b402 payment routes - BNB Chain (USDT)
  .use(b402Route) // GET /api/b402/* for config, pricing, health
  .use(b402ChatRoute) // POST /api/b402/chat for payment-gated chat
  .use(b402DeepResearchRoute); // POST /api/b402/deep-research/start, GET /api/b402/deep-research/status/:messageId

// Mount Bull Board dashboard (only when the job queue is enabled AND an admin
// password is configured). Fail closed: no ADMIN_PASSWORD -> dashboard is not
// mounted, so job internals are never served unauthenticated.
const queueDashboard = createQueueDashboard();
if (queueDashboard) {
  const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

  if (ADMIN_PASSWORD) {
    app.onBeforeHandle(({ request, set }) => {
      const url = new URL(request.url);
      
      // Only protect /admin/* routes
      if (!url.pathname.startsWith("/admin")) {
        return;
      }

      const authHeader = request.headers.get("Authorization");
      
      // Check for valid basic auth
      if (!authHeader || !authHeader.startsWith("Basic ")) {
        set.status = 401;
        set.headers["WWW-Authenticate"] = 'Basic realm="Admin Dashboard"';
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const base64Credentials = authHeader.slice(6);
        const credentials = atob(base64Credentials);
        const [username, password] = credentials.split(":");

        if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
          logger.warn({ path: url.pathname }, "admin_dashboard_invalid_credentials");
          set.status = 401;
          set.headers["WWW-Authenticate"] = 'Basic realm="Admin Dashboard"';
          return new Response("Unauthorized", { status: 401 });
        }
      } catch {
        set.status = 401;
        set.headers["WWW-Authenticate"] = 'Basic realm="Admin Dashboard"';
        return new Response("Unauthorized", { status: 401 });
      }
    });
    app.use(queueDashboard);
    logger.info({ path: "/admin/queues", authEnabled: true }, "bull_board_dashboard_mounted_with_auth");
  } else {
    // Fail closed: never expose the job dashboard unauthenticated. Without a
    // password the dashboard is not mounted at all.
    logger.warn(
      { path: "/admin/queues" },
      "bull_board_dashboard_disabled: set ADMIN_PASSWORD to enable the admin dashboard",
    );
  }
}

// Mount admin jobs API (for frontend dashboard)
app.use(adminJobsRoute);

// Mount admin cost-totals drill-down (api-cost-guard-rails PR #3)
app.use(costTotalsRoute);

// Mount admin whitelist manager. Grants/revokes CoralGPT access
// (users.access_type). Admin-only — see the header of the route.
app.use(whitelistRoute);

// Continue with catch-all route
app
  // Catch-all route for SPA client-side routing
  // This handles routes like /chat, /settings, etc. and serves the main UI
  // The client-side router will handle the actual routing
  // Excludes /api/* and /admin/* paths
  .get("*", async ({ request }) => {
    const url = new URL(request.url);

    // Don't intercept /admin/* routes (Bull Board)
    if (url.pathname.startsWith("/admin")) {
      return new Response("Not Found", { status: 404 });
    }

    const htmlFile = Bun.file("client/dist/index.html");
    let htmlContent = await htmlFile.text();

    // Inject SEO metadata from environment variables
    const seoTitle =
      process.env.SEO_TITLE ||
      (process.env.PRIVY_APP_ID ? "CoralGPT — AI Scientist for Coral Reefs" : "BioAgents Chat");
    const seoDescription =
      process.env.SEO_DESCRIPTION ||
      (process.env.PRIVY_APP_ID
        ? "Ask questions, run deep research, and discover evidence-backed insights about coral health, bleaching, and restoration. BioAgent powered by $CRLAI."
        : "AI-powered chat interface");
    const faviconUrl = process.env.FAVICON_URL || "/images/favicon.png";
    const ogImageUrl =
      process.env.OG_IMAGE_URL || "https://bioagents.xyz/og-image.png";

    htmlContent = htmlContent
      .replace(/\{\{SEO_TITLE\}\}/g, seoTitle)
      .replace(/\{\{SEO_DESCRIPTION\}\}/g, seoDescription)
      .replace(/\{\{FAVICON_URL\}\}/g, faviconUrl)
      .replace(/\{\{OG_IMAGE_URL\}\}/g, ogImageUrl);

    return new Response(htmlContent, {
      headers: {
        "Content-Type": "text/html",
        // SPA fallback also serves the entry HTML — keep it revalidated
        // so client-route deep links never serve a stale shell.
        "Cache-Control": "no-cache",
      },
    });
  });

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const hostname = process.env.HOST || "0.0.0.0"; // Bind to all interfaces for Docker/Coolify

// Log startup configuration
const isProduction = process.env.NODE_ENV === "production";
const hasSecret = !!process.env.BIOAGENTS_SECRET;

app.listen(
  {
    port,
    hostname,
  },
  async () => {
    if (logger) {
      logger.info({ url: `http://${hostname}:${port}` }, "server_listening");
      logger.info(
        {
          nodeEnv: process.env.NODE_ENV || "development",
          isProduction,
          authRequired: isProduction,
          secretConfigured: hasSecret,
          jobQueueEnabled: isJobQueueEnabled(),
        },
        "auth_configuration",
      );
    } else {
      console.log(`Server listening on http://${hostname}:${port}`);
      console.log(
        `Auth config: NODE_ENV=${process.env.NODE_ENV}, production=${isProduction}, secretConfigured=${hasSecret}`,
      );
      console.log(`Job queue: ${isJobQueueEnabled() ? "enabled" : "disabled"}`);
    }

    // Initialize x402 payment service (validates CDP auth if configured)
    try {
      await initializeX402Service();
    } catch (error) {
      if (logger) {
        logger.error({ error }, "x402_initialization_failed");
      } else {
        console.error("x402 initialization failed:", error);
      }
      // Don't exit - server can still run, just x402 payments will fail
    }

    // Start Redis subscription for WebSocket notifications if job queue is enabled
    if (isJobQueueEnabled()) {
      try {
        await startRedisSubscription();
        if (logger) {
          logger.info("websocket_redis_subscription_started");
        } else {
          console.log("WebSocket Redis subscription started");
        }
      } catch (error) {
        if (logger) {
          logger.error({ error }, "websocket_redis_subscription_failed");
        } else {
          console.error("Failed to start WebSocket Redis subscription:", error);
        }
      }

      // Periodic cleanup of dead WebSocket connections (every 30 seconds)
      setInterval(() => {
        cleanupDeadConnections();
      }, 30000);
    }
  },
);

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  if (logger) {
    logger.info({ signal }, "graceful_shutdown_initiated");
  } else {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
  }

  try {
    // Stop Redis subscription
    if (isJobQueueEnabled()) {
      await stopRedisSubscription();
      await closeConnections();
      if (logger) {
        logger.info("redis_connections_closed");
      } else {
        console.log("Redis connections closed");
      }
    }

    process.exit(0);
  } catch (error) {
    if (logger) {
      logger.error({ error }, "graceful_shutdown_error");
    } else {
      console.error("Error during shutdown:", error);
    }
    process.exit(1);
  }
}

// Register shutdown handlers
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
