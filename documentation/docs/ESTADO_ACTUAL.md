# Estado Actual del Proyecto — BioAgents / CoralGPT

> **Fecha:** 2026-07-10
> **Rama:** `dev2` (663 commits por delante de `origin/dev`)
> **Método:** este documento se construyó verificando el CÓDIGO fuente, no
> los documentos previos. Cuando el código contradice a un doc viejo, gana
> el código. Al final se listan los docs que quedaron obsoletos.

---

## 1. Resumen ejecutivo

El proyecto tiene DOS capas conviviendo sobre la misma infraestructura
(auth, DB, cola, LLM):

1. **BioAgents Deep Research** — el motor científico original: pipeline
   fijo de mini-agentes (planning → literatura/análisis → hipótesis →
   reflexión → discovery).
2. **CoralGPT** — la piel de producto: login con Privy + whitelist,
   waitlist pública, Library con RAG por paper, y el loop de chat-agent
   con tool-calling.

Ambas están **implementadas y montadas**. La mayor parte de lo que los
docs de junio marcaban como "por hacer" **ya se hizo**. Lo que queda
pendiente es sobre todo operativo (claves de API, testing E2E de pagos) y
features de segunda vuelta del subsistema de bioprospección.

El riesgo real hoy **no es de features faltantes sino de higiene**: 663
commits sin pushear, docs de estado con 3 semanas de desfasaje y varias
contradicciones internas entre ellos.

---

## 2. Qué está HECHO (verificado en código)

### Motor Deep Research (`src/agents/*`)
- Mini-agentes presentes y ejecutados: `planning`, `hypothesis`,
  `reflection`, `discovery`, `reply`, `literature`, `analysis`.
- Extras **no documentados en CLAUDE.md** pero reales: `clarification/`
  (Q&A previo a la investigación), `continueResearch/`, `fileUpload/`.
- Proveedores de literatura: `openscholar.ts`, `bio.ts`, `edison.ts`,
  `knowledge.ts`. Análisis: `bio.ts`, `edison.ts`.
- **No hay un archivo orquestador único.** El ciclo está inline y
  DUPLICADO en dos drivers que hay que mantener en sync:
  - In-process: `src/routes/deep-research/start.ts` (`runDeepResearch`)
  - Cola: `src/services/queue/workers/deep-research.worker.ts`

### Chat-agent (`src/chat-agent/*`)
- `runner.ts`, `loop.ts` (Anthropic), `loop-openrouter.ts`, `registry.ts`.
- **Dos** tools registradas, no una: `literature-search` (envuelve
  `literatureAgent`) **y `research-brain-search`**. CLAUDE.md dice que
  literature_search es el único seam — eso es incorrecto hoy.
- Tiene tests (`agent-loop.test.ts`, `llm-config.test.ts`).

### CoralGPT
- **Privy**: `src/services/privy-auth.ts`, montado en `POST /api/auth/privy`.
  Privy NO es un método dentro de `authResolver`; es una ruta de login que
  emite un JWT que luego `authResolver` consume.
- **Whitelist gate**: `routes/auth.ts` valida `access_type === "whitelisted"`.
  CLI en `scripts/whitelist.ts`.
- **Waitlist**: `src/routes/waitlist.ts` (con test).
- **Library RAG**: `src/routes/library.ts` (con test). Páginas cliente
  `LibraryPage`, `PaperPage`, `LibraryViewerPage`.
- **Embeddings**: soporte multi-provider (`EMBEDDING_PROVIDER`: openai por
  defecto, openrouter/Qwen). Ver §8 para el detalle completo.

### Auth y pagos — todo montado
- `authResolver` multi-método: x402 → jwt → api_key → anonymous.
- **x402 (Base/USDC)**: `middleware/x402/*`. **Confirmado en v2** —
  `package.json` tiene `@x402/core`, `@x402/evm`, `@x402/fetch` en `^2.2.0`.
  4 rutas montadas (route, chat, deep-research, individual-agents).
- **b402 (BNB/USDT)**: `middleware/b402/*`, 3 rutas montadas (sin
  individual-agents, a diferencia de x402).

### Cola de jobs (`src/services/queue/*`)
- Workers: `chat`, `deep-research`, `paper-generation`, `file-process`,
  `document-ingestion`, y **no documentados**: `bioprospecting`,
  `compoundAuthority`, `discoveryReeval`.
- **Matriz dual-engine confirmada** tal cual CLAUDE.md: in-process siempre
  usa `runChatAgent`; en cola, `CHAT_AGENT_QUEUE_ENABLED=true` usa el
  chat-agent, si no cae al pipeline legacy.

### Research Brain / Provenance / Figuras
- Endpoint de imagen de figura real: `GET /api/research-brain/figures/:figureId/image`
  (`research-brain.ts:1309`, auth requerida, manejo 401/404/413).
- Rutas extra montadas: `research-brain-graph.ts` (búsqueda de compuestos),
  `research-brain-citations.ts` (grafo paper→paper), `admin/table-merges.ts`.
- Cliente: `ViewerPage` en `/viewer/:sourceId` (montado en ambos shells,
  Legacy y Coral), `EvidenceLightbox`, `ProvenanceBadge`, `ProvenanceContext`,
  hooks `useProvenance`/`useTableChain`.

### Generación de papers
- `routes/deep-research/paper.ts` → `services/paper/generatePaper.ts`.
  Endpoints de creación, fetch y status. Worker async `paper-generation.worker.ts`.

### Subsistema de bioprospección (existe, poco documentado en CLAUDE.md)
- Workers `bioprospecting`, `compoundAuthority` (tick 6h PubChem),
  `discoveryReeval`.
- Admin UI: `AdminPage`, `CorpusDashboardPage`, `ResearchBrainPage`.
- Cost guard rails: `adminJobsRoute`, `costTotalsRoute`, `dailyApiUsageGc.ts`.

---

## 3. Qué está PENDIENTE (genuinamente abierto)

### Operativo / configuración
- **Testing E2E de x402 v2 (Phase 5)** nunca se cerró: falta el pago real
  de $0.01 y el test de integración con el facilitator. El código v2 está,
  la validación end-to-end no.
- **Fallback de proveedor LLM**: existe la maquinaria en `src/llm/provider.ts`
  (`fallbackProvider`/`fallbackModel`), pero depende de que haya claves
  configuradas. Los docs de junio reportaban dependencia 100% de OpenRouter
  sin fallback activo — verificar el `.env` de producción actual.
- ~~Default del chat-agent en `qwen/qwen3.6-plus`~~ ✅ **CORREGIDO
  (2026-07-10)**: `src/chat-agent/llm-config.ts:68` ahora defaultea a
  `minimax/minimax-m3` (el modelo validado en CHANGELOG 0.2.0). Antes, cualquier
  entorno sin `DEFAULT_OPENROUTER_MODEL` seteado caía en el modelo inexistente
  que quemó $8. El override por env sigue teniendo prioridad. Tests 8/8 OK.

### Features de segunda vuelta (roadmap STATUS.es.md, aún abiertos)
- Recuperación fuzzy de compuestos vía PubChem (200 fallidos / 235 pendientes
  de 22 canónicos).
- Migración de lado de lectura para `research_discoveries` (tabla se llena
  pero ningún consumidor la lee).
- Worker de re-evaluación automática (cron) + alertas.
- Grafo de menciones de entidades (KG PR #2) y linker semántico LLM (KG PR #3).
- Papers multi-idioma.
- Anotación/edición de provenance.
- Re-spike de extracción XObject con `pdfjs@6` (v1 quedó como
  `wontfix: documented-v1-limitation`).

### Higiene (lo más urgente y barato)
- **663 commits sin pushear** en `dev2`. Definir la estrategia de merge/PR.
- El caché de SDD (`openspec/`) dice "no existen tests" (detectado 2026-06-08),
  pero hay ~600 tests corriendo. El caché está stale.

---

## 4. Documentos OBSOLETOS en la raíz (candidatos a archivar/borrar)

Estos vivían en la raíz, son snapshots viejos (últ. toque 2026-06-20) y
generan ruido. Recomendación por cada uno:

| Documento | Naturaleza | Recomendación |
|---|---|---|
| `ANALISIS_DEEP_RESEARCH.md` | Análisis de UN job del 18-jun + propuesta de telemetría | **Archivar** en `documentation/archive/`. La propuesta de telemetría no está implementada; si interesa, convertir en issue. |
| `AUDIT_DEEP_RESEARCH.md` | Auditoría operativa 18-jun (métricas en vivo, ya obsoletas) | **Archivar**. Los fixes que reportaba ya están en CHANGELOG. |
| `FLOW_COMPARISON.md` | Recap de sesión 17-jun (fixes + diagrama) | **Archivar**. Varios "lo que falta" ya se hicieron. |
| `STATUS.es.md` | Status más completo pero del 19-jun, con contradicciones internas | **Reemplazar por este doc** y archivar. |
| `research-brain.md` | Doc de arquitectura (atemporal, sin fecha) | **Mover a `documentation/docs/`** como referencia mantenida (no es basura, está mal ubicado). |
| `X402_V2_MIGRATION.md` | Notas de migración feb-2026, fases 1-4 hechas | **Archivar**. ⚠️ Contiene una address de wallet de test y una ruta a private key — revisar antes de commitear/compartir. |
| `CHANGELOG.md` | Historial de releases (SemVer) | **Mantener en raíz**. Es la fuente autoritativa de historia. |
| `README.md` | Onboarding público | **Mantener y actualizar**: lista 7 agentes y `provider.ts` mono-motor; no menciona la realidad dual-engine/chat-agent. |

---

## 5. Contradicciones que estos docs arrastran (a no repetir)

1. **Estado de OpenRouter**: en 2 días los docs dicen 3 cosas distintas
   (caído por límite de key / arreglado a 100% / "sin saldo"). El CHANGELOG
   0.2.0 es el más nuevo y dice arreglado.
2. **Modelo LLM**: docs viejos citan `qwen/qwen3.6-plus`; los nuevos
   `minimax/minimax-m3`. El swap fue real, pero **solo en un path** (ver §3).
3. **Grafo de citas**: `STATUS.es.md` lo lista como ❌ no-en-prod Y ✅ shipped
   en el mismo archivo. En código: `research-brain-citations.ts` existe y
   está montado → **está shipped**.
4. **Existencia de tests**: el caché de SDD dice que no hay tests; hay ~600.

---

## 6. CLAUDE.md — desajustes menores a corregir

- Dice que `literature_search` es el único seam del chat-agent → hay una
  segunda tool, `research-brain-search`.
- No menciona los agentes `clarification/`, `continueResearch/`, `fileUpload/`.
- No menciona el subsistema de bioprospección (workers + rutas + UI admin).

---

## 7. Próximos pasos sugeridos (por prioridad)

1. **Higiene git**: decidir qué hacer con los 663 commits de `dev2`.
2. **Archivar los 5 docs obsoletos** de la raíz + mover `research-brain.md`.
   ⚠️ Sanear `X402_V2_MIGRATION.md` (wallet/key) antes de cualquier push.
3. **Verificar el `.env` de producción** (claves + fallback). El default del
   chat-agent ya quedó en `minimax/minimax-m3` (ver §3).
4. Actualizar `README.md` y los desajustes de `CLAUDE.md`.
5. Cerrar Phase 5 de x402 (test E2E de pago real) si los pagos importan hoy.

---

## 8. Embeddings — estado y riesgo (verificado en código)

**Config por defecto** (`src/embeddings/config.ts`):
- Provider: OpenAI, modelo `text-embedding-3-small`, **1536 dims**.
- Alternativa soportada: OpenRouter/Qwen a **2560 dims** (`setup-qwen-2560.sql`).
- Env vars: `EMBEDDING_PROVIDER`, `TEXT_EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`,
  `EMBEDDING_SEND_DIMENSIONS` (auto-off para openrouter).

**Un solo almacén de vectores — sin split-brain de dimensiones:**
- La tabla `documents` es la ÚNICA que guarda embeddings vectoriales
  (`setup.sql`, `vector(1536)`).
- `research_evidence_chunks` NO guarda vectores propios: tiene FK
  `document_id → documents(id)` (`20260601090000_create_research_brain.sql:68`).
- La búsqueda de *claims* del Research Brain es full-text (GIN `to_tsvector`),
  no vectorial.
- Library RAG (`vectorSearchWithDocs`) y Research Brain funnelean al mismo
  `documents`. → una sola dimensión gobierna todo el sistema.

**Guard de seguridad**: `provider.ts:44` tira error si el modelo devuelve un
vector de largo distinto a `EMBEDDING_DIMENSIONS`. Cubre *modelo vs config*.

**⚠️ Riesgo que el guard NO cubre — *config vs datos ya guardados*:**
Si se cambia `EMBEDDING_PROVIDER`/`EMBEDDING_DIMENSIONS` DESPUÉS de haber
ingestado, los vectores viejos quedan incompatibles. Cambiar de provider =
re-embeber TODO el corpus + correr `setup-qwen-2560.sql` para alterar la
columna. No hay migración que lo automatice: es reindexación manual y
destructiva.

**Accionable**: verificar que el `.env` de producción coincida con la
dimensión de la columna `documents.embedding` en la DB en vivo. Con el default
(openai/1536) es coherente; si alguien puso Qwen en `.env` con la columna aún
en 1536, las inserciones fallan (el guard avisa recién en runtime).

**Nota**: a diferencia del default del LLM (§3), el default del embedding NO
estaba roto — `text-embedding-3-small`/1536 es válido y consistente. No hay
nada que arreglar acá, solo verificar.
