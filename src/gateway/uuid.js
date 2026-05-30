// Dependency-free UUID helpers (v4 + v5) so the project runs with zero `npm install`.
import crypto from "crypto";

export const uuidv4 = () => crypto.randomUUID();

const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToUuid(b) {
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

// RFC 4122 v5 (SHA-1, name-based). Matches `uuid` package's v5(name, DNS).
export function uuidv5(name, namespace = DNS_NAMESPACE) {
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = Buffer.from(String(name), "utf-8");
  const hash = crypto.createHash("sha1").update(Buffer.concat([Buffer.from(nsBytes), nameBytes])).digest();
  const b = new Uint8Array(hash.slice(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  return bytesToUuid(b);
}

uuidv5.DNS = DNS_NAMESPACE;
