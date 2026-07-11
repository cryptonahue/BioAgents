# BioAgents — Estado Actual de la Plataforma

> **Documento de estado interno** (19 junio 2026) — qué pueden hacer los usuarios hoy, qué no, y qué viene.

## TL;DR

BioAgents es un **AI Scientist Framework** para bioprospecting. Los usuarios suben papers científicos, el sistema extrae datos estructurados (compuestos, actividades biológicas, claims), detecta contradicciones entre papers, deduplica findings repetidos, y deja al investigador navegar **hasta el párrafo, tabla o figura exactos** de donde viene cada claim. La plataforma **acumula conocimiento verificable** a lo largo de miles de papers, con cada claim linkeado a su evidencia concreta.

> ⚠️ **Constraint de capacidad (jun 2026)**: la cuenta de OpenRouter está sin saldo. El roadmap abajo está filtrado por dependencia de LLM: tareas 🟢 LLM-free y 🟡 v1-sin-LLM son **accionables hoy**; las 🔴 LLM-required quedan en backlog hasta que vuelva el crédito.

---

## Estado Actual — Qué Pueden Hacer los Usuarios HOY

### ✅ Funcional (en producción)

| Feature | Qué hace | Cómo se usa |
|---|---|---|
| **Ingesta de papers** | Subís un PDF o un paper de PubMed, el sistema lo procesa async con BullMQ | Drop zone en `/library`, o ingest URL |
| **Extracción bioprospecting** | LLM extrae: compuesto, especie, bioactividad, mecanismo, contexto geográfico | Auto en la ingesta, editables después |
| **Tablas estructuradas de PDFs** | Extrae tablas como markdown con headers jerárquicos preservados (multi-página) | Auto en la ingesta, navegables en provenance viewer |
| **Imagen/figura extraction** | Extrae imágenes de papers (Mistral raster + render-crop vector) | Click en un fact → lightbox con la imagen |
| **Detección de contradicciones** | Detecta cuando dos papers dicen cosas opuestas sobre el mismo compuesto/actividad | `/admin/contradictions` con filtro y bulk resolve |
| **Deduplicación semántica** | Detecta facts duplicados entre papers (mismo species\|compound\|bioactivity) | Auto-merge, pero reversible vía unmerge |
| **Provenance viewer** | Click en un fact → abre la página exacta del PDF con bbox highlight | Ctrl+click abre en tab |
| **Re-evaluation button** | Botón "check for updates" en un discovery para detectar papers nuevos relevantes | `/discoveries/:id/reevaluate` |
| **Cost guard rails** | Hard/soft caps diarios/mensuales para Mistral OCR y PubChem | Env vars + admin drill-down `/admin/cost-totals` |
| **Admin review UI** | Panel `/admin` con 3 tabs: Contradictions, Dedup, Stats | Auth-gated, role: admin |
| **Knowledge graph search** | "Mostrame todo lo que sabemos del compound X" — search endpoint con stats | `/api/research-brain/graph/compounds/search` |
| **Co-occurrence RPC** | "Qué otros compounds co-aparecen con X en papers" | `graph_top_co_occurring` SQL RPC |
| **String-bucket RPC** | "Top geographies / bioactivities de un compound" | `graph_top_string_field` SQL RPC |
| **Status endpoint** | Health del servicio + estado del job queue | `GET /api/health` |
| **Version endpoint** | Versión + SHA + build date del container | `GET /api/version` (en Footer del cliente) |
| **Activity Log con elapsed timer** | Deep-research UI muestra qué paso corre ahora + cuánto lleva | Panel en `ResearchStatePanel` |
| **Compound Authority worker** | BullMQ worker que llama PubChem cada 6h para resolver compounds `pending` | Auto en background, container `bioagents-worker` |
| **Contradi­ction stats RPC** | "Cuántas contradicciones hay en 1d/7d por estado" | `get_contradiction_stats` SQL RPC (admin) |

### ⚠️ Funcional con caveats

| Feature | Caveat |
|---|---|
| **Compound Authority resolution** | Solo 22 compounds con canonical_id (34 facts verificados). 200 facts `failed` después de 3 reintentos de PubChem (nombres específicos del marine biology no están en PubChem). 235 `pending` con attempts++. Backfill corre cada 6h. |
| **Discovery persistence** | Tabla `research_discoveries` existe pero está vacía. El agente escribe discoveries pero ningún consumer los lee aún. Read-side migration pendiente. |
| **Knowledge graph** | Solo cubre 22 compounds (los que PubChem conoció). El endpoint funciona pero el corpus visible es chico. |

### ❌ Lo que NO está en producción (work in progress)

- **Re-evaluation automática** (cron): solo manual v1
- **Re-evaluation alerts** ("papers nuevos relevantes para algo que buscaste antes"): schema soporta, UI no
- **Read migration** (PR #2 de discovery persistence): consumers siguen leyendo del JSONB
- **Citation graph cross-paper**: no existe
- **Multi-language papers** (es, pt): no soportado
- **Entity mention graph** (KG PR #2): no implementado
- **LLM semantic linker** (KG PR #3): no implementado
- **RLHF en fact extraction**: no hay feedback loop
- **Compound authority v2** (más curadores, más compuestos): frozen en v1
- **Edit/annotation en provenance viewer**: tabla viewer es read-only

---

## Sesión del 17 de junio — Logros

Esta sesión cerró el gap entre el diseño y la realidad operativa. Cambios concretos:

### Bug fixes (8)

1. **Traefik routing** — container `bioagents-caddy` perdió la conexión al network `coolify`. Fix: `docker network connect coolify bioagents-caddy`.
2. **Status label crash** — `statusLabel(undefined)` tiraba en UI. Fix: guarda `if (!status) return "—"`.
3. **Migraciones faltantes** — 4 migraciones críticas no se aplicaron (`daily_api_usage`, `record_api_call`, `graph_top_co_occurring`, `graph_top_string_field`). Aplicadas con `psql` desde el host.
4. **RAG "evidencia insuficiente"** — bug end-to-end en deep-research: `searchClaims` usaba `textSearch` con config `english` que no maneja acentos; knowledge agent truncaba chunks a 300 chars. Rewrites completos + extractor prompt fix.
5. **`useEffect` no defined** — `ResearchStatePanel` import faltante que rompía render. Fix: agregar import.
6. **`get_contradiction_stats` RPC rota** — la migración original referenciaba `resolution_status`/`created_at`/`dismissed_at` que no existen. Fix: nueva migración `20260617000000` con `CREATE OR REPLACE FUNCTION`.
7. **Env vars `environment:` sobreescribían `env_file:`** — `${VAR:-}` con empty default blankeaba vars de .env. Documentado.
8. **Mermaid en `FLOW_COMPARISON.md`** — los diagramas son Mermaid puro, se ven bien en GitHub/VSCode con extensión.

### Features nuevas (3)

1. **`bioagents-worker` container** — BullMQ workers (chat, deep-research, bioprospecting, document-ingestion, file-process, paper-generation, compound-authority) corren como proceso separado. Antes el código existía pero no había process.
2. **Compound-authority repeat tick** — el worker registra un job cada 6h. Antes la queue nunca corría porque nadie llamaba a `getCompoundAuthorityQueue()`.
3. **`FLOW_COMPARISON.md`** — diagrama Mermaid del flujo actual vs spec, tabla de 8 diffs, recap de bugs. Para próximos mantenedores.

### Métricas nuevas (corpus de prueba)

- 12 papers Marine Drugs ingestados (`docs/marinedrugs/`)
- 32 research sources totales (16 deep-research memories + 14 papers + 2 markdown)
- 1,123 evidence chunks
- 482 bioprospecting facts
- 22 canonical compounds + 23 aliases + 34 verified facts
- **End-to-end query validado**: "Qué anthoteibinenes tienen actividad antifúngica?" devuelve IC50 7.7–9.1 μg/mL para anthoteibinene J, anthoteibinene K inactivo (sin phenol), anthoteibinene I débil a 50 μg/mL, con DOI a `marinedrugs-23-00044.pdf`.

---

## Casos de Uso End-to-End

### Caso 1: Investigador busca "anthoteibinenes antifúngicas"

> Caso de uso validado end-to-end en esta sesión.

1. Usuario entra al chat, selecciona modo "deep research", escribe la query
2. API encola job en BullMQ → worker `deep-research` lo procesa
3. **Planning agent** descompone en tareas (literature search)
4. **Literature agent** hace fan-out: OpenScholar (externo), Edison (externo), **Knowledge agent (local)** — este último busca en `research_evidence_chunks` con embeddings
5. Knowledge agent encuentra 5-20 chunks relevantes del paper `marinedrugs-23-00044.pdf` (Anthoteibinenes F-Q)
6. **Hypothesis agent** recibe los chunks + corre `searchClaims()` con ilike-per-term para encontrar claims soportados
7. Hypothesis genera texto con IC50, SAR (estructura-actividad), DOI, citando evidencia chunk-por-chunk
8. Usuario ve en chat: key insights, evidence pack, hypothesis, methodology, **Activity Log** con timer

**Resultado concreto** (logged):
- IC50 7.7–9.1 μg/mL para anthoteibinene J contra Candida albicans (4 cepas)
- Anthoteibinene K inactivo — explicación estructural: "lacks the phenol functional group"
- Anthoteibinene I activo solo a 50 μg/mL

### Caso 2: Reviewer quiere validar un claim controversial

1. Admin entra a `/admin`, tab "Contradictions"
2. Ve: "0 contradicciones detectadas" (todavía — el detector corre pero no se generaron pairs en el corpus de prueba)
3. Click en una → ve los 2 facts en conflicto con sus sources, bboxes en el PDF, claim chains
4. Decide: "el paper A es más reciente" → click "Resolve" + reason: "manual review: paper A supersedes"
5. Sistema actualiza: `contradiction.status = 'resolved'`, escribe audit row, `resolved_at = NOW()`
6. Si era un falso positivo → click "Dismiss" en su lugar
7. **Stats tab** muestra: 0 contradicciones activas (vía `get_contradiction_stats` RPC con ventana 1d/7d)

### Caso 3: Investigador busca "curcumin" en el knowledge graph

1. Usuario entra a `/api/research-brain/graph/compounds/search?query=curcumin`
2. Backend corre `searchCompounds()` en `research_graph_compound_aggregates`
3. Devuelve: lista de compounds que matchean "curcumin" con `fact_count`, `source_count`, `last_seen_at`
4. Click en uno → GET `/api/research-brain/graph/compounds/{id}/co-occurring?limit=5` → top 5 compounds que co-aparecen
5. Click en uno → GET `/api/research-brain/graph/compounds/{id}/bioactivities` → top bioactivities (vía `graph_top_string_field` RPC)

> En el corpus actual: 22 compounds visibles (los que PubChem conoció). Curcumin no está en el corpus Marine Drugs, así que devuelve `[]`. Para verlo, ingestar papers sobre curcumin.

---

## Arquitectura Interna (Resumen)

### Pipeline de Deep Research

```
User query
   ↓
Planning Agent (LLM) → plan de tareas (PlanTask en JSONB)
   ↓
Execute Tasks (BullMQ workers) → ejecutan extracción, búsqueda, análisis
   ↓
Hypothesis Agent (LLM) → genera claim tentativo basado en outputs
   ↓
Reflection Agent (LLM) → evalúa el claim, decide si es robusto
   ↓
Discovery Agent (LLM) → identifica insights noveles
   ↓
   ├─→ JSONB (conversation_states.values.discoveries)  ← consumers actuales
   └─→ research_discoveries (Postgres, v1+)              ← persistencia, future re-eval
   ↓
Reply to user
```

### Capa de Datos (Postgres + Supabase)

```
research_sources (papers)
   ├── research_evidence_chunks (text chunks con embeddings)
   ├── research_evidence_tables (tablas extraídas, bbox, multi-page chains)
   │     └── research_bioprospecting_facts ←──┐
   │           ├── evidence_table_id (FK)     │ composición canónica
   │           ├── compound_authority_status  │   pending/verified/failed/skipped
   │           ├── compound_canonical_id (FK) │
   │           └── ...                        │
   ├── research_evidence_figures (figuras, bbox, extracted image)
   ├── research_claims (semantic claims, supported/contradicted/partial)
   │     ├── research_bioprospecting_contradictions (cross-paper contradictions)
   │     └── research_edges (generic edge table)
   └── research_discoveries (insights, version history, soft-delete) ← v1+
         └── research_discovery_evidence (FKs a evidence)
         └── research_discovery_reeval_audit (forward-compat, empty in v1)
research_taxa + research_taxon_aliases (species canonical)
research_compounds + research_compound_aliases (compound canonical, PubChem-backed)
research_graph_compound_aggregates (materialized view, KG v1)
  └── refresh_compound_aggregates() — soft-fail RPC
  └── graph_top_co_occurring() — query-time CTE
  └── graph_top_string_field() — geography/bioactivity buckets
daily_api_usage + record_api_call() — cost tracking
research_bioprospecting_dedup_audit — soft-delete merge history
```

### Workers BullMQ (en container `bioagents-worker`)

| Worker | Trigger | Concurrency | Notas |
|---|---|---|---|
| `chat` | POST /api/chat (con queue) | 5 | |
| `deep-research` | POST /api/deep-research/start | 3 | Orquestador principal |
| `bioprospecting` | Encolado por document-ingestion | 1 | LLM extraction de chunks |
| `document-ingestion` | POST /api/research-brain/ingest | 2 | PDF → chunks + tables + figures |
| `compound-authority` | Repeat cada 6h | 1 | PubChem backfill |
| `file-process` | Upload directo | 5 | |
| `paper-generation` | POST /api/deep-research/.../paper | 1 | LaTeX compile |

---

## Comparación con Alternativas

| Plataforma | Foco | Diferenciador de BioAgents |
|---|---|---|
| **OpenScholar** | Literature search + RAG | BioAgents extrae **datos estructurados** (compounds, bioactivities) con provenance, no solo texto |
| **Elicit** | Paper analysis con LLM | BioAgents **acumula** conocimiento cross-paper (dedup, contradictions, knowledge graph), Elicit es stateless |
| **Consensus** | Search across papers, "what do studies say" | BioAgents tiene **provenance visual** hasta párrafo/tabla/figura exactos, Consensus muestra snippets |
| **SciSpace** | Paper reading con explanations | BioAgents tiene **deduplicación semántica** (mismo finding en 2 papers = 1 row con FK), SciSpace no |
| **ChatGPT / Claude** | General chat | BioAgents es **domain-specific** (bioprospecting), con **taxonomy/compound authority tables** que un chatbot genérico no tiene |

**El diferenciador clave**: BioAgents no es un chatbot que resume papers — es un **sistema de acumulación de conocimiento verificable**. Cada claim está linkeado a su evidencia exacta, deduplicado cross-paper, y contrastado con claims contradictorios. Eso es lo que un AI scientist real hace, no un chatbot.

---

## Roadmap — Qué Viene

> **Constraint de capacidad (jun 2026)**: la cuenta de OpenRouter está sin saldo.
> El roadmap está filtrado por **dependencia de LLM en runtime**:
>
> - 🟢 **LLM-free** = se puede avanzar ahora (código, SQL, heurística, UI, config)
> - 🟡 **LLM-light** = v1 sin LLM + v2 con LLM cuando haya saldo
> - 🔴 **LLM-required** = bloqueado hasta recargar saldo
>
> Toda etiqueta 🟢 o 🟡 es **accionable hoy**. Las 🔴 quedan en el roadmap
> pero solo se empiezan a hacer cuando vuelva a haber crédito en OpenRouter.

### 🔴 Alta prioridad

| # | Feature | Esfuerzo | LLM? | Por qué importa |
|---|---|---|---|---|
| 1 | **Commitear trabajo en disco** (LocalStorageProvider + assets route + hypothesis grounding + Range support) | XS (1 sesión) | 🟢 no | 2 features completas sin commitear, riesgo bajo |
| 2 | **Resolver 200 PubChem `failed`** | M (1-2 días) | 🟢 no | Heurística de strings (alias, fuzzy, normalización) recupera ~50-80 facts |
| 3 | **Read migration** (Discovery persistence PR #2) | M (1-2 días) | 🟢 no | Consumers dejan JSONB, leen DB → un solo source of truth |
| 4 | **Re-evaluation scheduled worker v1** (BullMQ cron, sin LLM) | M (1-2 días) | 🟡 v1 sin LLM | Match por metadata (compound/species), no por semántica. v2 con LLM después |
| 5 | ~~Multi-page table merge~~ ✅ **shipped** (PR #1 + #2 + #3 merged) | — | 🟢 no | Backfill script + package.json + runbook operacionales |
| 6 | ~~Citation graph cross-paper~~ ✅ **shipped** (GET /api/research-brain/citations/:sourceId, LLM-free) | — | 🟢 no | SQL joins on `compound_canonical_id`, `species_taxon_id`, and DOI |
| 7 | **Entity mention graph** (KG PR #2) | M (1-2 días) | 🔴 sí | "Este compound trata enfermedad Y" requiere LLM extraction |
| 8 | **LLM semantic linker** (KG PR #3) | M (1-2 días) | 🔴 sí | Relaciones automáticas entre facts sin link manual |

### 🟡 Media prioridad

| # | Feature | Esfuerzo | LLM? | Por qué importa |
|---|---|---|---|---|
| 9 | **Corpus ingestion dashboard** | M (1-2 días) | 🟢 no | UI admin que lista docs, lee de DB, status counters |
| 10 | **Document ingestion worker pool** | S-M | 🟢 no | BullMQ concurrencia, sin LLM |
| 11 | **Multi-language papers** (es, pt) | M (1-2 días) | 🟢 no | Bioprospecting sudamericano es nuestro nicho; depende más de Mistral OCR config que de LLM |
| 12 | **Edit/annotation en provenance viewer** | M (1-2 días) | 🟢 no | Investigador puede marcar cells de tabla con notas |
| 13 | **Compound authority v2** (more curators) | M (1-2 días) | 🟢 no | +500 compuestos curados, más idiomas; seed + backfill sin LLM |
| 14 | **Auth resolver: role `researcher`** | S (1 día) | 🟢 no | Relajar el "todo es admin" |

### 🟢 Baja prioridad / especulativo

| # | Feature | Esfuerzo | LLM? | Por qué importa |
|---|---|---|---|---|
| 15 | **Re-evaluation v2** (LLM semantic match) | M (1-2 días) | 🔴 sí | Upgrade del #4 cuando haya saldo |
| 16 | **RLHF en fact extraction** | XL (1+ semana) | 🔴 sí | Quality mejora con el uso |
| 17 | **XObject extraction** (re-spike con pdfjs@6) | M | 🟢 no | Recuperar figuras vector-only cuando salga |
| 18 | **Coverage report + CI gate** | S (1 día) | 🟢 no | Higiene de tests |

### Principio detrás del orden

**Esta semana** (sin saldo LLM): el objetivo es **vaciar el backlog LLM-free** y dejar
los 🟡 (v1) con código sin LLM. Cuando vuelva el saldo, los LLM-required (#7, #8, #15, #16)
arrancan sobre cimientos que ya están en producción.

1. **#1 Commit en disco** (15-30 min) — primer paso antes de cualquier otra cosa.
2. **#2 PubChem fuzzy recovery** — quick win visible en el KG (más compounds visibles).
3. **#3 Read migration** — refactor habilitante, sin riesgo de runtime.
4. **#4 Re-eval v1 (sin LLM)** — completa el ciclo de discovery persistence.
5. **#5/#6 Multi-page + citation graph** — depth del bioprospecting, sin LLM.
6. **#9/#10 UI + infra** — pulido.

Cuando vuelva el saldo:
- #7 Entity mention graph
- #8 LLM semantic linker
- #15 Re-eval v2 (semantic match)
- #16 RLHF loop

---

## Stats del Proyecto

| Métrica | Valor |
|---|---|
| Commits ahead de `origin/dev` (local) | 71 |
| Total commits en `dev` | 623 |
| OpenSpec changes archivados | 8 (ver lista abajo) |
| OpenSpec capabilities en main specs | 13 |
| Tests passing | 591 |
| Tests failing | 4 (3 en dedup + 1 contradictionLlM env-dependent) |
| Tests skipped | 7 |
| LOC producción | 57,449 |
| LOC tests | 17,304 |
| Lenguaje principal | TypeScript (Bun runtime) |
| Base de datos | Postgres via Supabase |
| Job queue | BullMQ (Redis) |
| Storage | S3 (PDFs, extracted images) |
| Workers containers | 1 (`bioagents-worker`, 7 BullMQ workers adentro) |
| Corpus actual | 12 papers Marine Drugs, 32 sources, 1,123 chunks, 482 facts |

### Corpus bioprospecting actual (snapshot)

| Métrica | Valor |
|---|---|
| research_sources (papers) | 32 |
| research_evidence_chunks | 1,123 |
| research_bioprospecting_facts | 482 |
| └ verified (canonical_id asignado) | 34 (7%) |
| └ pending (con attempts++) | 235 (49%) |
| └ failed (maxRetries alcanzado) | 200 (41%) |
| └ skipped (extracts/mixtures) | 13 (3%) |
| research_compounds (canonical) | 22 |
| research_compound_aliases | 23 |
| research_graph_compound_aggregates (KG v1) | 22 |
| research_bioprospecting_contradictions | 0 (ninguna detectada aún) |
| research_discoveries | 0 (ninguna persistida aún) |

### Changes archivados (8)

1. `bioprospecting-semantic-dedup` — identity_key + edge table + backfill
2. `bioprospecting-pdf-provenance-viewer` — custom pdfjs-dist@5 detector + PDF.js viewer + lightbox
3. `bioprospecting-compound-authority` — seed + PubChem lookup + audit
4. `bioprospecting-knowledge-graph` v1 — compound-centric aggregates + search
5. `cost-guard-rails` — daily/monthly caps + soft-fail + admin drill-down
6. `bioprospecting-figure-image-extraction` — Mistral raster + render-crop vector
7. `bioprospecting-review-ui` — admin page (Contradictions + Dedup + Stats)
8. `discovery-persistence` v1 — relational discoveries + dual-write

### Capabilities en main specs (13)

`bioprospecting-fact-dedup`, `pdf-provenance-viewer`, `pdf-table-extraction`, `research-bioprospecting`, `bioprospecting-contradiction-detection`, `bioprospecting-compound-authority`, `bioprospecting-semantic-dedup`, `api-cost-guard-rails`, `bioprospecting-knowledge-graph`, `bioprospecting-review-ui`, `bioprospecting-fact-dedup` (delta), `discovery-persistence`, `bioprospecting-contradiction-detection` (delta).

---

## Cómo Continuar

> **Constraint activo**: OpenRouter sin saldo. Priorizar tareas 🟢 (LLM-free) y 🟡 v1 (sin LLM).

**Próximo paso recomendado** (en orden, sin LLM):

1. **#1 Commit trabajo en disco** (LocalStorageProvider + assets route + hypothesis grounding) — 15-30 min, ganancia segura
2. **#2 PubChem fuzzy recovery** — quick win visible (más compounds en el KG)
3. **#3 Read migration** — refactor habilitante, 0% LLM
4. **#4 Re-evaluation v1 (sin LLM)** — completa el ciclo de discovery persistence
5. **#5 ~~Multi-page table merge~~ shipped** (PR #1-#3 merged; backfill script disponible, ver runbook abajo)
6. **#6 ~~Citation graph cross-paper~~ shipped** (GET /api/research-brain/citations/:sourceId, admin-only, LLM-free)

**Runbook: Multi-Page Table Merge (backfill operacional)**
```bash
# 1) Ver qué parches se aplicarían (dry-run; no escribe nada)
bun run merge:tables

# 2) Limitar a 500 sources candidatos (default 100)
bun run merge:tables --limit=500

# 3) Aplicar los parches (escribe los FKs en research_evidence_tables.continues_from_id)
bun run merge:tables:apply

# 4) Help completo
bun run merge:tables --help
```
El script es incremental: sources con `continues_from_id IS NOT NULL` ya tienen chain y se saltean. Re-runs son no-op. Respeta `TABLE_MERGE_MODE` (default `hard-confidence`) y `TABLE_MERGE_THRESHOLD` (default `0.7`).

**Cuando vuelva el saldo** OpenRouter:
- #7 Entity mention graph (KG PR #2)
- #8 LLM semantic linker (KG PR #3)
- #15 Re-evaluation v2 (semantic match)
- #16 RLHF loop

Si querés arrancar con uno, decime cuál. Si querés descansar, este documento es el snapshot del estado al **19 de junio de 2026**.

## Documentos relacionados

- `FLOW_COMPARISON.md` — diagrama del flujo actual vs spec'd (creado esta sesión)
- `openspec/specs/research-bioprospecting/spec.md` — spec principal de bioprospecting
- `openspec/changes/` — directorio de cambios en flight + archive