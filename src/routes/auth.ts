import { Elysia, t } from "elysia";
import * as jose from "jose";
import { getOrCreatePrivyUser } from "../db/operations";
import {
  fetchPrivyUser,
  isCoralGptEnabled,
  isPrivyConfigured,
  verifyPrivyAccessToken,
} from "../services/privy-auth";
import { verifyJWT } from "../services/jwt";

const UI_PASSWORD = process.env.UI_PASSWORD || "";
const JWT_EXPIRATION = 24 * 60 * 60; // 24 hours in seconds

/**
 * Generate a JWT token for UI authentication
 * Uses BIOAGENTS_SECRET to sign the token (same secret used for API auth)
 */
async function generateAuthToken(
  userId: string,
  extraClaims?: Record<string, string>,
): Promise<string | null> {
  const secret = process.env.BIOAGENTS_SECRET;
  if (!secret) {
    console.warn("[Auth] BIOAGENTS_SECRET not configured, cannot generate JWT");
    return null;
  }

  const secretKey = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new jose.SignJWT({
    sub: userId,
    type: "ui_session",
    ...extraClaims,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_EXPIRATION)
    .sign(secretKey);

  return jwt;
}

/**
 * Generate a consistent user ID for the dev UI
 * Uses a hash of the password to ensure same user gets same ID
 */
function generateDevUserId(): string {
  // Use a fixed UUID for dev UI users - this ensures conversation persistence
  // In a real system, you'd have actual user accounts
  return "550e8400-e29b-41d4-a716-446655440000";
}

function extractWalletFromPrivyUser(user: any): string | undefined {
  const walletAccount = user.linkedAccounts?.find(
    (account: any) =>
      account.type === "wallet" ||
      account.type === "smart_wallet" ||
      account.walletClientType,
  );
  return walletAccount?.address;
}

function extractEmailFromPrivyUser(user: any): string | undefined {
  const emailAccount = user.linkedAccounts?.find(
    (account: any) => account.type === "email",
  );
  return emailAccount?.address || user.email?.address;
}

export const authRoute = new Elysia({ prefix: "/api/auth" })
  .get("/config", () => {
    return {
      coralGptEnabled: isCoralGptEnabled(),
      privyAppId: process.env.PRIVY_APP_ID || null,
      isAuthRequired: isCoralGptEnabled() || UI_PASSWORD.length > 0,
    };
  })

  .post(
    "/privy",
    async ({ body, set }) => {
      if (!isPrivyConfigured()) {
        set.status = 503;
        return { success: false, message: "Privy authentication is not configured" };
      }

      if (!process.env.BIOAGENTS_SECRET) {
        set.status = 500;
        return {
          success: false,
          message: "Server misconfigured: BIOAGENTS_SECRET required",
        };
      }

      try {
        const claims = await verifyPrivyAccessToken(body.accessToken);
        const privyUser = await fetchPrivyUser(claims.userId);
        const email = extractEmailFromPrivyUser(privyUser);
        const walletAddress = extractWalletFromPrivyUser(privyUser);

        const { user } = await getOrCreatePrivyUser({
          privyUserId: claims.userId,
          email,
          walletAddress,
        });

        const isWhitelisted = user.access_type === "whitelisted";

        if (!isWhitelisted) {
          set.status = 403;
          return {
            success: false,
            whitelisted: false,
            email: email || null,
            message: "Access pending approval",
          };
        }

        const token = await generateAuthToken(user.id, email ? { email } : undefined);
        if (!token) {
          set.status = 500;
          return { success: false, message: "Failed to generate authentication token" };
        }

        return {
          success: true,
          whitelisted: true,
          token,
          userId: user.id,
          email: email || null,
          expiresIn: JWT_EXPIRATION,
        };
      } catch (error: any) {
        set.status = 401;
        return {
          success: false,
          message: error.message || "Invalid Privy access token",
        };
      }
    },
    {
      body: t.Object({
        accessToken: t.String(),
      }),
    },
  )

  // Login endpoint - validates password and returns JWT
  .post(
    "/login",
    async ({ body, set }) => {
      // Check if BIOAGENTS_SECRET is configured (required for JWT)
      const hasSecret = !!process.env.BIOAGENTS_SECRET;

      // If no password is required, generate token anyway (for dev convenience)
      if (!UI_PASSWORD) {
        if (!hasSecret) {
          return {
            success: true,
            message: "Authentication not required (no password or secret configured)"
          };
        }

        // Generate JWT for anonymous access
        const token = await generateAuthToken(generateDevUserId());
        return {
          success: true,
          token,
          message: "Authentication not required"
        };
      }

      // Validate password
      if (body.password === UI_PASSWORD) {
        if (!hasSecret) {
          // No secret configured - can't generate JWT
          set.status = 500;
          return {
            success: false,
            message: "Server misconfigured: BIOAGENTS_SECRET required for JWT auth"
          };
        }

        // Generate JWT token
        const token = await generateAuthToken(generateDevUserId());
        if (!token) {
          set.status = 500;
          return { success: false, message: "Failed to generate authentication token" };
        }

        return {
          success: true,
          token,
          expiresIn: JWT_EXPIRATION
        };
      }

      // Invalid password
      set.status = 401;
      return { success: false, message: "Invalid password" };
    },
    {
      body: t.Object({
        password: t.String(),
      }),
    }
  )

  // Logout endpoint - client should clear stored token
  .post("/logout", () => {
    // JWT tokens are stateless - client just needs to delete them
    // No server-side state to clear
    return { success: true };
  })

  // Check auth status - validates JWT if provided
  .get("/status", async ({ headers }) => {
    const isAuthRequired = isCoralGptEnabled() || UI_PASSWORD.length > 0;

    // Check for JWT in Authorization header
    const authHeader = headers.authorization;
    let isAuthenticated = false;
    let userId: string | null = null;

    if (authHeader) {
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : authHeader;

      const result = await verifyJWT(token);
      if (result.valid && result.payload) {
        isAuthenticated = true;
        userId = result.payload.sub;
      }
    }

    // If no auth required, always authenticated
    if (!isAuthRequired) {
      isAuthenticated = true;
    }

    return {
      isAuthRequired,
      isAuthenticated,
      userId,
      coralGptEnabled: isCoralGptEnabled(),
      privyAppId: process.env.PRIVY_APP_ID || null,
    };
  });
