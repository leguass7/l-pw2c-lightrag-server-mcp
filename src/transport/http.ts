import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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
}

export interface HttpServerHandle {
  url: string;
  close: () => Promise<void>;
}

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

/**
 * MCP over Streamable HTTP at `/mcp` (stateful sessions). Flag CLI: `--sse`.
 */
export async function startHttpServer(
  server: McpServer,
  options: StartHttpServerOptions,
): Promise<HttpServerHandle> {
  const { sessionStore } = options;
  const envCfg = loadHttpServerConfigFromEnv();
  const port = options.port ?? envCfg.port;
  const host = options.host ?? envCfg.host;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessionStore.commitPending(sessionId);
    },
    onsessionclosed: (sessionId) => {
      sessionStore.remove(sessionId);
    },
  });

  await server.connect(transport);

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

          const sessionId = readMcpSessionId(req);

          try {
            sessionStore.applyRequestHeaders(req, sessionId);
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

          await sessionRequestAls.run({ sessionId }, async () => {
            await transport.handleRequest(req, res, parsedBody);
          });
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
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${String(listenPort)}/mcp`;

  console.error(`[HTTP] MCP Streamable HTTP listening on ${url}`);

  return {
    url,
    close: async () => {
      await server.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
