import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  LIGHTRAG_SERVER_URL_HEADER,
  LightragOverrideError,
  loadConfigFromEnv,
  mergeLightragConfig,
  parseAllowedHosts,
  parseOverrideHeaders,
  validateUpstreamHost,
} from "../src/config.js";
import {
  readMcpSessionId,
  SessionOverrideStore,
  sessionRequestAls,
} from "../src/lightrag-session.js";

function mockReq(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("config overrides", () => {
  it("parseAllowedHosts vazio devolve *", () => {
    expect(parseAllowedHosts(undefined)).toEqual(["*"]);
    expect(parseAllowedHosts("  ")).toEqual(["*"]);
  });

  it("validateUpstreamHost aceita * na allowlist", () => {
    expect(() =>
      validateUpstreamHost("https://any-host.example.com", ["*"]),
    ).not.toThrow();
  });

  it("validateUpstreamHost rejeita host não listado", () => {
    expect(() =>
      validateUpstreamHost("https://evil.example.com", ["127.0.0.1"]),
    ).toThrow(LightragOverrideError);
  });

  it("parseOverrideHeaders rejeita URL inválida", () => {
    expect(() =>
      parseOverrideHeaders(
        mockReq({ [LIGHTRAG_SERVER_URL_HEADER]: "not-a-url" }),
      ),
    ).toThrow(LightragOverrideError);
  });

  it("mergeLightragConfig preserva apiKey env quando override omite key", () => {
    const env = loadConfigFromEnv({
      LIGHTRAG_SERVER_URL: "http://127.0.0.1:1",
      LIGHTRAG_API_KEY: "env-key",
    });
    const merged = mergeLightragConfig(env, {
      baseUrl: "http://127.0.0.1:2",
    });
    expect(merged.apiKey).toBe("env-key");
    expect(merged.baseUrl).toBe("http://127.0.0.1:2");
  });
});

describe("readMcpSessionId", () => {
  it("lê string e ignora vazio", () => {
    expect(readMcpSessionId(mockReq({ "mcp-session-id": "abc" }))).toBe("abc");
    expect(
      readMcpSessionId(mockReq({ "mcp-session-id": "  " })),
    ).toBeUndefined();
  });

  it("lê primeiro valor de array", () => {
    expect(
      readMcpSessionId(mockReq({ "mcp-session-id": ["id1", "id2"] })),
    ).toBe("id1");
  });
});

describe("SessionOverrideStore", () => {
  it("getClient usa cliente de sessão após commitPending", () => {
    const env = loadConfigFromEnv({
      LIGHTRAG_SERVER_URL: "http://127.0.0.1:9621",
    });
    const store = new SessionOverrideStore(env, {
      headerOverridesEnabled: true,
      allowedHosts: ["*"],
    });
    store.applyRequestHeaders(
      mockReq({
        [LIGHTRAG_SERVER_URL_HEADER]: "http://127.0.0.1:9999",
      }),
      undefined,
    );
    store.commitPending("sess-1");
    const client = sessionRequestAls.run({ sessionId: "sess-1" }, () =>
      store.getClient(),
    );
    expect(client).toBeDefined();
  });

  it("getClient reutiliza cliente em cache na mesma sessão", () => {
    const env = loadConfigFromEnv({
      LIGHTRAG_SERVER_URL: "http://127.0.0.1:9621",
    });
    const store = new SessionOverrideStore(env, {
      headerOverridesEnabled: true,
      allowedHosts: ["*"],
    });
    store.commitPending("sess-cache");
    const c1 = sessionRequestAls.run({ sessionId: "sess-cache" }, () =>
      store.getClient(),
    );
    const c2 = sessionRequestAls.run({ sessionId: "sess-cache" }, () =>
      store.getClient(),
    );
    expect(c1).toBe(c2);
  });

  it("remove limpa sessão", () => {
    const env = loadConfigFromEnv({
      LIGHTRAG_SERVER_URL: "http://127.0.0.1:9621",
    });
    const store = new SessionOverrideStore(env, {
      headerOverridesEnabled: true,
      allowedHosts: ["*"],
    });
    store.commitPending("sess-2");
    store.remove("sess-2");
    const client = sessionRequestAls.run({ sessionId: "sess-2" }, () =>
      store.getClient(),
    );
    expect(client).toBeDefined();
  });

  it("applyRequestHeaders com overrides desativados sem headers não regista log", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = loadConfigFromEnv({
      LIGHTRAG_SERVER_URL: "http://127.0.0.1:9621",
    });
    const store = new SessionOverrideStore(env, {
      headerOverridesEnabled: false,
      allowedHosts: ["*"],
    });
    store.applyRequestHeaders(mockReq({}), undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("applyRequestHeaders com overrides desativados regista log", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = loadConfigFromEnv({
      LIGHTRAG_SERVER_URL: "http://127.0.0.1:9621",
    });
    const store = new SessionOverrideStore(env, {
      headerOverridesEnabled: false,
      allowedHosts: ["*"],
    });
    store.applyRequestHeaders(
      mockReq({
        [LIGHTRAG_SERVER_URL_HEADER]: "http://127.0.0.1:8888",
      }),
      undefined,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
