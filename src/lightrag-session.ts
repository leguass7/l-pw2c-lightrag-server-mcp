import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";

import {
  type AppConfig,
  type HttpOverrideSettings,
  LightragOverrideError,
  logLightragOverrideError,
  mergeLightragConfig,
  parseOverrideHeaders,
  validateUpstreamHost,
} from "./config.js";
import {
  createLightragClient,
  type LightragClient,
  type LightragClientOptions,
} from "./lightrag-client.js";

export interface SessionRequestContext {
  sessionId?: string;
}

export const sessionRequestAls = new AsyncLocalStorage<SessionRequestContext>();

function appConfigToClientOptions(cfg: AppConfig): LightragClientOptions {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
    defaultWorkspace: cfg.defaultWorkspace,
  };
}

function hasOverrides(overrides: Partial<AppConfig>): boolean {
  return (
    overrides.baseUrl !== undefined ||
    overrides.apiKey !== undefined ||
    overrides.defaultWorkspace !== undefined ||
    overrides.timeoutMs !== undefined
  );
}

/**
 * Per-session LightRAG client resolution for HTTP mode (`--sse`).
 */
export class SessionOverrideStore {
  private readonly envConfig: AppConfig;
  private readonly httpSettings: HttpOverrideSettings;
  private pendingConfig: AppConfig | null = null;
  private readonly sessionConfigs = new Map<string, AppConfig>();
  private readonly sessionClients = new Map<string, LightragClient>();
  private readonly defaultClient: LightragClient;

  constructor(envConfig: AppConfig, httpSettings: HttpOverrideSettings) {
    this.envConfig = envConfig;
    this.httpSettings = httpSettings;
    this.defaultClient = createLightragClient(
      appConfigToClientOptions(envConfig),
    );
  }

  /**
   * Parse headers, merge with env, validate host allowlist; update pending or session.
   */
  applyRequestHeaders(
    req: IncomingMessage,
    sessionId: string | undefined,
  ): void {
    if (!this.httpSettings.headerOverridesEnabled) {
      if (hasOverrides(parseOverrideHeaders(req))) {
        logLightragOverrideError(
          "header overrides ignored: MCP_HTTP_HEADER_OVERRIDES is disabled",
        );
      }
      return;
    }

    const partial = parseOverrideHeaders(req);
    if (!hasOverrides(partial)) {
      return;
    }

    const merged = mergeLightragConfig(this.envConfig, partial);
    if (partial.baseUrl !== undefined) {
      validateUpstreamHost(merged.baseUrl, this.httpSettings.allowedHosts);
    }

    if (sessionId) {
      this.sessionConfigs.set(sessionId, merged);
      this.sessionClients.delete(sessionId);
    } else {
      this.pendingConfig = merged;
    }
  }

  commitPending(sessionId: string): void {
    const cfg = this.pendingConfig ?? { ...this.envConfig };
    this.sessionConfigs.set(sessionId, cfg);
    this.pendingConfig = null;
  }

  remove(sessionId: string): void {
    this.sessionConfigs.delete(sessionId);
    this.sessionClients.delete(sessionId);
  }

  getClient(): LightragClient {
    const ctx = sessionRequestAls.getStore();
    const sessionId = ctx?.sessionId;
    if (sessionId && this.sessionConfigs.has(sessionId)) {
      let client = this.sessionClients.get(sessionId);
      if (!client) {
        const cfg = this.sessionConfigs.get(sessionId);
        if (!cfg) {
          /* v8 ignore start */
          logLightragOverrideError(
            `session "${sessionId}" missing config; using env defaults`,
          );
          return this.defaultClient;
          /* v8 ignore end */
        }
        client = createLightragClient(appConfigToClientOptions(cfg));
        this.sessionClients.set(sessionId, client);
      }
      return client;
    }
    return this.defaultClient;
  }
}

export function readMcpSessionId(req: IncomingMessage): string | undefined {
  const raw = req.headers["mcp-session-id"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") {
    return undefined;
  }
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export { LightragOverrideError };
