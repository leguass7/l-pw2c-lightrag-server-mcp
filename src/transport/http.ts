import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import {
  LightragOverrideError,
  loadHttpServerConfigFromEnv,
  logLightragOverrideError,
} from "../config.js";
import {
  readMcpSessionId,
  sessionRequestAls,
  type SessionOverrideStore,
} from "../lightrag-session.js";

export interface StartHttpServerOptions {
  port?: number;
  host?: string;
  sessionStore: SessionOverrideStore;
  /** Um servidor MCP por sessão Streamable HTTP (contrato do SDK). */
  createMcpServer: () => McpServer;
}

export interface HttpServerHandle {
  url: string;
  close: () => Promise<void>;
}

type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(
      /* v8 ignore next */ typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk as Uint8Array),
    );
  }
  if (chunks.length === 0) {
    /* v8 ignore next */
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    /* v8 ignore next */
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

function sendOverrideError(
  res: ServerResponse,
  err: LightragOverrideError,
): void {
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: err.message },
      id: null,
    }),
  );
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

function bodyContainsInitialize(body: unknown): boolean {
  if (body === undefined || body === null) {
    return false;
  }
  if (Array.isArray(body)) {
    return body.some((msg: unknown) => isInitializeRequest(msg));
  }
  return isInitializeRequest(body);
}

/**
 * MCP over Streamable HTTP at `/mcp` (stateful sessions). Flag CLI: `--sse`.
 *
 * Uma instância {@link StreamableHTTPServerTransport} + {@link McpServer} por sessão,
 * conforme os exemplos do SDK (`standaloneSseWithGetStreamableHttp`). Um transport
 * global fazia o segundo cliente falhar com "Server already initialized".
 */
export async function startHttpServer(
  options: StartHttpServerOptions,
): Promise<HttpServerHandle> {
  const { sessionStore, createMcpServer } = options;
  const sessions = new Map<string, SessionEntry>();

  const envCfg = loadHttpServerConfigFromEnv();
  const port = options.port ?? envCfg.port;
  const host = options.host ?? envCfg.host;

  const httpServer = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        try {
          const pathname = new URL(
            req.url ?? "/",
            `http://${req.headers.host ?? "localhost"}`,
          ).pathname;
          if (pathname === "/health") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/plain");
            res.end("ok");
            return;
          }
          if (pathname !== "/mcp") {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }

          const headerSessionId = readMcpSessionId(req);

          try {
            sessionStore.applyRequestHeaders(req, headerSessionId);
          } catch (e) {
            if (e instanceof LightragOverrideError) {
              sendOverrideError(res, e);
              return;
            }
            /* v8 ignore next */
            throw e;
          }

          const parsedBody =
            req.method === "POST" ||
            /* v8 ignore next */ req.method === "DELETE"
              ? await readJsonBody(req)
              : undefined;

          if (
            req.method === "POST" &&
            headerSessionId &&
            !sessions.has(headerSessionId)
          ) {
            sendJsonRpcError(res, 404, -32001, "Session not found");
            return;
          }

          if (
            req.method === "POST" &&
            !headerSessionId &&
            !bodyContainsInitialize(parsedBody)
          ) {
            sendJsonRpcError(
              res,
              400,
              -32000,
              "Bad Request: No valid session ID provided",
            );
            return;
          }

          if (
            (req.method === "GET" || req.method === "DELETE") &&
            (!headerSessionId || !sessions.has(headerSessionId))
          ) {
            sendJsonRpcError(
              res,
              400,
              -32000,
              "Bad Request: Invalid or missing session ID",
            );
            return;
          }

          const runWithSession = async (
            sessionId: string | undefined,
            handle: () => Promise<void>,
          ): Promise<void> => {
            await sessionRequestAls.run({ sessionId }, handle);
          };

          if (headerSessionId && sessions.has(headerSessionId)) {
            const entry = sessions.get(headerSessionId)!;
            await runWithSession(headerSessionId, async () => {
              await entry.transport.handleRequest(req, res, parsedBody);
            });
            return;
          }

          if (req.method === "POST" && bodyContainsInitialize(parsedBody)) {
            const bundle: {
              transport?: StreamableHTTPServerTransport;
              server?: McpServer;
            } = {};

            bundle.transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (sid) => {
                sessionStore.commitPending(sid);
                const tr = bundle.transport;
                const srv = bundle.server;
                if (tr && srv) {
                  sessions.set(sid, { transport: tr, server: srv });
                }
              },
              onsessionclosed: async (sid) => {
                sessionStore.remove(sid);
                sessions.delete(sid);
                await bundle.server?.close().catch(() => undefined);
              },
            });

            bundle.server = createMcpServer();
            await bundle.server.connect(bundle.transport);

            await runWithSession(undefined, async () => {
              await bundle.transport!.handleRequest(req, res, parsedBody);
            });
            return;
          }

          sendJsonRpcError(res, 400, -32000, "Bad Request");
        } catch (error) {
          if (error instanceof LightragOverrideError) {
            logLightragOverrideError(error.message);
            /* v8 ignore next 3 */
            if (!res.headersSent) {
              sendOverrideError(res, error);
            }
            return;
          }
          /* v8 ignore next 6 */
          console.error(
            "l-pw2c-lightrag-server-mcp: failed to handle Streamable HTTP request:",
            error,
          );
          if (/* v8 ignore next */ !res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        }
      })();
    },
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, host, () => resolve());
    httpServer.on("error", reject);
  });

  const addr = httpServer.address();
  const listenPort =
    typeof addr === "object" && addr !== null
      ? addr.port
      : /* v8 ignore next */ port;
  /** Client URL for loopback tooling when bind is all interfaces */
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${String(listenPort)}/mcp`;
  const bindUrl = `http://${host}:${String(listenPort)}/mcp`;

  console.error(`[HTTP] MCP Streamable HTTP bound on ${bindUrl}`);
  if (host === "0.0.0.0") {
    console.error(
      `[HTTP] From another container use http://<service-hostname>:${String(listenPort)}/mcp; ${url} is only valid on this host`,
    );
  }

  return {
    url,
    close: async () => {
      for (const [, entry] of sessions) {
        await entry.transport.close().catch(() => undefined);
        await entry.server.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
