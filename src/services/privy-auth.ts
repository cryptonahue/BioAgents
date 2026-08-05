import { PrivyClient } from "@privy-io/server-auth";
import logger from "../utils/logger";

let privyClient: PrivyClient | null = null;

export function getPrivyClient(): PrivyClient | null {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;

  if (!appId || !appSecret) {
    return null;
  }

  if (!privyClient) {
    privyClient = new PrivyClient(appId, appSecret);
  }

  return privyClient;
}

export function isPrivyConfigured(): boolean {
  return !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

export function isCoralGptEnabled(): boolean {
  return isPrivyConfigured();
}

export async function verifyPrivyAccessToken(token: string) {
  const client = getPrivyClient();
  if (!client) {
    throw new Error("Privy is not configured");
  }

  try {
    const claims = await client.verifyAuthToken(token);
    logger.info({ userId: claims.userId }, "privy_token_verified");
    return claims;
  } catch (error: any) {
    logger.warn({ error: error.message }, "privy_token_verification_failed");
    throw error;
  }
}

export async function fetchPrivyUser(privyUserId: string) {
  const client = getPrivyClient();
  if (!client) {
    throw new Error("Privy is not configured");
  }

  return client.getUser(privyUserId);
}
