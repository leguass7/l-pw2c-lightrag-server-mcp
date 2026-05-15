# l-pw2c-lightrag-server-mcp

## 1.2.1

### Patch Changes

- Corrigir Streamable HTTP: criar um par transporte + servidor MCP por sessão (`Mcp-Session-Id`), alinhado ao SDK, evitando `Server already initialized` com vários clientes (Cursor, n8n, retries). Melhorar logs de bind para operadores Docker.

## 1.2.0

### Minor Changes

- 969eeb7: Adiciona transporte **HTTP Streamable** nativo (`--sse`, endpoint `/mcp` e `GET /health`) para clientes remotos como n8n, mantendo **stdio** como modo predefinido. Variáveis `MCP_HTTP_PORT` e `MCP_HTTP_HOST`.

  Overrides por cabeçalho HTTP por sessão MCP (`LIGHTRAG-Server-Url`, `LIGHTRAG-API-Key`, `LIGHTRAG-WORKSPACE`) com fallback a env, allowlist `MCP_ALLOWED_LIGHTRAG_HOSTS` (incluindo `*`), flag `MCP_HTTP_HEADER_OVERRIDES` e logs `[LIGHTRAG]` em rejeições.

## 1.1.0

### Minor Changes

- Suporte opcional a **workspace** LightRAG: variável de ambiente `LIGHTRAG_WORKSPACE` e parâmetro `workspace` em todas as tools, enviando o cabeçalho HTTP `LIGHTRAG-WORKSPACE` com precedência tool > env > omissão. Documentação e testes e2e atualizados.

## 1.0.0

### Major Changes

- Primeira release estável **1.0.0** para publicação no npm.

## 0.1.0

### Minor Changes

- Lançamento inicial: servidor MCP (stdio) em TypeScript para a API HTTP LightRAG, ~30 ferramentas, upload multipart, testes e2e com cobertura.
