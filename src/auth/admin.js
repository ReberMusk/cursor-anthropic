/**
 * Admin authentication: bcrypt password hashing + JWT sessions (httpOnly cookie).
 * The initial admin is seeded from ADMIN_USERNAME / ADMIN_PASSWORD on first run,
 * or a random password is generated and printed to stdout.
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { admins } from "../db/repos.js";

const JWT_TTL = "7d";
const COOKIE_NAME = "ca_admin";

function jwtSecret() {
  let s = process.env.JWT_SECRET;
  if (!s) {
    // Stable-for-process fallback so dev works without config (sessions reset on restart).
    s = (globalThis.__CA_JWT_SECRET ||= crypto.randomBytes(32).toString("hex"));
  }
  return s;
}

export const hashPassword = (pw) => bcrypt.hashSync(String(pw), 10);
export const verifyPassword = (pw, hash) => bcrypt.compareSync(String(pw), String(hash || ""));

/** Ensure an admin exists. Returns { created, username, generatedPassword? }. */
export async function ensureAdmin() {
  if ((await admins.count()) > 0) return { created: false };
  const username = process.env.ADMIN_USERNAME || "admin";
  let password = process.env.ADMIN_PASSWORD;
  let generated = null;
  if (!password) {
    password = crypto.randomBytes(9).toString("base64url");
    generated = password;
  }
  await admins.create(username, hashPassword(password), generated ? 1 : 0);
  return { created: true, username, generatedPassword: generated };
}

export async function login(username, password) {
  const admin = await admins.getByUsername(username);
  if (!admin || !verifyPassword(password, admin.password_hash)) return null;
  const token = jwt.sign({ sub: admin.id, username: admin.username }, jwtSecret(), { expiresIn: JWT_TTL });
  return { token, admin: { id: admin.id, username: admin.username, mustChange: !!admin.must_change } };
}

export function verifyToken(token) {
  try { return jwt.verify(token, jwtSecret()); }
  catch { return null; }
}

function readToken(req) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (m) return decodeURIComponent(m[1]);
  const auth = req.headers.authorization || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "");
  return null;
}

/** Express middleware: require a valid admin session. */
export function requireAdmin(req, res, next) {
  const token = readToken(req);
  const claims = token && verifyToken(token);
  if (!claims) return res.status(401).json({ error: { type: "authentication_error", message: "Admin login required" } });
  req.admin = claims;
  next();
}

/** True when the request actually arrived over HTTPS (directly or via proxy). */
function isSecureRequest(req) {
  if (!req) return false;
  if (req.secure) return true; // requires Express "trust proxy" when behind a reverse proxy
  const xfProto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return xfProto === "https";
}

export function setSessionCookie(res, token, req) {
  // Only mark the cookie Secure when the connection is genuinely HTTPS.
  // Tying this to NODE_ENV broke plain-HTTP deployments (e.g. http://host:8787):
  // browsers silently drop Secure cookies sent over http, so the session was
  // never stored and every follow-up request failed with "Admin login required".
  const secure = isSecureRequest(req);
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${7 * 24 * 3600}${secure ? "; Secure" : ""}`);
}

export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
}

export { COOKIE_NAME };
