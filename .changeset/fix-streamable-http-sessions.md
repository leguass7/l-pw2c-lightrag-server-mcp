---
"l-pw2c-lightrag-server-mcp": patch
---

Corrigir Streamable HTTP: criar um par transporte + servidor MCP por sessão (`Mcp-Session-Id`), alinhado ao SDK, evitando `Server already initialized` com vários clientes (Cursor, n8n, retries). Melhorar logs de bind para operadores Docker.
