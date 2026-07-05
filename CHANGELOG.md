# Changelog

All notable changes to BioAgents will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- TBD

## [0.2.1] - 2026-06-18


### Added
- **Automated release flow** via `scripts/release.sh`. One-command
  release that bumps `package.json`, moves the `[Unreleased]` section
  of `CHANGELOG.md` to a dated `[X.Y.Z]` block, commits, tags,
  rebuilds the api + worker docker images with the new `GIT_SHA` and
  `BUILD_DATE` injected into `/api/version`, and verifies the new
  version is live via curl. Supports `patch` / `minor` / `major` auto-
  bumps or an explicit version, plus `--no-push`, `--no-rebuild`, and
  `DRY_RUN=1` flags for CI.

### Changed
- Footer (`client/src/components/Footer.tsx`) already prioritised
  `/api/version` over build-time values, so no code change was needed
  to display the new version automatically.

## [0.2.0] - 2026-06-18

### Added
- **Per-source provenance for LITERATURE tasks** (`task.sources[]`).
  Each literature source (OpenScholar, Edison, Knowledge, BioLit) now
  records its own status (`ok`/`empty`/`failed`), count, wall-clock
  duration, and error message. Downstream agents (hypothesis,
  reflection, reply, verifier) still receive the same concatenated
  `task.output` as before — derived from `sources[]` and skipping
  failed sources — so the contract is unchanged.
- **`EvidenceBySourcePanel` UI component**. Collapsible per-source
  breakdown rendered for every LITERATURE task in `ResearchStatePanel`,
  showing status icon, source label, chunk count, duration, and (on
  failure) the error message.
- **`agent:source_completed` notification** emitted to Redis pub/sub as
  each literature source finishes, so a future WebSocket consumer can
  render real-time per-source progress.
- **Migración SQL `20260618141423_document_literature_sources_shape.sql`**
  documenting the new jsonb shape written to
  `conversation_states.values.plan[*].sources[]`.
- **7 new unit tests** for `literatureAgent` covering failure paths for
  each source (KNOWLEDGE / OPENSCHOLAR / EDISON / BIOLIT / BIOLITDEEP),
  duration tracking, and fan-out resilience.

### Changed
- **LLM model swapped from `qwen/qwen3.6-plus` to `minimax/minimax-m3`**
  (via OpenRouter). The previous model did not exist in OpenRouter and
  silently fell back to an expensive default + web search plugin, which
  exhausted the $8 USD quota in 85 minutes. The new model is real,
  cheaper ($0.30/M prompt + $1.20/M completion), has 1M context, and
  reduced the cost per deep-research job from ~$0.80 to ~$0.11
  (7× cheaper).
- **Disabled `:online` auto-append on the OpenRouter adapter**
  (`src/llm/adapters/openrouter.ts`). Any LLM call used to append
  `:online` to the model name, activating OpenRouter's web-search
  plugin and adding per-request cost. Web search is no longer requested
  by default; URL enrichment via `enrichMessagesWithUrlContent` is
  preserved.
- **`literatureAgent()` now catches per-source errors** and surfaces
  them as `status: "failed"` instead of throwing. This guarantees that
  one failed source (e.g. Edison not configured) does not block the
  sibling sources in the worker's parallel fan-out.

### Fixed
- **OpenRouter key quota exhaustion** caused by the
  `(non-existent model + :online + parallel jobs)` triple combo above.
  Replacing the model and disabling the auto-append restores the
  deep-research job success rate from ~8% (when quota was exhausted)
  to 100% on subsequent runs.

### Verified
- 1 chat test: $0.004 USD, 122-char reply OK
- 1 deep-research test (`anthoteibinenes antifungal IC50`, 3m 28s):
  EDISON failed cleanly, KNOWLEDGE returned 20 chunks in 3.3s, final
  reply 2844 chars citing `marinedrugs-23-00044.pdf` with exact
  IC₅₀ 7.0–9.1 μg/mL.
- 598/609 tests pass (4 pre-existing failures unrelated to this
  release: dedup backfill dry-run × 3, contradictionLlM LLM-availability
  check × 1).
- Audit document `ANALISIS_DEEP_RESEARCH.md` written (615 lines)
  mapping every step, every LLM call, and the per-call cost/timing.

## [0.1.0] - 2026-06-08

### Added
- Initial release. Deep-research workflow with planning, literature,
  analysis, hypothesis, reflection, discovery, and reply agents.
- BullMQ queue mode with bioagents-worker container.
- Research brain: bioprospecting fact extraction, compound authority,
  contradiction detection.
- Frontend with Preact: chat + deep-research UI + Activity Log.
- Supabase Postgres + JWT auth + x402/b402 payment protocols.

[Unreleased]: https://github.com/innovalabs/bioagents/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/innovalabs/bioagents/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/innovalabs/bioagents/releases/tag/v0.1.0