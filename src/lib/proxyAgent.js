/**
 * h2-over-proxy: open an HTTP/2 session to a TLS origin THROUGH a SOCKS5 or
 * HTTP(S) CONNECT proxy.
 *
 * Cursor's endpoint (api2.cursor.sh) speaks ConnectRPC over HTTP/2 and rejects
 * HTTP/1.1, so we cannot use undici's ProxyAgent (HTTP/1.1). Instead we:
 *   1. establish a raw TCP tunnel to host:443 through the proxy
 *   2. wrap it in TLS, negotiating ALPN "h2"
 *   3. hand the TLS socket to http2.connect via `createConnection`
 *
 * Supported proxy URLs:
 *   socks5://[user:pass@]host:port      (and socks5h:// / socks://)
 *   socks4://host:port
 *   http://[user:pass@]host:port        (CONNECT tunnel)
 *   https://[user:pass@]host:port
 */
import net from "net";
import tls from "tls";
import http2 from "http2";
import { SocksClient } from "socks";

function parseProxy(proxyUrl) {
  const u = new URL(proxyUrl);
  const scheme = u.protocol.replace(":", "").toLowerCase();
  const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || "") } : null;
  return { scheme, host: u.hostname, port: Number(u.port) || (scheme.startsWith("socks") ? 1080 : 8080), auth };
}

/** Open a raw TCP socket to destHost:destPort through a SOCKS proxy. */
async function socksTunnel(proxy, destHost, destPort) {
  const type = proxy.scheme === "socks4" ? 4 : 5;
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type,
      ...(proxy.auth ? { userId: proxy.auth.username, password: proxy.auth.password } : {}),
    },
    command: "connect",
    destination: { host: destHost, port: destPort },
    timeout: 20000,
  });
  return socket;
}

/** Open a raw TCP socket to destHost:destPort through an HTTP CONNECT proxy. */
function httpConnectTunnel(proxy, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const connectProxy = (sock) => {
      const headers = [`CONNECT ${destHost}:${destPort} HTTP/1.1`, `Host: ${destHost}:${destPort}`];
      if (proxy.auth) {
        const token = Buffer.from(`${proxy.auth.username}:${proxy.auth.password}`).toString("base64");
        headers.push(`Proxy-Authorization: Basic ${token}`);
      }
      sock.write(headers.join("\r\n") + "\r\n\r\n");
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        sock.removeListener("data", onData);
        const statusLine = buf.slice(0, buf.indexOf("\r\n")).toString();
        const m = statusLine.match(/^HTTP\/1\.\d (\d{3})/);
        if (!m || m[1][0] !== "2") {
          sock.destroy();
          return reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
        }
        resolve(sock);
      };
      sock.on("data", onData);
      sock.on("error", reject);
    };

    if (proxy.scheme === "https") {
      const sock = tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host }, () => connectProxy(sock));
      sock.on("error", reject);
    } else {
      const sock = net.connect({ host: proxy.host, port: proxy.port }, () => connectProxy(sock));
      sock.on("error", reject);
    }
  });
}

/** Get a raw TCP tunnel socket to destHost:destPort via any supported proxy. */
async function tunnel(proxyUrl, destHost, destPort) {
  const proxy = parseProxy(proxyUrl);
  if (proxy.scheme.startsWith("socks")) return socksTunnel(proxy, destHost, destPort);
  if (proxy.scheme === "http" || proxy.scheme === "https") return httpConnectTunnel(proxy, destHost, destPort);
  throw new Error(`Unsupported proxy scheme: ${proxy.scheme}`);
}

/**
 * Connect an HTTP/2 session to https://host (port 443) optionally via a proxy.
 * @param {string} host          e.g. "api2.cursor.sh"
 * @param {string|null} proxyUrl proxy URL or null for a direct connection
 * @returns {Promise<import('http2').ClientHttp2Session>}
 */
export async function connectHttp2(host, proxyUrl) {
  if (!proxyUrl) return http2.connect(`https://${host}`);

  const raw = await tunnel(proxyUrl, host, 443);
  const tlsSocket = tls.connect({
    socket: raw,
    servername: host,
    ALPNProtocols: ["h2"],
  });

  await new Promise((resolve, reject) => {
    tlsSocket.once("secureConnect", () => {
      if (tlsSocket.alpnProtocol !== "h2") {
        // Some proxies/servers may not negotiate h2; surface a clear error.
        return reject(new Error(`ALPN negotiation did not yield h2 (got ${tlsSocket.alpnProtocol || "none"})`));
      }
      resolve();
    });
    tlsSocket.once("error", reject);
  });

  return http2.connect(`https://${host}`, { createConnection: () => tlsSocket });
}

/**
 * Quick connectivity test for a proxy: can we open a TLS h2 tunnel to a target?
 * @returns {Promise<{ok:boolean, ms:number, error?:string}>}
 */
export async function testProxy(proxyUrl, host = "api2.cursor.sh") {
  const start = Date.now();
  try {
    const session = await connectHttp2(host, proxyUrl);
    session.close();
    return { ok: true, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: e.message };
  }
}
