import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfigFromEnv } from "../src/config.js";
import {
  createLightragClient,
  resolveUploadInput,
} from "../src/lightrag-client.js";
import { createMcpServer } from "../src/server.js";
import { readPackageJsonVersion } from "../src/version.js";

function firstTextBlock(
  out: unknown,
): { type: "text"; text: string } | undefined {
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
    return { type: "text", text: (b as { text: string }).text };
  }
  return undefined;
}

const cleanupTasks: Array<() => Promise<void>> = [];

interface TestMcpServer {
  close: () => Promise<void>;
  connect: (transport: Transport) => Promise<void>;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanupTasks.length > 0) {
    const task = cleanupTasks.pop();
    if (task) {
      await task();
    }
  }
});

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

async function startMockServer(
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

async function withClientAndServer(
  baseUrl: string,
  cwd: string,
  apiKey?: string,
): Promise<Client> {
  const server = createMcpServer({
    baseUrl,
    cwd,
    ...(apiKey !== undefined ? { apiKey } : {}),
  }) as unknown as TestMcpServer;
  const client = new Client({
    name: "l-pw2c-lightrag-e2e",
    version: "0.0.1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  cleanupTasks.push(async () => {
    await Promise.all([
      server.close(),
      clientTransport.close(),
      serverTransport.close(),
    ]);
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("readPackageJsonVersion", () => {
  it("coincide com a versão em package.json", () => {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const expected = (JSON.parse(raw) as { version: string }).version;
    expect(readPackageJsonVersion()).toBe(expected);
  });
});

describe("loadConfigFromEnv", () => {
  it("rejeita URL vazia após trim", () => {
    vi.stubEnv("LIGHTRAG_SERVER_URL", "   ");
    expect(() => loadConfigFromEnv()).toThrow(/empty/i);
  });

  it("rejeita URL inválida", () => {
    vi.stubEnv("LIGHTRAG_SERVER_URL", "not-a-url");
    expect(() => loadConfigFromEnv()).toThrow();
  });

  it("rejeita protocolo não http(s)", () => {
    vi.stubEnv("LIGHTRAG_SERVER_URL", "ftp://example.com");
    expect(() => loadConfigFromEnv()).toThrow(/http/);
  });

  it("normaliza URL e lê API key", () => {
    vi.stubEnv("LIGHTRAG_SERVER_URL", "https://api.example.com/v1/");
    vi.stubEnv("LIGHTRAG_API_KEY", "  secret  ");
    vi.stubEnv("LIGHTRAG_TIMEOUT_MS", "5000");
    const c = loadConfigFromEnv();
    expect(c.baseUrl).toBe("https://api.example.com/v1");
    expect(c.apiKey).toBe("secret");
    expect(c.timeoutMs).toBe(5000);
  });

  it("lê LIGHTRAG_WORKSPACE com trim; vazio é indefinido", () => {
    vi.stubEnv("LIGHTRAG_SERVER_URL", "http://localhost:9621");
    vi.stubEnv("LIGHTRAG_WORKSPACE", "  prod  ");
    expect(loadConfigFromEnv().defaultWorkspace).toBe("prod");
    vi.stubEnv("LIGHTRAG_WORKSPACE", "   ");
    expect(loadConfigFromEnv().defaultWorkspace).toBeUndefined();
  });

  it("rejeita timeout inválido", () => {
    vi.stubEnv("LIGHTRAG_TIMEOUT_MS", "0");
    expect(() => loadConfigFromEnv()).toThrow();
  });
});

describe("MCP e2e com HTTP mock", () => {
  it("lista as 30 ferramentas", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(30);
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("upload_document");
    expect(names).toContain("query_text_stream");
    expect(names).toContain("get_health");
  });

  it("resolve LightRAG apenas via env quando createMcpServer não recebe baseUrl", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.url).toBe("/health");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    vi.stubEnv("LIGHTRAG_SERVER_URL", baseUrl);

    const server = createMcpServer({
      cwd: process.cwd(),
    }) as unknown as TestMcpServer;
    const client = new Client({
      name: "l-pw2c-lightrag-e2e-env",
      version: "0.0.1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    cleanupTasks.push(async () => {
      await Promise.all([
        server.close(),
        clientTransport.close(),
        serverTransport.close(),
      ]);
    });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await client.callTool({ name: "get_health", arguments: {} });
  });

  it("get_health faz GET /health", async () => {
    let saw = false;
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/health");
      expect(body.length).toBe(0);
      saw = true;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    const out = await client.callTool({ name: "get_health", arguments: {} });
    expect(saw).toBe(true);
    const block = firstTextBlock(out);
    expect(block?.type).toBe("text");
    expect(block?.text).toContain("ok");
  });

  it("devolve erro de validação Zod para argumentos inválidos", async () => {
    const { baseUrl, close } = await startMockServer((_req, res) => {
      res.end();
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    const out = await client.callTool({
      name: "delete_document",
      arguments: {},
    });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toMatch(/Validation/i);
  });

  it("validação Zod quando tipos errados chegam ao servidor", async () => {
    const { baseUrl, close } = await startMockServer((_req, res) => {
      res.end();
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    const out = await client.callTool({
      name: "delete_document",
      arguments: { doc_ids: "não-é-array" },
    } as never);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toMatch(/Validation/i);
  });

  it("erro genérico quando fetch falha", async () => {
    const { baseUrl, close } = await startMockServer(() => {});
    cleanupTasks.push(close);
    const c2 = createMcpServer({
      baseUrl,
      fetchFn: () => Promise.reject(new Error("network-down")),
    }) as unknown as TestMcpServer;
    const cl = new Client({ name: "t", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    cleanupTasks.push(async () => {
      await Promise.all([c2.close(), ct.close(), st.close()]);
    });
    await Promise.all([c2.connect(st), cl.connect(ct)]);
    const out = await cl.callTool({ name: "get_health", arguments: {} });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("network-down");
  });

  it("erro genérico quando a falha não é instância de Error", async () => {
    const { baseUrl, close } = await startMockServer(() => {});
    cleanupTasks.push(close);
    const c2 = createMcpServer({
      baseUrl,
      fetchFn: () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- cobre ramo String(err) quando não é Error
        return Promise.reject({
          toString(): string {
            return "falha-não-error";
          },
        });
      },
    }) as unknown as TestMcpServer;
    const cl = new Client({ name: "t2", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    cleanupTasks.push(async () => {
      await Promise.all([c2.close(), ct.close(), st.close()]);
    });
    await Promise.all([c2.connect(st), cl.connect(ct)]);
    const out = await cl.callTool({ name: "get_health", arguments: {} });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("falha-não-error");
  });

  it("propaga erro HTTP como isError", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      res.statusCode = 422;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ detail: "nope" }));
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    const out = await client.callTool({ name: "get_health", arguments: {} });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("422");
  });

  it("scan_documents faz POST sem corpo JSON", async () => {
    let contentType: string | undefined;
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/documents/scan");
      contentType = req.headers["content-type"];
      expect(body.length).toBe(0);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "queued" }));
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({ name: "scan_documents", arguments: {} });
    expect(contentType).toBeUndefined();
  });

  it("envia X-API-Key quando configurada", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.headers["x-api-key"]).toBe("k-test");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd(), "k-test");
    await client.callTool({ name: "get_health", arguments: {} });
  });

  it("get_health envia cabeçalho lightrag-workspace quando LIGHTRAG_WORKSPACE está definido", async () => {
    vi.stubEnv("LIGHTRAG_WORKSPACE", "  ws-env  ");
    let wsHeader: string | undefined;
    const { baseUrl, close } = await startMockServer((req, res) => {
      const h = req.headers["lightrag-workspace"];
      wsHeader = Array.isArray(h) ? h[0] : h;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({ name: "get_health", arguments: {} });
    expect(wsHeader).toBe("ws-env");
  });

  it("argumento workspace da tool sobrescreve LIGHTRAG_WORKSPACE no mesmo pedido", async () => {
    vi.stubEnv("LIGHTRAG_WORKSPACE", "from-env");
    let wsHeader: string | undefined;
    const { baseUrl, close } = await startMockServer((req, res) => {
      const h = req.headers["lightrag-workspace"];
      wsHeader = Array.isArray(h) ? h[0] : h;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "get_health",
      arguments: { workspace: "from-tool" },
    });
    expect(wsHeader).toBe("from-tool");
  });

  it("get_health sem LIGHTRAG_WORKSPACE nem argumento não envia lightrag-workspace", async () => {
    let wsHeader: string | string[] | undefined;
    const { baseUrl, close } = await startMockServer((req, res) => {
      wsHeader = req.headers["lightrag-workspace"];
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({ name: "get_health", arguments: {} });
    expect(wsHeader).toBeUndefined();
  });

  it("POST JSON inclui X-API-Key no cabeçalho", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.headers["x-api-key"]).toBe("secret-post");
      expect(req.headers["content-type"]).toMatch(/application\/json/);
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(
      baseUrl,
      process.cwd(),
      "secret-post",
    );
    await client.callTool({
      name: "query_data",
      arguments: { query: "q" },
    });
  });

  it("insert_text envia JSON correto", async () => {
    let parsed: unknown;
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/documents/text");
      parsed = JSON.parse(body.toString("utf8")) as unknown;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "insert_text",
      arguments: { text: "hello", file_source: "a.txt" },
    });
    expect(parsed).toEqual({ text: "hello", file_source: "a.txt" });
  });

  it("insert_text usa file_source por omissão", async () => {
    let parsed: { file_source?: string };
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as { file_source?: string };
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "insert_text",
      arguments: { text: "only" },
    });
    expect(parsed!.file_source).toBe("text_input.txt");
  });

  it("insert_texts gera file_sources por omissão", async () => {
    let parsed: { texts: string[]; file_sources: string[] };
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as {
        texts: string[];
        file_sources: string[];
      };
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "insert_texts",
      arguments: { texts: ["a", "b"] },
    });
    expect(parsed!.file_sources).toEqual([
      "text_input_1.txt",
      "text_input_2.txt",
    ]);
  });

  it("upload_document envia multipart com campo file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-mcp-"));
    const fp = path.join(dir, "x.txt");
    await writeFile(fp, "hi", "utf8");

    const { baseUrl, close } = await startMockServer((req, res, body) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/documents/upload");
      const raw = body.toString("utf8");
      expect(raw).toMatch(/name="file"/);
      expect(req.headers["content-type"]).toMatch(/multipart\/form-data/);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ track_id: "t1" }));
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, dir);
    await client.callTool({
      name: "upload_document",
      arguments: { file: "x.txt" },
    });
  });

  it("upload_document aceita base64 quando ficheiro não existe", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-mcp-b64-"));
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      const raw = body.toString("binary");
      expect(raw).toMatch(/name="file"/);
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, dir);
    const b64 = Buffer.from("abc", "utf8").toString("base64");
    await client.callTool({
      name: "upload_document",
      arguments: { file: b64 },
    });
  });

  it("upload_document falha para path fora do cwd", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-mcp-cwd-"));
    const outside = await mkdtemp(path.join(tmpdir(), "lr-out-"));
    const fp = path.join(outside, "secret.txt");
    await writeFile(fp, "x", "utf8");

    const { baseUrl, close } = await startMockServer((_req, res) => {
      res.statusCode = 500;
      res.end();
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, dir);
    const out = await client.callTool({
      name: "upload_document",
      arguments: { file: fp },
    });
    expect(out.isError).toBe(true);
  });

  it("get_documents_paginated usa page e page_size por omissão", async () => {
    let parsed: { page?: number; page_size?: number };
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as {
        page?: number;
        page_size?: number;
      };
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "get_documents_paginated",
      arguments: {},
    });
    expect(parsed!).toEqual({ page: 1, page_size: 50 });
  });

  it("query_text usa top_k 60 por omissão", async () => {
    let parsed: Record<string, unknown>;
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ response: "r" }));
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "query_text",
      arguments: { query: "q1" },
    });
    expect(parsed!).toMatchObject({
      query: "q1",
      mode: "hybrid",
      only_need_context: false,
      top_k: 60,
    });
  });

  it("query_text_stream usa mode por omissão", async () => {
    let parsed: { mode?: string };
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as { mode?: string };
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "query_text_stream",
      arguments: { query: "q" },
    });
    expect(parsed!.mode).toBe("hybrid");
  });

  it("query_text_stream agrega NDJSON", async () => {
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      expect(req.url).toBe("/query/stream");
      expect(JSON.parse(body.toString("utf8"))).toMatchObject({
        stream: true,
      });
      res.setHeader("Content-Type", "application/x-ndjson");
      res.end('{"a":1}\nnot-json\n');
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    const out = await client.callTool({
      name: "query_text_stream",
      arguments: { query: "q" },
    });
    const text = firstTextBlock(out)?.text ?? "";
    expect(text).toContain('"a": 1');
    expect(text).toContain("not-json");
  });

  it("DELETE delete_document envia JSON no corpo", async () => {
    let parsed: unknown;
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      expect(req.method).toBe("DELETE");
      expect(req.url).toBe("/documents/delete_document");
      parsed = JSON.parse(body.toString("utf8")) as unknown;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "delete_document",
      arguments: { doc_ids: ["d1"] },
    });
    expect(parsed).toEqual({ doc_ids: ["d1"] });
  });

  it("get_knowledge_graph envia query params", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.url).toContain("/graphs?");
      expect(req.url).toContain("label=%2A");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "get_knowledge_graph",
      arguments: {},
    });
  });

  it("get_popular_labels usa limit por omissão", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.url).toContain("limit=300");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({ name: "get_popular_labels", arguments: {} });
  });

  it("search_labels usa limit por omissão", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.url).toContain("limit=50");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({ name: "search_labels", arguments: { q: "x" } });
  });

  it("query_data usa mode por omissão", async () => {
    let parsed: { mode?: string };
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as { mode?: string };
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({ name: "query_data", arguments: { query: "q" } });
    expect(parsed!.mode).toBe("hybrid");
  });

  it("update_entity usa allow_rename e allow_merge falsos por omissão", async () => {
    let parsed: { allow_rename?: boolean; allow_merge?: boolean };
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as {
        allow_rename?: boolean;
        allow_merge?: boolean;
      };
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "update_entity",
      arguments: { entity_name: "E", updated_data: { x: 1 } },
    });
    expect(parsed!).toEqual({
      entity_name: "E",
      updated_data: { x: 1 },
      allow_rename: false,
      allow_merge: false,
    });
  });

  it("get_track_status usa path com id", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.url).toBe("/documents/track_status/tr-99");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "get_track_status",
      arguments: { track_id: "tr-99" },
    });
  });

  it("resposta 200 não-JSON devolve texto", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("plain-ok");
    });
    cleanupTasks.push(close);

    const client = await withClientAndServer(baseUrl, process.cwd());
    const out = await client.callTool({ name: "get_health", arguments: {} });
    const text = firstTextBlock(out)?.text ?? "";
    expect(text).toContain("plain-ok");
  });
});

describe("cobertura de ferramentas restantes", () => {
  async function genericOk(
    tool: string,
    args: Record<string, unknown>,
    matchPath: string | RegExp,
    method = "GET",
  ): Promise<void> {
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      expect(req.method).toBe(method);
      const ok =
        typeof matchPath === "string"
          ? req.url === matchPath || req.url?.startsWith(`${matchPath}?`)
          : matchPath.test(req.url ?? "");
      expect(ok).toBe(true);
      if (method !== "GET" && method !== "DELETE") {
        expect(body.length).toBeGreaterThan(0);
      }
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({ name: tool, arguments: args });
  }

  const cases: Array<{
    tool: string;
    args: Record<string, unknown>;
    path: string | RegExp;
    method?: string;
  }> = [
    { tool: "get_documents", args: {}, path: "/documents" },
    {
      tool: "get_documents_paginated",
      args: { page: 2, page_size: 10 },
      path: "/documents/paginated",
      method: "POST",
    },
    { tool: "clear_documents", args: {}, path: "/documents", method: "DELETE" },
    {
      tool: "reprocess_failed_documents",
      args: {},
      path: "/documents/reprocess_failed",
      method: "POST",
    },
    {
      tool: "cancel_pipeline",
      args: {},
      path: "/documents/cancel_pipeline",
      method: "POST",
    },
    {
      tool: "query_data",
      args: { query: "x" },
      path: "/query/data",
      method: "POST",
    },
    { tool: "get_graph_labels", args: {}, path: "/graph/label/list" },
    {
      tool: "get_popular_labels",
      args: { limit: 5 },
      path: /^\/graph\/label\/popular\?/,
    },
    {
      tool: "search_labels",
      args: { q: "foo" },
      path: /^\/graph\/label\/search\?/,
    },
    {
      tool: "check_entity_exists",
      args: { name: "e" },
      path: /^\/graph\/entity\/exists\?/,
    },
    {
      tool: "create_entity",
      args: { entity_name: "E", entity_data: { d: 1 } },
      path: "/graph/entity/create",
      method: "POST",
    },
    {
      tool: "update_entity",
      args: {
        entity_name: "E",
        updated_data: { x: 1 },
        allow_rename: true,
      },
      path: "/graph/entity/edit",
      method: "POST",
    },
    {
      tool: "delete_entity",
      args: { entity_name: "E" },
      path: "/documents/delete_entity",
      method: "DELETE",
    },
    {
      tool: "create_relation",
      args: {
        source_entity: "a",
        target_entity: "b",
        relation_data: { w: 1 },
      },
      path: "/graph/relation/create",
      method: "POST",
    },
    {
      tool: "update_relation",
      args: {
        source_id: "a",
        target_id: "b",
        updated_data: { w: 2 },
      },
      path: "/graph/relation/edit",
      method: "POST",
    },
    {
      tool: "delete_relation",
      args: { source_entity: "a", target_entity: "b" },
      path: "/documents/delete_relation",
      method: "DELETE",
    },
    {
      tool: "merge_entities",
      args: {
        entities_to_change: ["a", "b"],
        entity_to_change_into: "c",
      },
      path: "/graph/entities/merge",
      method: "POST",
    },
    {
      tool: "get_pipeline_status",
      args: {},
      path: "/documents/pipeline_status",
    },
    {
      tool: "get_document_status_counts",
      args: {},
      path: "/documents/status_counts",
    },
    {
      tool: "clear_cache",
      args: {},
      path: "/documents/clear_cache",
      method: "POST",
    },
  ];

  it.each(cases)("$tool", async ({ tool, args, path: p, method }) => {
    await genericOk(tool, args, p, method ?? "GET");
  });
});

describe("createMcpServer com env inválido", () => {
  it("lança se LIGHTRAG_SERVER_URL inválida e sem baseUrl injectada", () => {
    vi.stubEnv("LIGHTRAG_SERVER_URL", ":::");
    expect(() => createMcpServer()).toThrow();
  });
});

describe("lightrag-client ramos adicionais", () => {
  it("parseResponse devolve null para corpo vazio em sucesso", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      res.statusCode = 200;
      res.end();
    });
    cleanupTasks.push(close);
    const c = createLightragClient({ baseUrl });
    await expect(c.getJson("/health")).resolves.toBeNull();
  });

  it("parseResponse devolve texto se JSON inválido em sucesso", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("{not-json");
    });
    cleanupTasks.push(close);
    const c = createLightragClient({ baseUrl });
    await expect(c.getJson("/x")).resolves.toBe("{not-json");
  });

  it("postQueryStream lança LightragHttpError em erro HTTP", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      res.statusCode = 503;
      res.end("down");
    });
    cleanupTasks.push(close);
    const c = createLightragClient({ baseUrl });
    await expect(
      c.postQueryStream({ query: "q", mode: "hybrid" }),
    ).rejects.toThrow(/503/);
  });

  it("resolveUploadInput rejeita diretório", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-dir-"));
    await expect(resolveUploadInput(dir, dir)).rejects.toThrow(/regular file/);
  });

  it("usa fetch injectado", async () => {
    const c = createLightragClient({
      baseUrl: "http://127.0.0.1:9",
      fetchFn: () =>
        Promise.resolve(
          new Response(JSON.stringify({ injected: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    });
    await expect(c.getJson("/any")).resolves.toEqual({ injected: true });
  });

  it("getJsonWithParams ignora null e undefined e serializa objetos", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.url).toContain("a=1");
      expect(req.url).toContain("nested=");
      expect(req.url).not.toContain("b=");
      expect(req.url).not.toContain("c=");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const c = createLightragClient({ baseUrl });
    await c.getJsonWithParams("/z", {
      a: 1,
      b: undefined,
      c: null,
      nested: { k: true },
    } as Record<string, unknown>);
  });
});

describe("tools com argumentos opcionais explícitos", () => {
  it("query_text com mode e flags não predefinidos", async () => {
    let parsed: Record<string, unknown>;
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "query_text",
      arguments: {
        query: "q",
        mode: "local",
        only_need_context: true,
        top_k: 12,
      },
    });
    expect(parsed!).toMatchObject({
      mode: "local",
      only_need_context: true,
      top_k: 12,
    });
  });

  it("get_knowledge_graph com parâmetros explícitos", async () => {
    const { baseUrl, close } = await startMockServer((req, res) => {
      expect(req.url).toContain("max_depth=5");
      expect(req.url).toContain("max_nodes=50");
      expect(req.url).toContain("label=Person");
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "get_knowledge_graph",
      arguments: {
        label: "Person",
        max_depth: 5,
        max_nodes: 50,
      },
    });
  });

  it("update_entity com allow_merge true", async () => {
    let parsed: Record<string, unknown>;
    const { baseUrl, close } = await startMockServer((req, res, body) => {
      parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    });
    cleanupTasks.push(close);
    const client = await withClientAndServer(baseUrl, process.cwd());
    await client.callTool({
      name: "update_entity",
      arguments: {
        entity_name: "E",
        updated_data: { a: 1 },
        allow_rename: true,
        allow_merge: true,
      },
    });
    expect(parsed!).toMatchObject({
      allow_rename: true,
      allow_merge: true,
    });
  });
});
