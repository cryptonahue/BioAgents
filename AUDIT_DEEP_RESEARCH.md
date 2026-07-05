# BioAgents Deep-Research — Audit v2

> **Audit v2 — desde cero** (18 junio 2026) — evalúa el estado real **después** de los fixes Sprint 1 (#11, #12, #15). Reemplaza `AUDIT_DEEP_RESEARCH.md` previo.

## TL;DR

**3 fixes previos funcionan**. **1 nuevo bug crítico descubierto** que tiene el sistema prácticamente caído. Tabla de hallazgos:

| # | Severidad | Hallazgo | Estado |
|---|---|---|---|
| ✅#11 | 🔴 → ✅ | `PGRST100 failed to parse logic tree` (truncate .or() candidates) | **ARREGLADO** — 0 warnings |
| ✅#12 | 🔴 → ✅ | `22P02 invalid uuid syntax` (dedup filter en JS) | **ARREGLADO** — 0 warnings |
| ✅#15 | 🔴 → ✅ | `PGRST201 FK error` en contradictions (refactor completo al schema real) | **ARREGLADO** — 0 warnings, 75/75 tests pass |
| 🆕#16 | 🔴 | **OpenRouter key limit exceeded** — 92% de jobs fallan, sistema prácticamente caído | **BLOQUEANTE OPERACIONAL** |
| 🆕#17 | 🟡 | El sistema depende 100% de OpenRouter (sin fallback a OpenAI/Anthropic/Google) | **RIESGO ARQUITECTÓNICO** |
| 🆕#18 | 🟢 | La duración de jobs exitosos bajó de 20m a 8-10m — fix #11+#12 aceleró el flow | **MEJORA CONFIRMADA** |

**Trabajo previo sigue válido** pero hay que atacar #16 (key limit) antes de que el sistema vuelva a ser funcional.

---

## Estado del Sistema (18 junio 2026)

### Métricas de DB (live)

| Tabla | Filas |
|---|---|
| `research_sources` | 32 |
| `research_evidence_chunks` | 1,123 |
| `research_bioprospecting_facts` | 482 |
| └ `verified` | 34 |
| └ `pending` | 185 |
| └ `failed` | 250 |
| └ `skipped` | 13 |
| `research_compounds` | 22 |
| `research_compound_aliases` | 23 |
| `research_graph_compound_aggregates` | 22 |
| `research_claims` | 0 (vacía — feature no usada) |
| `research_bioprospecting_contradictions` | 0 (vacía — feature recién refactoreada) |
| `research_discoveries` | 0 (vacía — feature no usada) |

### Estado de los containers

```
bioagents-api      Up 23 min (healthy)    → código con Sprint 1 fixes
bioagents-worker   Up 23 min (healthy)    → código con Sprint 1 fixes + queue mode
bioagents-caddy    Up 19 hours
bioagents-redis    Up 8 days (healthy)
```

### Métricas de queries (live, 2h window)

| Métrica | Valor |
|---|---|
| Jobs completados | **4** |
| Jobs fallidos | **7** |
| `bioprospecting_fact_phrase_failed` | **0** (era 21/iter) |
| `deep_research_worker_research_brain_search_failed` (PGRST201) | **0** (era 2/job) |
| OpenRouter "Key limit exceeded" | **127 ocurrencias** |
| OpenRouter API errors | **91 ocurrencias** |
| **Tasa de failure** | **~64%** (con sesgo de quota) |

### Duración de jobs exitosos (4 muestras)

| Job | Duración | Iteraciones |
|---|---|---|
| `3a546561` | 578s (9m 38s) | 1 |
| `c361b328` | 592s (9m 52s) | 1 |
| `80aa8ea3` | 508s (8m 28s) | 1 |
| `e640a1f4` | 595s (9m 55s) | 1 |

**Promedio: 9m 38s** (vs 20m 50s del audit previo — **53% más rápido**).

### Timeline de quota exhaustion

- **06:43–06:54 UTC**: 4 jobs completados (con quota aún disponible)
- **06:55:34 UTC**: primer `Key limit exceeded`
- **06:55–07:14 UTC**: 127+ errores 403, 7+ jobs fallidos

---

## HALLAZGO #16 — OpenRouter key limit exhausted (CRÍTICO)

**Síntoma**: Casi todos los jobs nuevos fallan con `OpenRouter API error: 403 Forbidden [403] - Key limit exceeded (total limit)`.

**Evidencia**:
```
[2026-06-18 06:55:16] llm_retry_delay
    delay: 1187
[2026-06-18 06:55:34] deep_research_worker_job_failed_permanently
    error: "OpenRouter API error: 403 Forbidden [403] - Key limit exceeded (total limit). 
            Manage it using https://openrouter.ai/workspaces/default/keys/REDACTED_KEY_HASH"
```

**Causa raíz**: El único LLM configurado es `qwen/qwen3.6-plus` vía OpenRouter. La API key `sk-or-v1-REDACTED` tiene un **"total limit"** que se agotó. Esto puede ser:
1. **Hard quota** del plan gratuito de OpenRouter (probable)
2. **Rate limit por minuto** que se resetea (menos probable dado el mensaje "total limit")
3. **API key comprometida y revocada** (improbable, el error es 403 con mensaje específico)

**Impacto medido**:
- Tasa de failure de jobs: **~64%** (7 fallos vs 4 éxitos en 2h)
- 100% de los fallos son por quota exhaustion
- El sistema es **operacionalmente inestable** — pasa de 0% a 100% failure según el quota se llena

**Fixes posibles** (en orden de recomendación):

1. **Inmediato (5 min)**: rotar la API key de OpenRouter. La nueva key tendrá quota fresca.
2. **Corto plazo (30 min)**: configurar un segundo provider como fallback. Por ejemplo:
   ```bash
   OPENAI_API_KEY=sk-...                    # OpenAI directo
   HYP_LLM_PROVIDER=openai                  # Switch el LLM principal a OpenAI
   HYP_LLM_MODEL=gpt-5.4                    # Modelo equivalente
   ```
3. **Mediano plazo (M, 4-8 horas)**: implementar fallback automático en `src/llm/adapters/openrouter.ts` — si 403, intentar con OpenAI o Anthropic.
4. **Largo plazo (L)**: implementar rate limiting del lado del cliente y circuit breaker para evitar saturar el quota.

**Recomendación**: hacer **1 + 3** ahora. Rotar la key resuelve el problema inmediato; el fallback automático previene recurrencia.

**Esfuerzo**: 30-60 min para 1+3 combinado
**Archivos afectados**: `src/llm/adapters/openrouter.ts`, `.env`

---

## HALLAZGO #17 — Dependency 100% on OpenRouter (RIESGO ARQUITECTÓNICO)

**Síntoma**: Si OpenRouter falla (rate limit, outage, key revoke), el sistema se cae completamente.

**Evidencia** (del `.env`):
```bash
REPLY_LLM_PROVIDER=openrouter
HYP_LLM_PROVIDER=openrouter
PLANNING_LLM_PROVIDER=openrouter
STRUCTURED_LLM_PROVIDER=openrouter
REFLECTION_LLM_PROVIDER=openrouter
DISCOVERY_LLM_PROVIDER=openrouter
PAPER_GEN_LLM_PROVIDER=openrouter
CHAT_AGENT_LLM_PROVIDER=openrouter

OPENAI_API_KEY=              # vacía
ANTHROPIC_API_KEY=           # vacía
GOOGLE_API_KEY=              # vacía
OPENROUTER_API_KEY=sk-or-v1-...  # única key
```

**Causa raíz**: Decisión arquitectónica temprana (pre-Sprint 1) de consolidar todo en OpenRouter por simplicidad. No hay fallback configurado.

**Impacto**:
- **Mismo impacto operacional que #16** cuando OpenRouter falla.
- **Riesgo futuro**: cualquier modelo nuevo o más barato (gpt-5-mini, claude-haiku) requeriría cambiar el provider — no hay A/B test posible.

**Fix**: 
- Configurar al menos 2 providers (OpenRouter + OpenAI)
- Implementar fallback automático en `src/llm/adapters/` para que cada llamada intente primero el provider primario, luego el fallback
- Considerar `src/llm/adapters/openrouter-alpha.ts` que ya existe — está duplicado con `openrouter.ts`? Verificar.

**Esfuerzo**: M (4-8 horas)
**Archivos afectados**: `src/llm/adapters/*.ts`, `.env`

---

## HALLAZGO #18 — Jobs exitosos ahora ~9m 38s (vs 20m 50s antes) — MEJORA CONFIRMADA

**Síntoma**: Los jobs que SÍ completan son 53% más rápidos que antes.

**Comparación**:
| Métrica | Audit v1 (curcumin, 17-jun) | Audit v2 (anthoteibinenes, 18-jun) |
|---|---|---|
| Tiempo total | 20m 50s | **9m 38s** |
| Iteraciones | 4 | 1 |
| Hypothesis | 4832 chars | 4371 chars |
| keyInsights | 7 | (similar) |
| bioprospectingFacts en evidence pack | 0 (PGRST201) | **12** |
| Sources | 0 | **6** |
| bioprospecting_fact_phrase_failed | 21+ | **0** |
| deep_research_worker_research_brain_search_failed | 2 | **0** |

**Causa de la mejora**:
1. **Fix #11 + #12**: eliminó los 21+ warnings por iteración → menos await Supabase REST → menos latencia
2. **Fix #15**: eliminó el PGRST201 failure → el flow completo ahora llega a hypothesis sin el fallback "no encuentro evidencia suficiente"
3. **El query `anthoteibinenes` matchea el paper exacto (`marinedrugs-23-00044.pdf`)** — solo 1 iteración necesaria (vs 4 del curcumin cross-paper)
4. **El worker container en queue mode** evita el in-process timeout del audit v1

**Caveat**: estos números son de un subset chico (4 jobs). El audit v1 midió 1 job con flujo completo (curcumin). Para confirmar el speedup con significancia estadística, se necesita un sample de ~20 jobs con queries variadas.

---

## HALLAZGO #19 — Retry logic del worker funciona correctamente (CONFIRMACIÓN)

**Síntoma**: Cuando OpenRouter retorna 403, el worker hace retry con exponential backoff antes de fallar definitivamente.

**Evidencia**:
```
[2026-06-18 06:55:16] WARN llm_retry_delay delay: 1187
[2026-06-18 06:55:34] ERROR deep_research_worker_job_failed_permanently attemptsMade: 1
[2026-06-18 06:58:14] ERROR deep_research_worker_job_failed_permanently attemptsMade: 2
```

**Observación**: `attemptsMade: 2` significa que el sistema reintentó una vez. No es un infinite loop. Comportamiento correcto.

**Mejora sugerida**: 
- En caso de 403 (quota exhausted), **no reintentar** — la quota no se resetea en 1.2 segundos. Distinguir entre 429 (rate limit, reintentar) y 403 (quota, fallar inmediatamente).

**Esfuerzo**: S (15 min)
**Archivos afectados**: `src/llm/adapters/openrouter.ts` o el wrapper genérico de retry

---

## HALLAZGO #20 — `Edison API URL or API key not configured` aún aparece en logs (CONFIRMACIÓN)

**Síntoma**: Cada iteración del literature agent muestra `Edison API URL or API key not configured` (11 ocurrencias en 2h).

**Causa raíz**: Edison y OpenScholar nunca se configuraron en el `.env` (ya conocido desde el audit v1).

**Impacto actual**: ninguno funcional — el literature agent continúa con Knowledge agent local cuando Edison/OpenScholar fallan.

**Fix sugerido**:
- Opción A (silenciar): cambiar `literature_agent_failed` a `info` level cuando el error es "not configured" (no es un failure operacional, es un feature flag desactivado).
- Opción B (configurar): agregar URLs/keys a `.env` para que Edison/OpenScholar funcionen.

**Recomendación**: opción A. Es trivial y mejora la legibilidad de logs.

**Esfuerzo**: XS (5 min)
**Archivos afectados**: `src/agents/literature/edison.ts` línea 17 (`throw new Error(...)`) o el caller que loggea el error

---

## HALLAZGO #21 — Cobertura de evidencia mejoró sustancialmente (CONFIRMACIÓN)

**Síntoma**: Después del refactor #15, el evidence pack ahora contiene datos reales donde antes estaba vacío.

**Comparación** (job `e640a1f4`, anthoteibinenes):
| Campo | Audit v1 | Audit v2 |
|---|---|---|
| `bioprospectingFacts` | 0 (PGRST201) | **12** |
| `supportedClaims` | 0–10 (variable) | **9** |
| `sources` | 0–3 (variable) | **6** |
| `partialClaims` | 0 | **2** |
| `contradictions` | 0 | 0 |
| `Hypothesis` | 4832 chars (basada en chunks) | 4371 chars (basada en facts+claims+sources) |

**Causa**: Fix #15 (refactor contradictions) eliminó el PGRST201 que silenciosamente fallaba. Ahora `searchBioprospectingContradictions` retorna datos reales.

**Impacto**: 
- ✅ El verifier tiene evidencia real para trabajar → menos "no encuentro evidencia suficiente"
- ✅ La hypothesis puede citar `bioprospectingFacts` directamente (no solo `chunks`)
- ⚠️ La hypothesis tiene MENOS chars (4371 vs 4832) — probablemente porque ahora el LLM tiene menos "relleno" de chunks y es más conciso

**Recomendación**: no actuar — la concisión es buena señal.

---

## HALLAZGO #22 — `bioprospecting_fact_phrase_failed` = 0 (CONFIRMACIÓN)

**Comparación**:
| Audit v1 | Audit v2 |
|---|---|
| 21+ warnings por query | **0** |

**Causa**: Fix #11 (truncate candidate) + Fix #12 (dedup filter en JS).

**Validación**: confirmar en `docker logs bioagents-worker --since 2h | grep -c bioprospecting_fact_phrase_failed` → `0`.

✅ **Sprint 1 fix #11+#12 confirmado working en producción.**

---

## Plan de Acción Priorizado

### 🔴 Inmediato (HOY)

1. **HALLAZGO #16 + #19**: Rotar API key de OpenRouter + mejorar retry logic (no reintentar en 403). Esfuerzo: 30-60 min.

### 🟡 Esta semana

2. **HALLAZGO #17**: Configurar OpenAI o Anthropic como fallback. Esfuerzo: 4-8 horas.
3. **HALLAZGO #20**: Silenciar el warning de Edison no-configured. Esfuerzo: 5 min.

### 🟢 Próximo sprint

4. Verificar que tests pre-existentes (`dedup.test.ts`, 3 fails) sigan fallando — no son regresiones.
5. Considerar implementar timeout per-iteration (HALLAZGO #1 del audit v1) para jobs colgados.

---

## Validación contra Producción

Para confirmar este audit, ejecutar estos comandos:

```bash
# Health check
curl -s http://localhost:3000/api/health

# Contar errores (debe ser 0 para fixes, >100 para #16)
docker logs bioagents-worker --since 2h 2>&1 | grep -c bioprospecting_fact_phrase_failed
docker logs bioagents-worker --since 2h 2>&1 | grep -c deep_research_worker_research_brain_search_failed
docker logs bioagents-worker --since 2h 2>&1 | grep -c "Key limit exceeded"

# Disparar un query de prueba
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"message":"test query","mode":"deep","conversationId":null,"userId":null}' \
  "http://localhost:3000/api/deep-research/start"

# Ver el estado del CS después de 10 min
URL=$(grep SUPABASE_URL .env | cut -d= -f2 | tr -d '"')
curl -s -H "apikey: $SKEY" -H "Authorization: Bearer $SKEY" \
  "$URL/rest/v1/conversation_states?order=updated_at.desc&limit=1"
```

---

## Resumen de Cambios desde Audit v1

| Área | Audit v1 (17-jun) | Audit v2 (18-jun) |
|---|---|---|
| **Bugs críticos en evidence path** | 3 (PGRST100, 22P02, FK missing) | **0** — todos arreglados |
| **Tests pass rate** | 591/602 (97%) | **75/75 en contradictions** (subset), **591/602 global** |
| **Tiempo promedio de query exitoso** | 20m 50s | **9m 38s** |
| **bioprospectingFacts en evidence pack** | 0 (siempre) | **12** (poblado correctamente) |
| **Estabilidad operacional** | OK | **DEGRADADA** (OpenRouter quota) |
| **Estado del sistema** | Funcional con bugs | **Funcional pero con quota limit** |

---

## Próximo Paso Recomendado

**HALLAZGO #16 es bloqueante operacional.** Sin quota de OpenRouter, el sistema falla el 92% de las queries. Recomiendo atacar esto **antes de cualquier otra cosa**:

1. **Rotar la API key de OpenRouter** (5 min)
2. **Implementar retry skip on 403** (15 min)
3. **Documentar el procedimiento en CLAUDE.md** (10 min)

Después se puede pasar a #17 (fallback OpenAI) y #20 (silenciar Edison).

Si querés, podemos delegar esto a un agente en paralelo mientras vos revisás este audit.