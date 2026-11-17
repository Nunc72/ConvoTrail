// v0.0.326 — fetches one image of a mail from the sender's server, for
// the PDF a Home Screen app on iOS makes instead of printing (see
// routes/printImage.ts). The URL comes from mail HTML, so it is treated
// as hostile: only http(s) on the default ports, only public addresses,
// only image/* responses, at most 20 MB.
import dns from "node:dns";
import net from "node:net";
import { Agent, request } from "undici";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class RelayError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

// Loopback, private, link-local (cloud metadata), carrier-grade NAT,
// multicast, documentation and reserved ranges. Fly's private network
// (fdaa::/16) falls under fc00::/7. IPv4 written as IPv6 (::ffff:a.b.c.d)
// is turned back into IPv4 below; a ::ffff:0:0/96 rule can't do that,
// since BlockList applies it to every IPv4 address.
const blocked = new net.BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(a, p, "ipv6");

export function isPublicAddress(address: string): boolean {
  let ip = address;
  if (net.isIP(ip) === 6) {
    // The URL parser writes every form of a mapped address as ::ffff:hhhh:hhhh.
    let host: string;
    try { host = new URL(`http://[${ip}]`).hostname; } catch { return false; }
    const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
    if (mapped) {
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
      ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  const family = net.isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

// Every connection resolves its host through here, so a name that
// points (or redirects) to an internal address fails before a socket
// opens, and the address checked is the one connected to.
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, list) => {
    if (err) return callback(err, "");
    if (!list.length || !list.every(a => isPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} is not a public address`), { code: "EBLOCKED" }), "");
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

// HTTP/1.1, as for Supabase (supabase.ts): undici's HTTP/2 streams stall
// when the app asks for a few images of one host at once.
const relayAgent = new Agent({
  allowH2: false,
  connect: { lookup: publicLookup, timeout: 10_000 },
  headersTimeout: 10_000,
  bodyTimeout: 15_000,
  maxResponseSize: MAX_IMAGE_BYTES,
});

// An address written into the URL never goes through the lookup, so it
// is checked here, for the first URL and for every redirect.
function checkUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RelayError(400, "Invalid URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new RelayError(400, "Only http(s) URLs");
  if (url.username || url.password) throw new RelayError(400, "No credentials in URLs");
  if (url.port && url.port !== "80" && url.port !== "443") throw new RelayError(400, "Only the default ports");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw new RelayError(400, `${host} is not a public address`);
  return url;
}

export async function fetchPublicImage(raw: string, signal: AbortSignal): Promise<{ type: string; body: Buffer }> {
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await request(url, {
      method: "GET",
      dispatcher: relayAgent,
      signal,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Convooz image relay)",
        accept: "image/avif,image/webp,image/apng,image/*;q=0.8",
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      await res.body.dump();
      const location = res.headers.location;
      if (typeof location !== "string" || hop >= MAX_REDIRECTS) throw new RelayError(502, "Too many redirects");
      url = checkUrl(new URL(location, url).toString());
      continue;
    }
    if (res.statusCode !== 200) {
      await res.body.dump();
      throw new RelayError(502, `The image server answered ${res.statusCode}`);
    }
    const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) {
      await res.body.dump();
      throw new RelayError(415, "Not an image");
    }
    if (Number(res.headers["content-length"] ?? 0) > MAX_IMAGE_BYTES) {
      await res.body.dump();
      throw new RelayError(413, "Image too large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        res.body.destroy();
        throw new RelayError(413, "Image too large");
      }
      chunks.push(chunk);
    }
    return { type, body: Buffer.concat(chunks, size) };
  }
}
