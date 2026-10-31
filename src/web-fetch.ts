import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(address, prefix, "ipv6");

export function publicAddress(address: string) {
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type Address = { address: string; family: number };
type Page = { status: number; location?: string; contentType: string; body: string };
type Resolve = (host: string) => Promise<Address[]>;
type Get = (url: URL, address: Address) => Promise<Page>;

const resolveHost: Resolve = async host => {
  const ip = host.replace(/^\[|\]$/g, ""), family = isIP(ip);
  return family ? [{ address: ip, family }] : dnsLookup(host, { all: true, verbatim: true });
};
export const getPage: Get = (url, address) => new Promise((resolve, reject) => {
  const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    // The connection goes only to the address checked above. The client may ask for every address (all: true), which
    // takes an array; answering it with a single address leaves the address undefined.
    lookup: (_host, options, callback) => options.all
      ? (callback as unknown as (e: null, a: Address[]) => void)(null, [address])
      : callback(null, address.address, address.family as 4 | 6),
    timeout: 60_000,
    headers: { accept: "text/html, text/plain;q=0.9" },
  }, res => {
    const chunks: Buffer[] = []; let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10_000_000) { req.destroy(new Error("Page exceeds 10 MB")); return; }
      chunks.push(chunk);
    });
    res.on("error", reject);
    res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: res.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("timeout", () => req.destroy(new Error("Request timed out")));
  req.on("error", reject);
  req.end();
});


export async function fetchPublicPage(input: string, resolve: Resolve = resolveHost, get: Get = getPage) {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP(S) URLs without credentials are allowed");
    const addresses = await resolve(url.hostname);
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("Private or invalid address is not allowed");
    const page = await get(url, addresses[0]!);
    if (page.status >= 300 && page.status < 400 && page.location) { url = new URL(page.location, url); continue; }
    if (page.status < 200 || page.status >= 300) throw new Error(`HTTP ${page.status}`);
    let text = page.body;
    if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(page.contentType)) {
      const parts: string[] = [];
      const cleaned = await new HTMLRewriter().on("script, style, noscript", { element(e) { e.remove(); } }).transform(new Response(text)).text();
      await new HTMLRewriter().onDocument({ text(t) { parts.push(t.text); } }).transform(new Response(cleaned)).text();
      text = parts.join("");
    }
    return { url: url.href, text };
  }
  throw new Error("Too many redirects");
}
