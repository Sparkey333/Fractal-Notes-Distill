import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ensureStudioTree } from "../core/paths.ts";
import { safeEqual } from "../providers/keystore.ts";
import { handle } from "./api.ts";

/**
 * The local console.
 *
 * Binds to loopback only and requires a token printed at startup. That is not
 * decoration: this server can read and write BYOK secrets, so anything that can
 * reach it can exfiltrate every key in the store. Do not put it behind a tunnel or
 * a reverse proxy without adding real authentication first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STUDIO_PORT ?? 4571);
const HOST = "127.0.0.1";
const TOKEN = process.env.STUDIO_TOKEN ?? randomBytes(16).toString("hex");

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  const payload = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
    // The console holds secrets; keep it out of caches and out of frames.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Body was not valid JSON.");
  }
}

function authorized(req: IncomingMessage, url: URL): boolean {
  const header = req.headers["x-studio-token"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const candidate = fromHeader ?? url.searchParams.get("token") ?? "";
  return safeEqual(candidate, TOKEN);
}

ensureStudioTree();

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    // The page itself carries the token in its query string; the bundled script
    // reads it back out and sends it as a header on every API call.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (!authorized(req, url)) {
        return send(
          res,
          401,
          "Missing or bad token. Open the URL printed when the server started.",
          "text/plain; charset=utf-8",
        );
      }
      const html = readFileSync(join(here, "console.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (!url.pathname.startsWith("/api/")) {
      return send(res, 404, { error: "Not found" });
    }
    if (!authorized(req, url)) {
      return send(res, 401, { error: "Unauthorized" });
    }

    try {
      // GET handlers take their arguments from the query string; POST from a body.
      const body =
        req.method === "GET"
          ? Object.fromEntries(url.searchParams.entries())
          : await readBody(req);
      const result = await handle({
        method: req.method ?? "GET",
        path: url.pathname,
        body,
      });
      send(res, result.status, result.body);
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  })();
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log(`\n  \x1b[1mstudio console\x1b[0m`);
  console.log(`  \x1b[36m${url}\x1b[0m\n`);
  console.log(`  \x1b[2mLoopback only. The token gates access to your stored keys —`);
  console.log(`  don't expose this port or paste the URL anywhere.\x1b[0m\n`);
});
