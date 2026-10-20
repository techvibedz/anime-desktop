import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";

// Chromium connects to whatever its DoH resolver answers, and on some ISPs a
// subset of Cloudflare's anycast edges (seen: 188.114.96.5, 188.114.97.5,
// 188.114.97.7) black-hole — the connect hangs instead of failing, and both
// Cloudflare and Google DoH rotate into them. That randomly timed out
// mp4upload / anime4up / anime3rb / streamwish CDNs in extraction AND playback.
// HTTPS goes through this local CONNECT tunnel instead: it resolves via system
// DNS + both DoH providers and races the candidates (happy eyeballs), so one
// dead edge never decides the request. TLS stays end-to-end in Chromium.

const DOH_JSON = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];
const STAGGER_MS = 300;
const CONNECT_TIMEOUT_MS = 8000;
// ponytail: unbounded per-host maps; hosts seen per session are a few hundred.
const deadUntil = new Map<string, number>();
const lastGood = new Map<string, string>();
const resolved = new Map<string, { at: number; sources: Promise<string[]>[] }>();

const capped = (p: Promise<string[]>, ms: number) =>
  Promise.race([p, new Promise<string[]>((r) => setTimeout(() => r([]), ms))]).catch(() => [] as string[]);

async function dohLookup(endpoint: string, host: string): Promise<string[]> {
  const res = await fetch(`${endpoint}?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(3000),
  });
  const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
  return (json.Answer || []).filter((a) => a.type === 1 && net.isIP(a.data)).map((a) => a.data);
}

function sourcesFor(host: string): Promise<string[]>[] {
  if (net.isIP(host)) return [Promise.resolve([host])];
  const hit = resolved.get(host);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.sources;
  const sources = [
    // Blocked names TIME OUT at the ISP resolver rather than NXDOMAIN.
    capped(dns.lookup(host, { all: true }).then((r) => r.map((a) => a.address)), 2500),
    ...DOH_JSON.map((endpoint) => capped(dohLookup(endpoint, host), 3500)),
  ];
  resolved.set(host, { at: Date.now(), sources });
  return sources;
}

export function connectHost(host: string, port: number, sources = sourcesFor(host)): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const tried = new Set<string>();
    const queue: string[] = [];
    const sockets = new Set<net.Socket>();
    let pending = sources.length;
    let stagger: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (error?: Error, socket?: net.Socket) => {
      if (done) return;
      done = true;
      if (stagger) clearTimeout(stagger);
      clearTimeout(overall);
      for (const s of sockets) if (s !== socket) s.destroy();
      if (socket) resolve(socket);
      else reject(error);
    };
    const maybeFail = () => {
      if (!pending && !queue.length && !sockets.size) finish(Error(`no reachable address for ${host}`));
    };
    const next = () => {
      if (stagger) { clearTimeout(stagger); stagger = null; }
      const ip = queue.shift();
      if (!ip || done) { maybeFail(); return; }
      const socket = net.connect({ host: ip, port });
      sockets.add(socket);
      const dead = () => {
        sockets.delete(socket);
        socket.destroy();
        deadUntil.set(ip, Date.now() + 10 * 60_000);
        if (!done) next();
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS, dead);
      socket.once("error", dead);
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeListener("error", dead);
        lastGood.set(host, ip);
        deadUntil.delete(ip);
        finish(undefined, socket);
      });
      if (queue.length) stagger = setTimeout(next, STAGGER_MS);
    };
    const rank = (ip: string) => (ip === lastGood.get(host) ? 0 : (deadUntil.get(ip) ?? 0) > Date.now() ? 2 : 1);
    const add = (ips: string[]) => {
      for (const ip of ips) if (!tried.has(ip)) { tried.add(ip); queue.push(ip); }
      queue.sort((a, b) => rank(a) - rank(b));
      if (!done && !stagger) next();
    };
    const overall = setTimeout(() => finish(Error(`connect timeout for ${host}`)), 15000);
    for (const source of sources) {
      source.then(add, () => {}).finally(() => { pending--; maybeFail(); });
    }
  });
}

export function resetEdgeTunnel(): void {
  deadUntil.clear();
  lastGood.clear();
  resolved.clear();
}

export async function startEdgeTunnel(): Promise<number> {
  const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    client.on("error", () => {});
    let target: URL;
    try { target = new URL(`http://${req.url}`); } catch { client.destroy(); return; }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    connectHost(host, Number(target.port) || 443).then((upstream) => {
      if (client.destroyed) { upstream.destroy(); return; }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.pipe(client);
      client.pipe(upstream);
    }, () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}
