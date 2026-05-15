import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { LightragOverrideError, loadConfigFromEnv } from "./config.js";
import {
  createLightragClient,
  LightragHttpError,
  type LightragClient,
  type LightragClientOptions,
} from "./lightrag-client.js";
import type { SessionOverrideStore } from "./lightrag-session.js";
import { readPackageJsonVersion } from "./version.js";

const queryModeEnum = z.enum(["naive", "local", "global", "hybrid", "mix"]);

/** Campo opcional comum a todas as tools (override do workspace por chamada). */
function withWorkspace(
  inner: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> {
  return inner.extend({ workspace: z.string().optional() });
}

function workspaceFromTool(p: { workspace?: unknown }): string | undefined {
  const w = p.workspace;
  if (typeof w !== "string") {
    return undefined;
  }
  const t = w.trim();
  return t.length > 0 ? t : undefined;
}

function omitWorkspace<T extends { workspace?: unknown }>(
  p: T,
): Omit<T, "workspace"> {
  const { workspace, ...rest } = p;
  void workspace;
  return rest;
}

function resolveClientOptions(
  deps?: Partial<LightragClientOptions>,
): LightragClientOptions {
  const fromEnv = loadConfigFromEnv();
  if (deps?.baseUrl) {
    return {
      baseUrl: deps.baseUrl,
      apiKey: deps.apiKey,
      fetchFn: deps.fetchFn,
      timeoutMs: deps.timeoutMs,
      cwd: deps.cwd,
      defaultWorkspace: deps.defaultWorkspace ?? fromEnv.defaultWorkspace,
    };
  }
  return {
    baseUrl: fromEnv.baseUrl,
    apiKey: fromEnv.apiKey,
    fetchFn: deps?.fetchFn,
    timeoutMs: deps?.timeoutMs ?? fromEnv.timeoutMs,
    cwd: deps?.cwd,
    defaultWorkspace: deps?.defaultWorkspace ?? fromEnv.defaultWorkspace,
  };
}

function jsonText(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

function formatError(err: unknown): { text: string; isError: true } {
  if (err instanceof z.ZodError) {
    /* v8 ignore next 2 */
    const msg = err.issues.map((i) => i.message).join("; ");
    return { text: `Validation: ${msg}`, isError: true };
  }
  if (err instanceof LightragOverrideError) {
    return { text: `Error: ${err.message}`, isError: true };
  }
  if (err instanceof LightragHttpError) {
    return {
      text: `Error: ${err.message}\n${err.responseBody}`,
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { text: `Error: ${msg}`, isError: true };
}

export interface CreateMcpServerOptions {
  sessionStore?: SessionOverrideStore;
}

/**
 * Create MCP server proxying LightRAG HTTP API (transport connected in cli / transport modules).
 */
export function createMcpServer(
  deps?: Partial<LightragClientOptions>,
  options?: CreateMcpServerOptions,
): McpServer {
  const opts = resolveClientOptions(deps);
  const defaultClient = createLightragClient(opts);
  const getClient = (): LightragClient =>
    options?.sessionStore?.getClient() ?? defaultClient;

  const server = new McpServer({
    name: "l-pw2c-lightrag-server-mcp",
    version: readPackageJsonVersion(),
  });

  const registerZod = <T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    run: (args: T) => Promise<unknown>,
    /** Shape exposto ao cliente MCP quando o schema usa .transform() */
    mcpInputShape?: Record<string, z.ZodType>,
  ): void => {
    const inputSchema =
      mcpInputShape ??
      (schema instanceof z.ZodObject
        ? (schema.shape as Record<string, z.ZodType>)
        : {});
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const parsed = schema.parse(args);
        const out = await run(parsed);
        return {
          content: [{ type: "text", text: jsonText(out) }],
        };
      } catch (e) {
        const { text, isError } = formatError(e);
        return {
          content: [{ type: "text", text }],
          isError,
        };
      }
    });
  };

  const workspaceOnlySchema = z.object({ workspace: z.string().optional() });

  // —— Documents (10) ——
  registerZod(
    "insert_text",
    "Insert a single text document into LightRAG",
    withWorkspace(
      z.object({
        text: z.string(),
        file_source: z.string().default("text_input.txt"),
      }),
    ),
    (p) =>
      getClient().postJson("/documents/text", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "insert_texts",
    "Insert multiple text documents into LightRAG in batch",
    z
      .object({
        texts: z.array(z.string()),
        file_sources: z.array(z.string()).optional(),
        workspace: z.string().optional(),
      })
      .transform((data) => ({
        texts: data.texts,
        file_sources:
          data.file_sources ??
          data.texts.map((_, i) => `text_input_${String(i + 1)}.txt`),
        workspace: data.workspace,
      })),
    (p) =>
      getClient().postJson("/documents/texts", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
    {
      texts: z.array(z.string()),
      file_sources: z.array(z.string()).optional(),
      workspace: z.string().optional(),
    },
  );

  registerZod(
    "upload_document",
    "Upload a document: local file path (under cwd) or base64-encoded bytes",
    withWorkspace(z.object({ file: z.string() })),
    (p) =>
      getClient().postMultipartUpload(
        (omitWorkspace(p) as { file: string }).file,
        {
          workspace: workspaceFromTool(p),
        },
      ),
  );

  registerZod(
    "scan_documents",
    "Scan for new documents in the configured directory",
    workspaceOnlySchema,
    (p) =>
      getClient().postNoBody("/documents/scan", {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "get_documents",
    "Retrieve all documents from LightRAG",
    workspaceOnlySchema,
    (p) =>
      getClient().getJson("/documents", { workspace: workspaceFromTool(p) }),
  );

  registerZod(
    "get_documents_paginated",
    "Retrieve documents with pagination",
    withWorkspace(
      z.object({
        page: z.number().default(1),
        page_size: z.number().default(50),
      }),
    ),
    (p) =>
      getClient().postJson("/documents/paginated", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "delete_document",
    "Delete specific documents by IDs",
    withWorkspace(z.object({ doc_ids: z.array(z.string()) })),
    (p) =>
      getClient().deleteJson("/documents/delete_document", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "clear_documents",
    "Clear all documents from LightRAG",
    workspaceOnlySchema,
    (p) =>
      getClient().deleteJson("/documents", undefined, {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "reprocess_failed_documents",
    "Reprocess failed and pending documents",
    workspaceOnlySchema,
    (p) =>
      getClient().postJson(
        "/documents/reprocess_failed",
        {},
        {
          workspace: workspaceFromTool(p),
        },
      ),
  );

  registerZod(
    "cancel_pipeline",
    "Cancel the currently running pipeline",
    workspaceOnlySchema,
    (p) =>
      getClient().postJson(
        "/documents/cancel_pipeline",
        {},
        {
          workspace: workspaceFromTool(p),
        },
      ),
  );

  // —— Query (3) ——
  registerZod(
    "query_text",
    "Query LightRAG with text using various retrieval modes",
    withWorkspace(
      z.object({
        query: z.string(),
        mode: queryModeEnum.default("hybrid"),
        only_need_context: z.boolean().default(false),
        top_k: z.number().default(60),
      }),
    ),
    (p) =>
      getClient().postJson("/query", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "query_text_stream",
    "Stream query results from LightRAG (NDJSON aggregated)",
    withWorkspace(
      z.object({
        query: z.string(),
        mode: queryModeEnum.default("hybrid"),
      }),
    ),
    (p) => {
      const b = omitWorkspace(p) as { query: string; mode: string };
      return getClient().postQueryStream(
        { query: b.query, mode: b.mode, stream: true },
        { workspace: workspaceFromTool(p) },
      );
    },
  );

  registerZod(
    "query_data",
    "Get raw retrieval data without full LLM answer",
    withWorkspace(
      z.object({
        query: z.string(),
        mode: queryModeEnum.default("hybrid"),
      }),
    ),
    (p) =>
      getClient().postJson("/query/data", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  // —— Graph (12) ——
  registerZod(
    "get_knowledge_graph",
    "Retrieve knowledge graph for a specific label or all entities",
    withWorkspace(
      z.object({
        label: z.string().default("*"),
        max_depth: z.number().default(3),
        max_nodes: z.number().default(1000),
      }),
    ),
    (p) =>
      getClient().getJsonWithParams("/graphs", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "get_graph_labels",
    "Get all graph labels",
    workspaceOnlySchema,
    (p) =>
      getClient().getJson("/graph/label/list", {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "get_popular_labels",
    "Get popular labels by node degree",
    withWorkspace(z.object({ limit: z.number().default(300) })),
    (p) =>
      getClient().getJsonWithParams("/graph/label/popular", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "search_labels",
    "Search labels with fuzzy matching",
    withWorkspace(
      z.object({
        q: z.string(),
        limit: z.number().default(50),
      }),
    ),
    (p) =>
      getClient().getJsonWithParams("/graph/label/search", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "check_entity_exists",
    "Check if an entity exists in the knowledge graph",
    withWorkspace(z.object({ name: z.string() })),
    (p) => {
      const b = omitWorkspace(p) as { name: string };
      return getClient().getJsonWithParams(
        "/graph/entity/exists",
        { name: b.name },
        { workspace: workspaceFromTool(p) },
      );
    },
  );

  registerZod(
    "create_entity",
    "Create a new entity in the knowledge graph",
    withWorkspace(
      z.object({
        entity_name: z.string(),
        entity_data: z.record(z.string(), z.unknown()),
      }),
    ),
    (p) =>
      getClient().postJson("/graph/entity/create", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "update_entity",
    "Update an entity in the knowledge graph",
    withWorkspace(
      z.object({
        entity_name: z.string(),
        updated_data: z.record(z.string(), z.unknown()),
        allow_rename: z.boolean().default(false),
        allow_merge: z.boolean().default(false),
      }),
    ),
    (p) =>
      getClient().postJson("/graph/entity/edit", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "delete_entity",
    "Delete an entity from the knowledge graph",
    withWorkspace(z.object({ entity_name: z.string() })),
    (p) =>
      getClient().deleteJson("/documents/delete_entity", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "create_relation",
    "Create a new relationship between entities",
    withWorkspace(
      z.object({
        source_entity: z.string(),
        target_entity: z.string(),
        relation_data: z.record(z.string(), z.unknown()),
      }),
    ),
    (p) =>
      getClient().postJson("/graph/relation/create", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "update_relation",
    "Update a relationship in the knowledge graph",
    withWorkspace(
      z.object({
        source_id: z.string(),
        target_id: z.string(),
        updated_data: z.record(z.string(), z.unknown()),
      }),
    ),
    (p) =>
      getClient().postJson("/graph/relation/edit", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "delete_relation",
    "Delete a relationship from the knowledge graph",
    withWorkspace(
      z.object({
        source_entity: z.string(),
        target_entity: z.string(),
      }),
    ),
    (p) =>
      getClient().deleteJson("/documents/delete_relation", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "merge_entities",
    "Merge multiple entities into a single entity",
    withWorkspace(
      z.object({
        entities_to_change: z.array(z.string()),
        entity_to_change_into: z.string(),
      }),
    ),
    (p) =>
      getClient().postJson("/graph/entities/merge", omitWorkspace(p), {
        workspace: workspaceFromTool(p),
      }),
  );

  // —— System (5) ——
  registerZod(
    "get_pipeline_status",
    "Get the processing pipeline status",
    workspaceOnlySchema,
    (p) =>
      getClient().getJson("/documents/pipeline_status", {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "get_track_status",
    "Get track status by ID",
    withWorkspace(z.object({ track_id: z.string() })),
    (p) => {
      const b = omitWorkspace(p) as { track_id: string };
      return getClient().getJson(`/documents/track_status/${b.track_id}`, {
        workspace: workspaceFromTool(p),
      });
    },
  );

  registerZod(
    "get_document_status_counts",
    "Get document status counts",
    workspaceOnlySchema,
    (p) =>
      getClient().getJson("/documents/status_counts", {
        workspace: workspaceFromTool(p),
      }),
  );

  registerZod(
    "clear_cache",
    "Clear LightRAG internal cache",
    workspaceOnlySchema,
    (p) =>
      getClient().postJson(
        "/documents/clear_cache",
        {},
        {
          workspace: workspaceFromTool(p),
        },
      ),
  );

  registerZod(
    "get_health",
    "Check LightRAG server health status",
    workspaceOnlySchema,
    (p) => getClient().getJson("/health", { workspace: workspaceFromTool(p) }),
  );

  return server;
}
