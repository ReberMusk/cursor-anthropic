/**
 * Query the Cursor dashboard usage API to (a) validate that a token is still
 * good and (b) compute how much the account has spent over the last ~30 days.
 *
 * This is a plain HTTPS/1.1 JSON endpoint on cursor.com (NOT the HTTP/2 chat
 * endpoint), authenticated with the WorkosCursorSessionToken cookie. The cookie
 * value is the full session token "userId::jwt" (the dumps store it URL-encoded
 * as "userId%3A%3Ajwt", which is what cursor.com expects in the cookie).
 *
 * Mirrors the reference Python script: paginates get-filtered-usage-events,
 * sums chargeable token costs (excluding errored/free-credit kinds) and reports
 * the most recent activity time.
 */
import https from "https";
import tls from "tls";
import { rawTunnel } from "./proxyAgent.js";
import { extractAccessToken } from "./jwt.js";

const USAGE_HOST = "cursor.com";
const USAGE_PATH = "/api/dashboard/get-filtered-usage-events";
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;
const TIMEOUT_MS = 20000;

const EXCLUDED_KINDS = new Set([
  "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED",
  "USAGE_EVENT_KIND_FREE_CREDIT",
]);

/** Build the WorkosCursorSessionToken cookie value ("userId%3A%3Ajwt"). */
export function buildSessionToken(userId, token) {
  const jwt = extractAccessToken(token);
  return userId ? `${userId}%3A%3A${jwt}` : jwt;
}

function baseHeaders(sessionToken) {
  return {
    accept: "*/*",
    "accept-language": "en",
    "content-type": "application/json",
    origin: "https://cursor.com",
    referer: "https://cursor.com/cn/dashboard?tab=usage",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    "accept-encoding": "identity",
    cookie: `WorkosCursorSessionToken=${sessionToken}`,
  };
}

/** POST JSON to an HTTPS host, optionally through a SOCKS/HTTP proxy tunnel. */
function postJson({ host, path, headers, body, proxyUrl }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const options = {
      method: "POST",
      host,
      port: 443,
      path,
      servername: host,
      headers: { ...headers, "content-length": payload.length },
      timeout: TIMEOUT_MS,
    };
    if (proxyUrl) {
      options.createConnection = (_opts, cb) => {
        rawTunnel(proxyUrl, host, 443)
          .then((raw) => {
            const sock = tls.connect({ socket: raw, servername: host });
            sock.once("secureConnect", () => cb(null, sock));
            sock.once("error", cb);
          })
          .catch(cb);
      };
    }
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("timeout", () => req.destroy(new Error("usage request timed out")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function thirtyDayRange() {
  const now = Date.now();
  return { startDate: String(now - 30 * 24 * 3600 * 1000), endDate: String(now) };
}

/** Best-effort extraction of the most recent activity timestamp from page 1. */
function extractLastActive(events) {
  if (!events?.length) return null;
  const e = events[0];
  const fields = [
    "timestamp", "createdAt", "startTime", "time", "date", "eventTime",
    "created", "eventDate", "startDate", "endTime", "requestTime",
  ];
  let v = null;
  for (const f of fields) { if (e[f]) { v = e[f]; break; } }
  if (v == null) {
    for (const val of Object.values(e)) {
      if (typeof val === "number" && val > 1e12 && val < 2e12) { v = val; break; }
      if (typeof val === "string" && /^\d{13}$/.test(val)) { v = val; break; }
    }
  }
  if (v == null) return null;
  let ms;
  if (typeof v === "number") ms = v > 1e12 ? v : v * 1000;
  else if (/^\d+$/.test(v)) { const n = Number(v); ms = n > 1e12 ? n : n * 1000; }
  else { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function sumPage(events) {
  let cents = 0, included = 0;
  for (const e of events) {
    if (e.isChargeable !== true) continue;
    if (EXCLUDED_KINDS.has(e.kind)) continue;
    const tu = e.tokenUsage;
    if (!tu) continue;
    let c = Number(tu.totalCents || 0);
    if (e.cursorTokenFee != null) c += Number(e.cursorTokenFee) || 0;
    cents += c;
    included += 1;
  }
  return { cents, included };
}

/**
 * Validate a token and compute its last-30-day usage.
 * @returns {Promise<{ok:boolean, status:number, error?:string,
 *   includedEvents?:number, totalCents?:number, totalAmount?:number,
 *   lastActiveAt?:string|null}>}
 */
export async function fetchUsageSummary({ accessToken, userId, proxyUrl = null, maxPages = DEFAULT_MAX_PAGES }) {
  const sessionToken = buildSessionToken(userId, accessToken);
  const headers = baseHeaders(sessionToken);
  const { startDate, endDate } = thirtyDayRange();

  let totalCents = 0, includedEvents = 0, lastActiveAt = null, page = 1, totalCount = 0;

  while (page <= maxPages) {
    let res;
    try {
      res = await postJson({
        host: USAGE_HOST,
        path: USAGE_PATH,
        headers,
        body: { teamId: 0, startDate, endDate, page, pageSize: PAGE_SIZE },
        proxyUrl,
      });
    } catch (e) {
      return { ok: false, status: 0, error: `usage request failed: ${e.message}` };
    }

    // An invalid/expired token is bounced to the WorkOS login flow (a 3xx
    // redirect to api.workos.com/authorize) or rejected outright (401/403).
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, error: "令牌无效或已失效（被重定向到登录）" };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: "令牌无效或已失效（未授权）" };
    }
    if (res.status !== 200) {
      return { ok: false, status: res.status, error: `usage API HTTP ${res.status}` };
    }

    let json;
    try { json = JSON.parse(res.body); }
    catch { return { ok: false, status: res.status, error: "usage API 返回了非 JSON 响应" }; }

    totalCount = Number(json.totalUsageEventsCount || 0);
    const events = json.usageEventsDisplay || [];
    if (page === 1) lastActiveAt = extractLastActive(events);
    if (!events.length) break;

    const { cents, included } = sumPage(events);
    totalCents += cents;
    includedEvents += included;

    if (page * PAGE_SIZE >= totalCount) break;
    page += 1;
  }

  return {
    ok: true,
    status: 200,
    includedEvents,
    totalCents: Math.round(totalCents * 1e6) / 1e6,
    totalAmount: Math.round((totalCents / 100) * 100) / 100,
    lastActiveAt,
  };
}
