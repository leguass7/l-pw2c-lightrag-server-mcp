import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Cabeçalho HTTP esperado pelo LightRAG Server (HKUDS) para isolamento por workspace. */
export const LIGHTRAG_WORKSPACE_HEADER = "LIGHTRAG-WORKSPACE";

export class LightragHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = "LightragHttpError";
  }
}

export interface LightragClientOptions {
  baseUrl: string;
  apiKey?: string;
  /** Workspace por defeito; sobrescrito por `LightragRequestOptions.workspace` em cada pedido. */
  defaultWorkspace?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Working directory for resolving relative file paths in upload_document */
  cwd?: string;
}

/** Opções por pedido (ex.: override de workspace vindo da tool MCP). */
export interface LightragRequestOptions {
  workspace?: string;
}

function joinUrl(baseUrl: string, pathname: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const pathPart = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${pathPart}`;
}

export function isPathInsideDir(filePath: string, dir: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(dir);
  const rel = path.relative(resolvedDir, resolvedFile);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve upload input: local file path (must be inside cwd) or base64-encoded bytes.
 */
export async function resolveUploadInput(
  file: string,
  cwd: string,
): Promise<{ blob: Blob; filename: string }> {
  const cwdResolved = path.resolve(cwd);
  const candidate = path.isAbsolute(file)
    ? path.normalize(file)
    : path.resolve(cwdResolved, file);

  if (!isPathInsideDir(candidate, cwdResolved)) {
    throw new Error("File path must be inside the working directory");
  }

  try {
    const s = await stat(candidate);
    if (!s.isFile()) {
      throw new Error("Path must be a regular file");
    }
    const buf = await readFile(candidate);
    return {
      blob: new Blob([new Uint8Array(buf)]),
      filename: path.basename(candidate),
    };
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? e.code : undefined;
    if (code !== "ENOENT") {
      throw e;
    }
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(file, "base64");
  } catch {
    throw new Error("Invalid base64 or file not found");
  }
  if (buf.length === 0 && file.trim().length > 0) {
    throw new Error("Invalid base64 or file not found");
  }
  return { blob: new Blob([new Uint8Array(buf)]), filename: "upload.bin" };
}

export class LightragClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly defaultWorkspace: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(options: LightragClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    const dw = options.defaultWorkspace?.trim();
    this.defaultWorkspace = dw && dw.length > 0 ? dw : undefined;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.cwd = options.cwd ?? process.cwd();
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  /** Tool override > default env > omit. */
  private resolveWorkspace(override?: string): string | undefined {
    const t = (s: string | undefined) => {
      const x = s?.trim();
      return x && x.length > 0 ? x : undefined;
    };
    return t(override) ?? t(this.defaultWorkspace);
  }

  private appendCommonHeaders(h: Headers, workspaceOverride?: string): void {
    if (this.apiKey) {
      h.set("X-API-Key", this.apiKey);
    }
    const ws = this.resolveWorkspace(workspaceOverride);
    if (ws) {
      h.set(LIGHTRAG_WORKSPACE_HEADER, ws);
    }
  }

  private jsonHeaders(workspaceOverride?: string): Headers {
    const h = new Headers();
    h.set("Content-Type", "application/json");
    this.appendCommonHeaders(h, workspaceOverride);
    return h;
  }

  private authHeaders(workspaceOverride?: string): Headers {
    const h = new Headers();
    this.appendCommonHeaders(h, workspaceOverride);
    return h;
  }

  private multipartHeaders(workspaceOverride?: string): Headers {
    const h = new Headers();
    this.appendCommonHeaders(h, workspaceOverride);
    return h;
  }

  private async parseResponse(
    res: Response,
    method: string,
    url: string,
  ): Promise<unknown> {
    const text = await res.text();
    if (!res.ok) {
      throw new LightragHttpError(
        `LightRAG HTTP ${res.status} on ${method} ${url}`,
        res.status,
        text,
      );
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async getJson(
    pathname: string,
    req?: LightragRequestOptions,
  ): Promise<unknown> {
    const url = joinUrl(this.baseUrl, pathname);
    const ws = req?.workspace;
    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.authHeaders(ws),
      signal: this.signal(),
    });
    return this.parseResponse(res, "GET", url);
  }

  async getJsonWithParams(
    pathname: string,
    params: Record<string, unknown>,
    req?: LightragRequestOptions,
  ): Promise<unknown> {
    const u = new URL(joinUrl(this.baseUrl, pathname));
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        const encoded =
          typeof v === "string" ||
          typeof v === "number" ||
          typeof v === "boolean"
            ? String(v)
            : JSON.stringify(v);
        u.searchParams.set(k, encoded);
      }
    }
    const ws = req?.workspace;
    const res = await this.fetchFn(u.toString(), {
      method: "GET",
      headers: this.authHeaders(ws),
      signal: this.signal(),
    });
    return this.parseResponse(res, "GET", u.toString());
  }

  async postJson(
    pathname: string,
    body: unknown,
    req?: LightragRequestOptions,
  ): Promise<unknown> {
    const url = joinUrl(this.baseUrl, pathname);
    const ws = req?.workspace;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.jsonHeaders(ws),
      body: JSON.stringify(body),
      signal: this.signal(),
    });
    return this.parseResponse(res, "POST", url);
  }

  /** POST without body (e.g. scan). */
  async postNoBody(
    pathname: string,
    req?: LightragRequestOptions,
  ): Promise<unknown> {
    const url = joinUrl(this.baseUrl, pathname);
    const ws = req?.workspace;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.authHeaders(ws),
      signal: this.signal(),
    });
    return this.parseResponse(res, "POST", url);
  }

  async deleteJson(
    pathname: string,
    body?: unknown,
    req?: LightragRequestOptions,
  ): Promise<unknown> {
    const url = joinUrl(this.baseUrl, pathname);
    const ws = req?.workspace;
    const res = await this.fetchFn(url, {
      method: "DELETE",
      headers: this.jsonHeaders(ws),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: this.signal(),
    });
    return this.parseResponse(res, "DELETE", url);
  }

  async postMultipartUpload(
    fileInput: string,
    req?: LightragRequestOptions,
  ): Promise<unknown> {
    const { blob, filename } = await resolveUploadInput(fileInput, this.cwd);
    const form = new FormData();
    form.append("file", blob, filename);
    const url = joinUrl(this.baseUrl, "/documents/upload");
    const ws = req?.workspace;
    const headers = this.multipartHeaders(ws);
    const res = await this.fetchFn(url, {
      method: "POST",
      body: form,
      headers,
      signal: this.signal(),
    });
    return this.parseResponse(res, "POST", url);
  }

  /**
   * NDJSON stream: aggregate lines into a JSON array string for MCP text content.
   */
  async postQueryStream(
    body: {
      query: string;
      mode: string;
      stream?: boolean;
    },
    req?: LightragRequestOptions,
  ): Promise<string> {
    const url = joinUrl(this.baseUrl, "/query/stream");
    const ws = req?.workspace;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.jsonHeaders(ws),
      body: JSON.stringify({ ...body, stream: true }),
      signal: this.signal(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new LightragHttpError(
        `LightRAG HTTP ${res.status} on POST ${url}`,
        res.status,
        text,
      );
    }
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const parsed: unknown[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as unknown);
      } catch {
        parsed.push(line);
      }
    }
    return JSON.stringify(parsed, null, 2);
  }
}

export function createLightragClient(
  options: LightragClientOptions,
): LightragClient {
  return new LightragClient(options);
}
