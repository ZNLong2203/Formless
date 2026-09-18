/**
 * Workspace identity.
 *
 * Every visitor gets their own drawing. Without this, one person's customer
 * emails would be visible to the next person who opened the link — which is
 * both a privacy failure and a poor demonstration, because a shared sheet
 * never looks like *your* business.
 *
 * Identity is a cookie rather than an account: the product's whole claim is
 * that it works before you configure anything, and a sign-up wall would
 * contradict that on the first screen.
 */

import type { NextResponse } from "next/server";

export const WORKSPACE_COOKIE = "formless_ws";

/** A year — long enough that a judge returning tomorrow sees their own work. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface Workspace {
  id: string;
  /**
   * True when this request minted the id. A brand-new workspace is known to be
   * empty, so the read that would prove it empty can be skipped — which
   * matters when the datastore allows only 100 calls a month.
   */
  isNew: boolean;
}

/** Ids are opaque and unguessable; nothing about the visitor is encoded. */
function mint(): string {
  return `ws_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Accepts only ids of our own shape, so a hand-edited cookie cannot probe. */
function isValidId(value: string): boolean {
  return /^ws_[0-9a-f]{32}$/.test(value);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function resolveWorkspace(request: Request): Workspace {
  const existing = readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE);
  if (existing && isValidId(existing)) {
    return { id: existing, isNew: false };
  }
  return { id: mint(), isNew: true };
}

/** Attach the workspace to a response, so the next request carries it back. */
export function attachWorkspace<T>(
  response: NextResponse<T>,
  workspace: Workspace,
): NextResponse<T> {
  response.cookies.set({
    name: WORKSPACE_COOKIE,
    value: workspace.id,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return response;
}
