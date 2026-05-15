import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIGHTRAG_API_KEY_HEADER,
  LIGHTRAG_SERVER_URL_HEADER,
  LIGHTRAG_WORKSPACE_HEADER,
  loadConfigFromEnv,
  loadHttpOverrideSettingsFromEnv,
  loadHttpServerConfigFromEnv,
  parseAllowedHosts,
  validateUpstreamHost,
} from "../src/config.js";
import { SessionOverrideStore } from "../src/lightrag-session.js";
import { createMcpServer } from "../src/server.js";
import { startHttpServer } from "../src/transport/http.js";

async function startMcpHttpStack(envLightragUrl: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  vi.stubEnv("LIGHTRAG_SERVER_URL", envLightragUrl);
  const envConfig = loadConfigFromEnv();
  const sessionStore = new SessionOverrideStore(
    envConfig,
    loadHttpOverrideSettingsFromEnv(),
  );
  const mcp = createMcpServer({ cwd: process.cwd() }, { sessionStore });
  const handle = await startHttpServer(mcp, {
    sessionStore,
    port: 0,
    host: "127.0.0.1",
  });
  return handle;
}

function getFirstTextBlock(out: unknown): string | undefined {
  if (!out || typeof out !== "object" || !("content" in out)) {
    return undefined;
  }
  const blocks = (out as { content: unknown }).content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return undefined;
  }
  const b: unknown = blocks[0];
  if (
    b &&
    typeof b === "object" &&
    "type" in b &&
    (b as { type: unknown }).type === "text" &&
    "text" in b &&
    typeof (b as { text: unknown }).text === "string"
  ) {
    return (b as { text: string }).text;
  }
  return undefined;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

async function startMockLightrag(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
  ) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const body = await readRequestBody(req);
      try {
        await handler(req, res, body);
      } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected TCP address");
  }
  const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  return {
    baseUrl,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) {
      await task();
    }
  }
});

describe("loadHttpServerConfigFromEnv", () => {
  it("usa porto e host por defeito", () => {
    vi.stubEnv("MCP_HTTP_PORT", "");
    vi.stubEnv("MCP_HTTP_HOST", "");
    delete process.env.MCP_HTTP_PORT;
    delete process.env.MCP_HTTP_HOST;
    const c = loadHttpServerConfigFromEnv({});
    expect(c.port).toBe(8000);
    expect(c.host).toBe("0.0.0.0");
  });

  it("lê MCP_HTTP_PORT e MCP_HTTP_HOST", () => {
    vi.stubEnv("MCP_HTTP_PORT", "9001");
    vi.stubEnv("MCP_HTTP_HOST", "127.0.0.1");
    const c = loadHttpServerConfigFromEnv();
    expect(c.port).toBe(9001);
    expect(c.host).toBe("127.0.0.1");
  });

  it("rejeita porto inválido", () => {
    vi.stubEnv("MCP_HTTP_PORT", "99999");
    expect(() => loadHttpServerConfigFromEnv()).toThrow(/MCP_HTTP_PORT/);
  });
});

describe("loadHttpOverrideSettingsFromEnv", () => {
  it("lista vazia de hosts equivale a *", () => {
    expect(parseAllowedHosts("")).toEqual(["*"]);
    expect(parseAllowedHosts(undefined)).toEqual(["*"]);
  });

  it("validateUpstreamHost aceita *", () => {
    expect(() =>
      validateUpstreamHost("https://any-host.example.com", ["*"]),
    ).not.toThrow();
  });
});

describe("MCP Streamable HTTP e2e", () => {
  it("lista as 30 ferramentas via HTTP /mcp", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const client = new Client({
      name: "l-pw2c-lightrag-http-e2e",
      version: "0.0.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    cleanupTasks.push(async () => {
      await client.close();
      await transport.close();
    });

    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(30);
    expect(tools.map((t) => t.name)).toContain("get_health");
    expect(tools.map((t) => t.name)).toContain("query_text");
  });

  it("URL reflete MCP_HTTP_HOST quando não é 0.0.0.0", async () => {
    vi.stubEnv("MCP_HTTP_HOST", "127.0.0.1");
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("GET /health responde ok", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const healthUrl = url.replace(/\/mcp$/, "/health");
    const res = await fetch(healthUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("aceita POST /mcp com corpo vazio (stateless init)", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const client = new Client({
      name: "l-pw2c-lightrag-http-e2e",
      version: "0.0.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    cleanupTasks.push(async () => {
      await client.close();
      await transport.close();
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it("rotas desconhecidas devolvem 404", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const root = new URL(url);
    root.pathname = "/unknown";
    const res = await fetch(root.toString());
    expect(res.status).toBe(404);
  });

  it("get_health via HTTP delega GET /health ao LightRAG mock", async () => {
    let healthPath: string | undefined;
    const { baseUrl, close: closeLr } = await startMockLightrag((req, res) => {
      healthPath = req.url ?? undefined;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "ok" }));
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const client = new Client({
      name: "l-pw2c-lightrag-http-e2e",
      version: "0.0.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    cleanupTasks.push(async () => {
      await client.close();
      await transport.close();
    });

    await client.connect(transport);
    const out = await client.callTool({ name: "get_health", arguments: {} });
    expect(healthPath).toBe("/health");
    const text = getFirstTextBlock(out);
    expect(text).toBeDefined();
    expect(text).toContain("ok");
  });
});

describe("MCP HTTP header overrides", () => {
  it("override LIGHTRAG-Server-Url e LIGHTRAG-API-Key via headers", async () => {
    const { baseUrl: envUrl, close: closeEnv } = await startMockLightrag(
      (_req, res) => {
        res.statusCode = 418;
        res.end("wrong");
      },
    );
    cleanupTasks.push(closeEnv);

    let overrideHost: string | undefined;
    let apiKey: string | undefined;
    const { baseUrl: overrideUrl, close: closeOverride } =
      await startMockLightrag((req, res) => {
        overrideHost = req.headers.host;
        const k = req.headers["x-api-key"];
        apiKey = Array.isArray(k) ? k[0] : k;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
      });
    cleanupTasks.push(closeOverride);

    vi.stubEnv("LIGHTRAG_SERVER_URL", envUrl);
    const envConfig = loadConfigFromEnv();
    const sessionStore = new SessionOverrideStore(
      envConfig,
      loadHttpOverrideSettingsFromEnv(),
    );
    const mcp = createMcpServer({ cwd: process.cwd() }, { sessionStore });
    const { url, close: closeMcp } = await startHttpServer(mcp, {
      sessionStore,
      port: 0,
      host: "127.0.0.1",
    });
    cleanupTasks.push(closeMcp);

    const client = new Client({
      name: "l-pw2c-lightrag-http-overrides",
      version: "0.0.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          [LIGHTRAG_SERVER_URL_HEADER]: overrideUrl,
          [LIGHTRAG_API_KEY_HEADER]: "from-header",
        },
      },
    });
    cleanupTasks.push(async () => {
      await client.close();
      await transport.close();
    });

    await client.connect(transport);
    await client.callTool({ name: "get_health", arguments: {} });

    expect(overrideHost).toContain("127.0.0.1");
    expect(apiKey).toBe("from-header");
  });

  it("rejeita host fora da allowlist com 400 e log", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    vi.stubEnv("LIGHTRAG_SERVER_URL", baseUrl);
    vi.stubEnv("MCP_ALLOWED_LIGHTRAG_HOSTS", "127.0.0.1");

    const envConfig = loadConfigFromEnv();
    const sessionStore = new SessionOverrideStore(
      envConfig,
      loadHttpOverrideSettingsFromEnv(),
    );
    const mcp = createMcpServer({ cwd: process.cwd() }, { sessionStore });
    const { url, close: closeMcp } = await startHttpServer(mcp, {
      sessionStore,
      port: 0,
      host: "127.0.0.1",
    });
    cleanupTasks.push(closeMcp);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        [LIGHTRAG_SERVER_URL_HEADER]: "https://evil.example.com",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });

    expect(res.status).toBe(400);
    expect(consoleSpy).toHaveBeenCalled();
    const logged = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/MCP_ALLOWED_LIGHTRAG_HOSTS/);
    consoleSpy.mockRestore();
  });

  it("MCP_HTTP_HEADER_OVERRIDES=false ignora headers", async () => {
    const { baseUrl: envUrl, close: closeEnv } = await startMockLightrag(
      (req, res) => {
        expect(req.url).toBe("/health");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ from: "env" }));
      },
    );
    cleanupTasks.push(closeEnv);

    const { baseUrl: otherUrl, close: closeOther } = await startMockLightrag(
      (_req, res) => {
        res.statusCode = 500;
        res.end("wrong");
      },
    );
    cleanupTasks.push(closeOther);

    vi.stubEnv("LIGHTRAG_SERVER_URL", envUrl);
    vi.stubEnv("MCP_HTTP_HEADER_OVERRIDES", "false");

    const envConfig = loadConfigFromEnv();
    const sessionStore = new SessionOverrideStore(
      envConfig,
      loadHttpOverrideSettingsFromEnv(),
    );
    const mcp = createMcpServer({ cwd: process.cwd() }, { sessionStore });
    const { url, close: closeMcp } = await startHttpServer(mcp, {
      sessionStore,
      port: 0,
      host: "127.0.0.1",
    });
    cleanupTasks.push(closeMcp);

    const client = new Client({
      name: "l-pw2c-lightrag-http-no-override",
      version: "0.0.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { [LIGHTRAG_SERVER_URL_HEADER]: otherUrl },
      },
    });
    cleanupTasks.push(async () => {
      await client.close();
      await transport.close();
    });

    await client.connect(transport);
    const out = await client.callTool({ name: "get_health", arguments: {} });
    expect(getFirstTextBlock(out)).toContain("env");
  });

  it("LIGHTRAG-WORKSPACE no header aplica-se à sessão", async () => {
    let wsHeader: string | undefined;
    const { baseUrl, close: closeLr } = await startMockLightrag((req, res) => {
      const h = req.headers["lightrag-workspace"];
      wsHeader = Array.isArray(h) ? h[0] : h;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    vi.stubEnv("LIGHTRAG_SERVER_URL", baseUrl);
    const envConfig = loadConfigFromEnv();
    const sessionStore = new SessionOverrideStore(
      envConfig,
      loadHttpOverrideSettingsFromEnv(),
    );
    const mcp = createMcpServer({ cwd: process.cwd() }, { sessionStore });
    const { url, close: closeMcp } = await startHttpServer(mcp, {
      sessionStore,
      port: 0,
      host: "127.0.0.1",
    });
    cleanupTasks.push(closeMcp);

    const client = new Client({
      name: "l-pw2c-lightrag-http-ws",
      version: "0.0.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { [LIGHTRAG_WORKSPACE_HEADER]: "ws-from-header" },
      },
    });
    cleanupTasks.push(async () => {
      await client.close();
      await transport.close();
    });

    await client.connect(transport);
    await client.callTool({ name: "get_health", arguments: {} });
    expect(wsHeader).toBe("ws-from-header");
  });

  it("allowlist * permite override para host arbitrário", async () => {
    const { baseUrl: envUrl, close: closeEnv } = await startMockLightrag(
      (_req, res) => {
        res.statusCode = 418;
        res.end("env");
      },
    );
    cleanupTasks.push(closeEnv);

    const { baseUrl: overrideUrl, close: closeOverride } =
      await startMockLightrag((_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
      });
    cleanupTasks.push(closeOverride);

    vi.stubEnv("LIGHTRAG_SERVER_URL", envUrl);
    vi.stubEnv("MCP_ALLOWED_LIGHTRAG_HOSTS", "*");

    const envConfig = loadConfigFromEnv();
    const sessionStore = new SessionOverrideStore(
      envConfig,
      loadHttpOverrideSettingsFromEnv(),
    );
    const mcp = createMcpServer({ cwd: process.cwd() }, { sessionStore });
    const { url, close: closeMcp } = await startHttpServer(mcp, {
      sessionStore,
      port: 0,
      host: "127.0.0.1",
    });
    cleanupTasks.push(closeMcp);

    const client = new Client({
      name: "l-pw2c-lightrag-http-star",
      version: "0.0.1",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { [LIGHTRAG_SERVER_URL_HEADER]: overrideUrl },
      },
    });
    cleanupTasks.push(async () => {
      await client.close();
      await transport.close();
    });

    await client.connect(transport);
    const out = await client.callTool({ name: "get_health", arguments: {} });
    expect(getFirstTextBlock(out)).toContain("ok");
  });

  it("rejeita URL inválida no header com 400", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    vi.stubEnv("LIGHTRAG_SERVER_URL", baseUrl);
    const envConfig = loadConfigFromEnv();
    const sessionStore = new SessionOverrideStore(
      envConfig,
      loadHttpOverrideSettingsFromEnv(),
    );
    const mcp = createMcpServer({ cwd: process.cwd() }, { sessionStore });
    const { url, close: closeMcp } = await startHttpServer(mcp, {
      sessionStore,
      port: 0,
      host: "127.0.0.1",
    });
    cleanupTasks.push(closeMcp);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        [LIGHTRAG_SERVER_URL_HEADER]: ":::not-a-valid-url",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });

    expect(res.status).toBe(400);
  });
});

describe("MCP HTTP server routes", () => {
  it("DELETE /mcp com sessão válida fecha sessão (onsessionclosed)", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const initRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const delRes = await fetch(url, {
      method: "DELETE",
      headers: {
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
        "mcp-protocol-version": "2025-03-26",
      },
    });
    expect(delRes.status).toBe(200);
  });

  it("POST /mcp com JSON inválido devolve 500", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{not-json",
    });
    expect(res.status).toBe(500);
  });

  it("GET path desconhecido devolve 404", async () => {
    const { baseUrl, close: closeLr } = await startMockLightrag((_req, res) => {
      res.end("{}");
    });
    cleanupTasks.push(closeLr);

    const { url, close: closeMcp } = await startMcpHttpStack(baseUrl);
    cleanupTasks.push(closeMcp);

    const healthUrl = url.replace(/\/mcp$/, "/health");
    const unknownUrl = url.replace(/\/mcp$/, "/unknown");

    const healthRes = await fetch(healthUrl);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.text()).toBe("ok");

    const res = await fetch(unknownUrl);
    expect(res.status).toBe(404);
  });
});
