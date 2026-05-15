# l-pw2c-lightrag-server-mcp

Servidor [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) em **TypeScript** para a API HTTP do [LightRAG](https://github.com/HKUDS/LightRAG). Expõe cerca de **30 ferramentas** para gestão de documentos, consultas RAG, grafo de conhecimento e estado do sistema — no mesmo espírito do projeto de referência [lalitsuryan/lightragmcp](https://github.com/lalitsuryan/lightragmcp), com cliente HTTP alinhado ao contrato real da API (incluindo **upload em `multipart/form-data`** com o campo `file`).

## Funcionalidades

- Cobertura das principais rotas LightRAG usadas em fluxos de RAG e knowledge graph
- Modos de query: `naive`, `local`, `global`, `hybrid`, `mix`
- Inserção de texto, upload de ficheiros (path sob o diretório de trabalho ou base64), scan, listagens, pipeline e cancelamento
- Operações de grafo: labels, entidades, relações, merge
- Autenticação opcional via cabeçalho `X-API-Key`
- Transporte MCP: **stdio** (predefinição) ou **HTTP Streamable** (`--sse`, endpoint `/mcp`) para clientes remotos (ex.: n8n)
- Instalação e execução via `npx` após publicação no npm

## Requisitos

- **Node.js** 20 ou superior
- Uma instância do **servidor LightRAG** acessível por HTTP(S) (por exemplo `lightrag-hku[api]` / `lightrag-server`)

## Instalação (npm)

Quando o pacote estiver publicado:

```bash
npx l-pw2c-lightrag-server-mcp
```

Modo HTTP (Streamable MCP em `/mcp`, útil para n8n e outros clientes na rede):

```bash
npx l-pw2c-lightrag-server-mcp --sse
```

Ou instalação global:

```bash
npm install -g l-pw2c-lightrag-server-mcp
```

## Variáveis de ambiente

| Variável                     | Obrigatória | Descrição                                                                               |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `LIGHTRAG_SERVER_URL`        | Não         | URL base do LightRAG (predefinição: `http://localhost:9621`)                            |
| `LIGHTRAG_API_KEY`           | Não         | Se o servidor exigir, enviada como `X-API-Key`                                          |
| `LIGHTRAG_TIMEOUT_MS`        | Não         | Timeout HTTP em ms (predefinição: `30000`)                                              |
| `LIGHTRAG_WORKSPACE`         | Não         | Workspace LightRAG por defeito (cabeçalho upstream `LIGHTRAG-WORKSPACE`)                |
| `MCP_HTTP_PORT`              | Não         | Porta do servidor MCP em modo `--sse` (predefinição: `8000`)                            |
| `MCP_HTTP_HOST`              | Não         | Host de bind em modo `--sse` (predefinição: `0.0.0.0`)                                  |
| `MCP_HTTP_HEADER_OVERRIDES`  | Não         | Em modo `--sse`: `false` ou `0` desativa overrides por cabeçalho (predefinição: ativo)  |
| `MCP_ALLOWED_LIGHTRAG_HOSTS` | Não         | Hosts permitidos em overrides de URL (vírgulas); vazio = `*` (qualquer host http/https) |

**Precedência do workspace:** o argumento opcional `workspace` em cada tool (se não vazio) tem prioridade sobre `LIGHTRAG_WORKSPACE` e sobre o cabeçalho `LIGHTRAG-WORKSPACE` da sessão HTTP; se nenhum estiver definido, o cabeçalho não é enviado e aplica-se o comportamento por defeito do servidor LightRAG. O suporte a workspaces pode variar entre versões e rotas; ver [discussão no repositório upstream](https://github.com/HKUDS/LightRAG/issues/2904).

**Upload por path:** o ficheiro tem de estar **dentro do diretório de trabalho** do processo do MCP (sem path traversal para fora). Para conteúdo arbitrário, use **base64** no parâmetro `file` da tool `upload_document`.

## Configuração no Cursor (pacote publicado)

No ficheiro de MCP do Cursor (por exemplo `.cursor/mcp.json` na raiz do projeto ou configuração global de MCP), use:

```json
{
  "mcpServers": {
    "l_pw2c_lightrag": {
      "command": "npx",
      "args": ["l-pw2c-lightrag-server-mcp"],
      "env": {
        "LIGHTRAG_SERVER_URL": "https://seu-lightrag.exemplo.com",
        "LIGHTRAG_API_KEY": "sua-chave"
      }
    }
  }
}
```

Reinicie o Cursor ou recarregue os servidores MCP após alterar a configuração.

## n8n (MCP Client Tool)

Com o pacote em modo HTTP (`--sse` num container ou VM):

| Campo             | Valor                                                                             |
| ----------------- | --------------------------------------------------------------------------------- |
| Server Transport  | HTTP Streamable                                                                   |
| Endpoint          | `http://<host>:8000/mcp` (mesma rede Docker: `http://<nome-do-serviço>:8000/mcp`) |
| Options → Timeout | `120000` ou mais (consultas RAG)                                                  |

Exemplos Docker: [docs/docker/](docs/docker/) (`docker-compose` stdio/sse e stack Swarm). Stack Portainer (Compose): [docs/stacks/portainer-compose-stack.yml](docs/stacks/portainer-compose-stack.yml).

### Overrides por cabeçalho HTTP (n8n)

Em modo `--sse`, cada pedido a `/mcp` pode enviar credenciais e destino LightRAG nos **cabeçalhos HTTP** (por sessão MCP). Valores em env no container servem de **fallback** quando o header não é enviado. O modo **stdio** (Cursor local) **não** suporta estes headers — use `env` no `mcp.json`.

| Campo     | Variável de ambiente (default) | Cabeçalho HTTP (override por sessão) | Tool MCP                            |
| --------- | ------------------------------ | ------------------------------------ | ----------------------------------- |
| Base URL  | `LIGHTRAG_SERVER_URL`          | `LIGHTRAG-Server-Url`                | —                                   |
| API key   | `LIGHTRAG_API_KEY`             | `LIGHTRAG-API-Key`                   | —                                   |
| Workspace | `LIGHTRAG_WORKSPACE`           | `LIGHTRAG-WORKSPACE`                 | arg `workspace` (prioridade máxima) |

Não use `X-API-Key` no pedido ao MCP para apontar ao LightRAG — esse nome reserva-se para auth futura do endpoint `/mcp`. Use `LIGHTRAG-API-Key`.

**n8n MCP Client Tool (v1.2+):** em _Authentication_, escolha **Multiple Headers Auth** (ou vários _Header Auth_) com, por exemplo:

| Header                | Valor (exemplo)                |
| --------------------- | ------------------------------ |
| `LIGHTRAG-Server-Url` | `https://lightrag.example.com` |
| `LIGHTRAG-API-Key`    | `{{ $credentials.apiKey }}`    |
| `LIGHTRAG-WORKSPACE`  | `meu-workspace` (opcional)     |

Endpoint: `http://<host>:8000/mcp`. A stack pode expor defaults em env e deixar o workflow sobrescrever via headers.

**Allowlist (`MCP_ALLOWED_LIGHTRAG_HOSTS`):** lista separada por vírgulas de hostnames permitidos quando o cliente envia `LIGHTRAG-Server-Url`. O valor `*` permite qualquer host http(s). Se a variável estiver **vazia ou omitida**, trata-se como `*`.

| Exemplo de valor                       | Uso                                              |
| -------------------------------------- | ------------------------------------------------ |
| `lightrag.example.com,api.example.com` | Produção: só hosts explícitos na allowlist       |
| `127.0.0.1,localhost`                  | Desenvolvimento local                            |
| `*`                                    | Qualquer destino (menos restritivo; útil em dev) |

**Troubleshooting:** rejeições de override aparecem nos logs do container com prefixo `[LIGHTRAG]`, por exemplo:

```text
[LIGHTRAG] header override rejected: host "evil.com" not in MCP_ALLOWED_LIGHTRAG_HOSTS (allowed: lightrag.example.com)
```

Outras mensagens típicas: overrides desativados (`MCP_HTTP_HEADER_OVERRIDES=false`), URL inválida, host não http(s). O pedido HTTP falha com **400** antes de processar o JSON-RPC MCP.

## Modo HTTP remoto no Cursor

Se o MCP estiver exposto em HTTP (sem stdio local):

```json
{
  "mcpServers": {
    "l_pw2c_lightrag_remote": {
      "url": "http://seu-host:8000/mcp"
    }
  }
}
```

---

## Desenvolvimento e teste local (sem publicar no npm)

Pode ligar **outro projeto** no Cursor ao MCP **deste repositório clonado**, sem `npm publish`.

### 1. Preparar o build neste repositório

```bash
cd /caminho/para/l-pw2c-lightrag-server-mcp
npm install
npm run build
```

Confirme que existe `dist/cli.js` (ponto de entrada do binário).

### 2. Opção A — `node` com caminho absoluto (recomendado)

No projeto **onde quer usar o MCP** (ou na configuração global do Cursor), aponte diretamente para o ficheiro compilado:

**Windows (exemplo):**

```json
{
  "mcpServers": {
    "l_pw2c_lightrag_local": {
      "command": "node",
      "args": [
        "C:\\repositories\\healthdev\\l-pw2c-lightrag-server-mcp\\dist\\cli.js"
      ],
      "env": {
        "LIGHTRAG_SERVER_URL": "http://localhost:9621",
        "LIGHTRAG_API_KEY": "opcional"
      }
    }
  }
}
```

**macOS / Linux (exemplo):**

```json
{
  "mcpServers": {
    "l_pw2c_lightrag_local": {
      "command": "node",
      "args": ["/home/voce/projetos/l-pw2c-lightrag-server-mcp/dist/cli.js"],
      "env": {
        "LIGHTRAG_SERVER_URL": "http://localhost:9621",
        "LIGHTRAG_API_KEY": "opcional"
      }
    }
  }
}
```

Substitua o caminho pelo caminho real do clone no seu disco. Em JSON use `\\` em caminhos Windows ou `/` (o Node aceita em muitos casos).

### 3. Opção B — `npx` a partir da pasta do clone

Se estiver na pasta deste repositório, pode testar no terminal:

```bash
npx .
```

Para o Cursor, pode usar `npx` com o **caminho do pacote** (pasta que contém `package.json`):

```json
{
  "mcpServers": {
    "l_pw2c_lightrag_local": {
      "command": "npx",
      "args": [
        "--prefix",
        "C:\\repositories\\healthdev\\l-pw2c-lightrag-server-mcp",
        "l-pw2c-lightrag-server-mcp"
      ],
      "env": {
        "LIGHTRAG_SERVER_URL": "http://localhost:9621"
      }
    }
  }
}
```

Ajuste `--prefix` ao caminho absoluto do clone. Isto usa o `node_modules` e o `bin` definidos nesse pacote.

### 4. Opção C — desenvolvimento com `tsx` (sem build)

Para iterar só em TypeScript (mais lento a arrancar que `dist/cli.js`):

```json
{
  "mcpServers": {
    "l_pw2c_lightrag_dev": {
      "command": "npx",
      "args": [
        "tsx",
        "C:\\repositories\\healthdev\\l-pw2c-lightrag-server-mcp\\src\\cli.ts"
      ],
      "cwd": "C:\\repositories\\healthdev\\l-pw2c-lightrag-server-mcp",
      "env": {
        "LIGHTRAG_SERVER_URL": "http://localhost:9621"
      }
    }
  }
}
```

Confirme na documentação do Cursor se a chave `cwd` é suportada na sua versão; se não for, remova `cwd` e use caminhos absolutos em `args`.

### 5. Verificar

1. Arranque o LightRAG na URL configurada.
2. No Cursor, confirme que o servidor MCP aparece como ligado.
3. Use **Listar ferramentas** / pedidos ao agente que invoquem tools como `get_health` ou `query_text`.

Sempre que alterar código TypeScript, volte a correr `npm run build` se usar a **Opção A** ou **B**.

## Ferramentas expostas (resumo)

Alinhadas ao conjunto típico do [lightragmcp](https://github.com/lalitsuryan/lightragmcp) / `index.js`:

**Documentos:** `insert_text`, `insert_texts`, `upload_document`, `scan_documents`, `get_documents`, `get_documents_paginated`, `delete_document`, `clear_documents`, `reprocess_failed_documents`, `cancel_pipeline`

**Consultas:** `query_text`, `query_text_stream`, `query_data`

**Grafo:** `get_knowledge_graph`, `get_graph_labels`, `get_popular_labels`, `search_labels`, `check_entity_exists`, `create_entity`, `update_entity`, `delete_entity`, `create_relation`, `update_relation`, `delete_relation`, `merge_entities`

**Sistema:** `get_pipeline_status`, `get_track_status`, `get_document_status_counts`, `clear_cache`, `get_health`

Para detalhes do contrato HTTP e armadilhas (upload, NDJSON, etc.), veja [docs/specs/lightrag-mcp-servidor.spec.md](docs/specs/lightrag-mcp-servidor.spec.md).

## Scripts do repositório

| Comando                    | Descrição                                                                       |
| -------------------------- | ------------------------------------------------------------------------------- |
| `npm run build`            | Gera `dist/cli.js` (tsup)                                                       |
| `npm run dev`              | Executa `src/cli.ts` com tsx (stdio)                                            |
| `npm run dev:http`         | Executa `src/cli.ts --sse` (HTTP Streamable em `/mcp`)                          |
| `npm test`                 | Testes Vitest                                                                   |
| `npm run test:coverage`    | Testes com cobertura                                                            |
| `npm run lint`             | ESLint + Prettier check                                                         |
| `npm run typecheck`        | `tsc --noEmit`                                                                  |
| `npm run package:check`    | `npm pack --dry-run` (ficheiros do pacote)                                      |
| `npm run changeset`        | [Changesets](https://github.com/changesets/changesets): criar nota de alteração |
| `npm run version-packages` | Aplicar versões e atualizar `CHANGELOG.md`                                      |
| `npm run release`          | Publicar no npm (`changeset publish`)                                           |

## Versões e release (Changesets)

Este projeto usa [Changesets](https://github.com/changesets/changesets) para versionar e publicar no npm.

### Contribuir com alterações

1. **`npm run changeset`** — descreve a alteração (major / minor / patch) e gera um ficheiro em `.changeset/`.
2. Abra um PR para `main` com o código e o changeset (o `package.json` na PR mantém a versão atual até ao release).

### Publicação automática (CI)

Após **merge na `main`**, o GitHub Actions (`.github/workflows/release.yml`):

1. Executa **`npm run version-packages`** — incrementa `version` no `package.json`, consome os changesets e atualiza o `CHANGELOG.md`.
2. Faz commit `chore: version packages` na `main`.
3. Executa **`npm run release`** — publica no [npm](https://www.npmjs.com/package/l-pw2c-lightrag-server-mcp).

É necessário o secret **`NPM_TOKEN`** nas Actions do repositório (token com permissão de publish no pacote).

### Release manual (maintainers)

Se precisar de publicar localmente:

```bash
npm run version-packages
npm run release   # requer npm login e permissão no pacote
```

A versão exposta no protocolo MCP (`McpServer`) é lida em tempo de execução a partir do `package.json` ([`src/version.ts`](src/version.ts)).

## Documentação adicional

- Docker Compose e Swarm: [docs/docker/](docs/docker/) — `docker-compose.stdio.yml`, `docker-compose.sse.yml`, `portainer-swarm-stack.yml`, `.env.example`
- Resumo das ferramentas MCP: [TOOLS_SUMMARY.md](TOOLS_SUMMARY.md)
- Especificação interna e paridade com a API: [docs/specs/lightrag-mcp-servidor.spec.md](docs/specs/lightrag-mcp-servidor.spec.md)
- OpenAPI de referência (cópia local): [docs/openapi.json](docs/openapi.json)

## Licença

[MIT](LICENSE)

## Créditos

- Inspirado no servidor MCP [lalitsuryan/lightragmcp](https://github.com/lalitsuryan/lightragmcp) e no ecossistema [LightRAG](https://github.com/HKUDS/LightRAG).
