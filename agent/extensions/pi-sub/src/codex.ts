/**
 * Codex (`openai-codex`) quota interpretation.
 *
 * Response shape knowledge (`rate_limit.primary_window` / `secondary_window`
 * with `used_percent` and `reset_at` in Unix seconds) comes from the audited
 * MIT-licensed `@bacnh85/pi-sub`; the code here is written from scratch.
 */

import {
  type QuotaRequestOptions,
  type QuotaResult,
  requestUsageJson,
  resolveApiKey,
  SIGN_IN_REQUIRED,
  UNEXPECTED_RESPONSE,
} from "./http.ts";
import {
  asRecord,
  remainingFromUsedPercent,
  resetFromUnixSeconds,
  type Quota,
  type QuotaWindow,
  type WindowKind,
} from "./quota.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Claim namespace carrying the ChatGPT account of an access token. */
const AUTH_CLAIM = "https://api.openai.com/auth";

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Known rate limit windows, in presentation order. */
const WINDOWS: ReadonlyArray<readonly [field: string, kind: WindowKind]> = [
  ["primary_window", "5h"],
  ["secondary_window", "weekly"],
];

/** Quota from a Codex usage response, or undefined when nothing is usable. */
export function parseCodexQuota(body: unknown): Quota | undefined {
  const rateLimit = asRecord(asRecord(body)?.rate_limit);
  if (!rateLimit) return undefined;

  const windows: QuotaWindow[] = [];
  for (const [field, kind] of WINDOWS) {
    const window = asRecord(rateLimit[field]);
    if (!window) continue;

    const remainingPercent = remainingFromUsedPercent(window.used_percent);
    if (remainingPercent === undefined) continue;

    windows.push({ kind, remainingPercent, resetsAt: resetFromUnixSeconds(window.reset_at) });
  }

  return windows.length > 0 ? { provider: "openai-codex", windows } : undefined;
}

/** Read the Codex quota, or report why it is unavailable. No credential means no request. */
export async function fetchCodexQuota(options: QuotaRequestOptions): Promise<QuotaResult> {
  const accessToken = await resolveApiKey(options.auth, "openai-codex");
  const accountId = accessToken === undefined ? undefined : accountIdFromToken(accessToken);
  if (accessToken === undefined || accountId === undefined) {
    return { ok: false, identity: undefined, error: SIGN_IN_REQUIRED };
  }

  const response = await requestUsageJson(
    USAGE_URL,
    { Accept: "application/json", Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": accountId },
    options,
  );
  if (!response.ok) return { ok: false, identity: accountId, error: response.error };

  const quota = parseCodexQuota(response.body);
  return quota
    ? { ok: true, identity: accountId, quota }
    : { ok: false, identity: accountId, error: UNEXPECTED_RESPONSE };
}

/**
 * Account ID claimed by the access token, or undefined when it is absent.
 * Reading the claim is not verification: the endpoint authenticates the token.
 */
function accountIdFromToken(accessToken: string): string | undefined {
  const segments = accessToken.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) return undefined;
  if (!segments.every((segment) => BASE64URL_SEGMENT.test(segment))) return undefined;

  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const accountId = asRecord(asRecord(claims)?.[AUTH_CLAIM])?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}
