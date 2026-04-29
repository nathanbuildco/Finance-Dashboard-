import crypto from "node:crypto";

export const AUTH_COOKIE = "dashboard_auth";

export function expectedToken(): string | null {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) return null;
  return crypto.createHmac("sha256", pw).update("authed").digest("hex");
}

export function isValidToken(token: string | undefined): boolean {
  if (!token) return false;
  const expected = expectedToken();
  if (!expected || token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}
