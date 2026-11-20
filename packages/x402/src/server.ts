import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Facilitator } from "./facilitator";
import type { FacilitatorRequest } from "./types";

export interface ServerOptions {
  /** If set, POST /settle requires `Authorization: Bearer <apiKey>`. Strongly recommended:
   *  otherwise anyone can make the relayer spend gas on their payments. */
  apiKey?: string;
  /** Also require the key on /verify. Default false (verify is read-only). */
  protectVerify?: boolean;
  log?: (line: string) => void;
}

const MAX_BODY = 64 * 1024;

/**
 * x402 facilitator over HTTP:
 *   GET  /supported   schemes and networks
 *   POST /verify      { x402Version, paymentPayload, paymentRequirements } -> VerifyResponse
 *   POST /settle      same body -> SettleResponse
 *   GET  /health      relayer address and gas balance
 */
export function createFacilitatorServer(f: Facilitator, opts: ServerOptions = {}): Server {
  const log = opts.log ?? ((l) => console.log(l));

  return createServer(async (req, res) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0];
    let status = 200;
    let note = "";
    try {
      if (req.method === "GET" && path === "/supported") return send(res, 200, f.supported());
      if (req.method === "GET" && path === "/health") {
        const s = await f.status();
        return send(res, 200, { ok: true, ...s, relayerBalanceWei: s.relayerBalanceWei.toString() });
      }
      if (req.method === "POST" && (path === "/verify" || path === "/settle")) {
        if (opts.apiKey && (path === "/settle" || opts.protectVerify) && !authorized(req, opts.apiKey)) {
          status = 401;
          return send(res, 401, { error: "unauthorized", message: "Missing or wrong API key." });
        }
        const body = await readJson(req);
        if (!body) {
          status = 400;
          return send(res, 400, { error: "invalid_request", message: "Body must be JSON, at most 64 KB." });
        }
        const out = path === "/verify" ? await f.verify(body as FacilitatorRequest) : await f.settle(body as FacilitatorRequest);
        const scheme = (body as FacilitatorRequest)?.paymentPayload?.scheme ?? "?";
        note = "isValid" in out
          ? `${scheme} ${out.isValid ? "valid" : out.invalidReason}`
          : `${scheme} ${out.success ? `settled ${out.transaction}` : out.errorReason}`;
        return send(res, 200, out);
      }
      status = 404;
      return send(res, 404, { error: "not_found" });
    } catch (e) {
      status = 500;
      note = (e as Error).message;
      return send(res, 500, { error: "internal_error", message: "Facilitator error. Try again." });
    } finally {
      log(`${new Date().toISOString()} ${req.method} ${path} ${status} ${Date.now() - started}ms ${note}`.trim());
    }
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, key: string): boolean {
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(key);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readJson(req: IncomingMessage): Promise<unknown | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
