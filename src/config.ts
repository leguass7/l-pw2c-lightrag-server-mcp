import type { IncomingMessage } from "node:http";

export interface AppConfig {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  /** Workspace LightRAG por defeito (cabeçalho `LIGHTRAG-WORKSPACE`); sobrescrito pelo argumento `workspace` da tool. */
  defaultWorkspace: string | undefined;
}

export interface HttpServerConfig {
  port: number;
  host: string;
}

export interface HttpOverrideSettings {
  headerOverridesEnabled: boolean;
  /** Hostnames permitidos; `*` permite qualquer host http(s). Lista vazia no env → `*`. */
  allowedHosts: string[];
}

export type LightragConfigOverrides = Partial<AppConfig>;

/** Cabeçalhos HTTP (Node normaliza para minúsculas). */
export const LIGHTRAG_SERVER_URL_HEADER = "lightrag-server-url";
export const LIGHTRAG_API_KEY_HEADER = "lightrag-api-key";
export const LIGHTRAG_WORKSPACE_HEADER = "lightrag-workspace";

const LOG_PREFIX = "[LIGHTRAG]";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_PORT = 8000;
const DEFAULT_HTTP_HOST = "0.0.0.0";

export class LightragOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LightragOverrideError";
  }
}

export function logLightragOverrideError(message: string): void {
  console.error(`${LOG_PREFIX} ${message}`);
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new LightragOverrideError("LIGHTRAG_SERVER_URL is empty");
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new LightragOverrideError(
        "LIGHTRAG_SERVER_URL must be http or https",
      );
    }
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch (e) {
    if (e instanceof LightragOverrideError) {
      throw e;
    }
    if (e instanceof TypeError) {
      throw new LightragOverrideError(
        `LIGHTRAG_SERVER_URL is not a valid URL: ${raw}`,
      );
    }
    throw e;
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string") {
    return undefined;
  }
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export function parseOverrideHeaders(
  req: IncomingMessage,
): LightragConfigOverrides {
  const overrides: LightragConfigOverrides = {};
  const url = headerValue(req, LIGHTRAG_SERVER_URL_HEADER);
  if (url !== undefined) {
    overrides.baseUrl = normalizeBaseUrl(url);
  }
  const apiKey = headerValue(req, LIGHTRAG_API_KEY_HEADER);
  if (apiKey !== undefined) {
    overrides.apiKey = apiKey;
  }
  const ws = headerValue(req, LIGHTRAG_WORKSPACE_HEADER);
  if (ws !== undefined) {
    overrides.defaultWorkspace = ws;
  }
  return overrides;
}

export function mergeLightragConfig(
  env: AppConfig,
  overrides: LightragConfigOverrides,
): AppConfig {
  return {
    baseUrl: overrides.baseUrl ?? env.baseUrl,
    apiKey: overrides.apiKey !== undefined ? overrides.apiKey : env.apiKey,
    timeoutMs: overrides.timeoutMs ?? env.timeoutMs,
    defaultWorkspace:
      overrides.defaultWorkspace !== undefined
        ? overrides.defaultWorkspace
        : env.defaultWorkspace,
  };
}

export function parseAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return ["*"];
  }
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

export function validateUpstreamHost(
  baseUrl: string,
  allowedHosts: string[],
): void {
  const normalized = normalizeBaseUrl(baseUrl);
  const hostname = new URL(normalized).hostname.toLowerCase();
  const allowed = allowedHosts.map((h) => h.toLowerCase());

  if (allowed.includes("*")) {
    return;
  }

  if (!allowed.includes(hostname)) {
    const msg = `header override rejected: host "${hostname}" not in MCP_ALLOWED_LIGHTRAG_HOSTS (allowed: ${allowedHosts.join(", ")})`;
    logLightragOverrideError(msg);
    throw new LightragOverrideError(msg);
  }
}

export function loadConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const rawUrl = env.LIGHTRAG_SERVER_URL ?? "http://localhost:9621";
  const baseUrl = normalizeBaseUrl(rawUrl);
  const apiKey = env.LIGHTRAG_API_KEY?.trim() || undefined;
  const timeoutRaw = env.LIGHTRAG_TIMEOUT_MS;
  const timeoutMs = timeoutRaw
    ? Number.parseInt(timeoutRaw, 10)
    : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("LIGHTRAG_TIMEOUT_MS must be a positive number");
  }
  const ws = env.LIGHTRAG_WORKSPACE?.trim();
  const defaultWorkspace = ws && ws.length > 0 ? ws : undefined;
  return { baseUrl, apiKey, timeoutMs, defaultWorkspace };
}

export function loadHttpOverrideSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpOverrideSettings {
  const flag = env.MCP_HTTP_HEADER_OVERRIDES?.trim().toLowerCase();
  const headerOverridesEnabled = flag !== "false" && flag !== "0";
  const allowedHosts = parseAllowedHosts(env.MCP_ALLOWED_LIGHTRAG_HOSTS);
  return { headerOverridesEnabled, allowedHosts };
}

export function loadHttpServerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpServerConfig {
  const portRaw = env.MCP_HTTP_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_HTTP_PORT;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error("MCP_HTTP_PORT must be a valid port number (0–65535)");
  }
  const host = env.MCP_HTTP_HOST?.trim() || DEFAULT_HTTP_HOST;
  return { port, host };
}
