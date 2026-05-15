# Resumo das ferramentas (Tools Summary)

Referência rápida das ferramentas expostas pelo **l-pw2c-lightrag-server-mcp**, alinhadas à API HTTP LightRAG (HKUDS) e ao fluxo do [lightragmcp](https://github.com/lalitsuryan/lightragmcp) (`index.js`).  
O ficheiro homónimo a montante ([TOOLS_SUMMARY.md no lightragmcp](https://github.com/lalitsuryan/lightragmcp/blob/main/TOOLS_SUMMARY.md)) pode descrever nomes ou parâmetros diferentes dos do código npm desse repo; **aqui vale o que está implementado neste pacote** (ver [`src/server.ts`](src/server.ts)).

**Parâmetro comum (opcional):** todas as tools aceitam `workspace` (string). Quando preenchido, envia o cabeçalho `LIGHTRAG-WORKSPACE` nesse pedido e **sobrescreve** o valor por defeito definido pela variável de ambiente `LIGHTRAG_WORKSPACE` do processo MCP.

---

## Gestão de documentos (10 tools)

| Tool                         | Descrição                                       | Parâmetros principais                                                              |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `insert_text`                | Inserir um documento de texto                   | `text` (obr.), `file_source` (opc., predef.: `text_input.txt`)                     |
| `insert_texts`               | Inserir vários textos em lote                   | `texts` (obr.), `file_sources` (opc.; se omitido, gera `text_input_N.txt`)         |
| `upload_document`            | Enviar ficheiro (multipart)                     | `file`: path relativo/absoluto **dentro do cwd** do processo, ou string **base64** |
| `scan_documents`             | Disparar scan do diretório de input do servidor | —                                                                                  |
| `get_documents`              | Listar documentos                               | —                                                                                  |
| `get_documents_paginated`    | Listagem paginada                               | `page` (predef.: 1), `page_size` (predef.: 50)                                     |
| `delete_document`            | Apagar por IDs                                  | `doc_ids` (array de strings)                                                       |
| `clear_documents`            | Limpar todos os documentos                      | —                                                                                  |
| `reprocess_failed_documents` | Reprocessar falhados / pendentes                | —                                                                                  |
| `cancel_pipeline`            | Pedir cancelamento do pipeline                  | —                                                                                  |

---

## Consultas (3 tools)

| Tool                | Descrição                                                    | Parâmetros principais                                                                                       |
| ------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `query_text`        | Query com resposta JSON                                      | `query` (obr.), `mode` (predef.: `hybrid`), `only_need_context` (predef.: `false`), `top_k` (predef.: `60`) |
| `query_text_stream` | Query em stream (`/query/stream`, NDJSON agregado num texto) | `query`, `mode` (predef.: `hybrid`)                                                                         |
| `query_data`        | Dados de retrieval sem resposta LLM completa                 | `query`, `mode` (predef.: `hybrid`)                                                                         |

**Modos de query:** `naive`, `local`, `global`, `hybrid`, `mix`

---

## Grafo de conhecimento (12 tools)

| Tool                  | Descrição                    | Parâmetros principais                                                            |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `get_knowledge_graph` | Subgrafo / visualização      | `label` (predef.: `*`), `max_depth` (predef.: 3), `max_nodes` (predef.: 1000)    |
| `get_graph_labels`    | Listar labels                | —                                                                                |
| `get_popular_labels`  | Labels populares (grau)      | `limit` (predef.: 300)                                                           |
| `search_labels`       | Pesquisa de labels           | `q` (obr.), `limit` (predef.: 50)                                                |
| `check_entity_exists` | Verificar se entidade existe | `name`                                                                           |
| `create_entity`       | Criar entidade               | `entity_name`, `entity_data` (objeto)                                            |
| `update_entity`       | Atualizar entidade           | `entity_name`, `updated_data`, `allow_rename` / `allow_merge` (predef.: `false`) |
| `delete_entity`       | Apagar entidade              | `entity_name`                                                                    |
| `create_relation`     | Criar relação                | `source_entity`, `target_entity`, `relation_data`                                |
| `update_relation`     | Atualizar relação            | `source_id`, `target_id`, `updated_data`                                         |
| `delete_relation`     | Apagar relação               | `source_entity`, `target_entity`                                                 |
| `merge_entities`      | Fundir entidades             | `entities_to_change` (array), `entity_to_change_into`                            |

---

## Sistema e pipeline (5 tools)

| Tool                         | Descrição             | Parâmetros principais |
| ---------------------------- | --------------------- | --------------------- |
| `get_pipeline_status`        | Estado do pipeline    | —                     |
| `get_track_status`           | Estado por `track_id` | `track_id`            |
| `get_document_status_counts` | Contagens por estado  | —                     |
| `clear_cache`                | Limpar cache interno  | —                     |
| `get_health`                 | Health check HTTP     | —                     |

**Total: 30 tools.**

---

## Comandos rápidos (exemplos de argumentos)

### Uso básico

```json
{}
```

`get_health` — sem argumentos.

```json
{ "text": "Conteúdo a indexar" }
```

`insert_text` — `file_source` opcional.

```json
{ "query": "A sua pergunta", "mode": "hybrid" }
```

`query_text` — `top_k` e `only_need_context` opcionais.

### Fluxos comuns

**Indexar e consultar:**

1. `insert_text` ou `insert_texts` ou `upload_document`
2. `get_pipeline_status` ou `get_track_status` (se tiver `track_id` de upload)
3. `query_text`

**Grafo:**

1. `get_graph_labels` ou `search_labels`
2. `get_knowledge_graph`
3. `check_entity_exists` antes de `update_entity` / `create_relation`

**Operações de manutenção:**

1. `get_health`
2. `get_document_status_counts`
3. `clear_cache` (quando fizer sentido no ambiente)

---

## Categorias por caso de uso

### Ingestão

- `insert_text`, `insert_texts`, `upload_document`, `scan_documents`

### Recuperação de informação

- `query_text`, `query_text_stream`, `query_data`

### Gestão de conhecimento (grafo)

- `get_knowledge_graph`, `get_graph_labels`, `get_popular_labels`, `search_labels`
- `check_entity_exists`, `create_entity`, `update_entity`, `merge_entities`
- `create_relation`, `update_relation`, `delete_relation`, `delete_entity`

### Gestão de conteúdo (documentos)

- `get_documents`, `get_documents_paginated`
- `delete_document`, `clear_documents`
- `reprocess_failed_documents`, `cancel_pipeline`

### Administração / observabilidade

- `get_health`, `get_pipeline_status`, `get_track_status`, `get_document_status_counts`, `clear_cache`

---

## Referência rápida de parâmetros

| Parâmetro                                        | Tipo          | Notas                                               |
| ------------------------------------------------ | ------------- | --------------------------------------------------- |
| `query`                                          | string        | Texto da pergunta                                   |
| `mode`                                           | string        | `naive` \| `local` \| `global` \| `hybrid` \| `mix` |
| `text`                                           | string        | Corpo para `insert_text`                            |
| `texts`                                          | string[]      | Lote para `insert_texts`                            |
| `file`                                           | string        | Path (dentro do **cwd** do MCP) ou base64           |
| `doc_ids`                                        | string[]      | IDs a apagar em `delete_document`                   |
| `entity_name`                                    | string        | Nome da entidade                                    |
| `entity_data` / `updated_data` / `relation_data` | object        | Payload JSON livre (chaves string)                  |
| `source_entity` / `target_entity`                | string        | Extremos da relação                                 |
| `source_id` / `target_id`                        | string        | IDs em `update_relation`                            |
| `track_id`                                       | string        | Rastreio de jobs assíncronos                        |
| `page` / `page_size`                             | number        | Paginação                                           |
| `top_k`                                          | number        | Predef.: 60 em `query_text`                         |
| `label` / `max_depth` / `max_nodes`              | string/number | Grafo                                               |
| `q` / `limit`                                    | string/number | Pesquisa de labels                                  |

---

## Formato das respostas (MCP)

Cada tool devolve conteúdo MCP do tipo **texto**: em geral JSON pretty-print da resposta do LightRAG, ou texto agregado (ex.: `query_text_stream`).  
Em erro: bloco de texto com prefixo `Error:` ou `Validation:` e, quando aplicável, corpo devolvido pelo servidor HTTP.

---

## Dicas de desempenho

1. **Lotes:** preferir `insert_texts` a muitas chamadas a `insert_text`.
2. **Grandes listas:** usar `get_documents_paginated`.
3. **`top_k`:** ajustar em `query_text` ao tamanho do contexto desejado.
4. **Upload:** ficheiros grandes — respeitar limites do servidor LightRAG; o MCP apenas reencaminha bytes em multipart.
5. **Cache:** `clear_cache` após mudanças massivas, se a instância LightRAG o recomendar.

---

## Boas práticas

- **Upload por path:** o processo do MCP tem de conseguir ler o ficheiro no host onde corre; paths fora do `cwd` são rejeitados.
- **LightRAG remoto:** usar `insert_text` / base64 em `upload_document` se não houver ficheiro local partilhado.
- **Grafo:** confirmar entidades com `check_entity_exists` antes de alterações destrutivas.
- **Segurança:** não expor `LIGHTRAG_API_KEY` em repositórios ou capturas de ecrã.

Para mais detalhes de protocolo HTTP e limitações, veja [docs/specs/lightrag-mcp-servidor.spec.md](docs/specs/lightrag-mcp-servidor.spec.md).
