# Research Brain: Evidence-First Architecture

BioAgents Research Brain turns loaded papers, datasets, external literature results, and generated artifacts into a strict scientific memory. The core rule is:

> No scientific fact is treated as validated unless it has traceable evidence.

The system separates claims, evidence, and synthesis so agents can answer from papers without silently inventing or over-generalizing.

## Goals

- Make loaded papers the first source of truth for chat and deep research.
- Preserve provenance for every supported claim: source, chunk, DOI/URL, section/page when available.
- Separate internal evidence from external literature evidence.
- Store hypotheses and open questions without promoting them to facts.
- Expose the memory through APIs and a Research Brain UI.

## Ingestion Flow

Papers enter Research Brain from two paths:

1. `KNOWLEDGE_DOCS_PATH` startup ingestion, usually `docs/`.
2. Global paper upload from the Library or Research Brain UI.

The ingestion pipeline:

1. Parse the file through the existing document processor.
2. Chunk the text through the existing chunker.
3. Store chunks in `documents` with embeddings.
4. Register a `research_sources` row.
5. Copy citable chunks into `research_evidence_chunks`.
6. Run claim extraction.
7. Store extracted claims in `research_claims`.
8. Store lightweight graph edges in `research_edges`.

If claim extraction fails, the source remains searchable and is marked `failed_extraction`. Ingestion should not be blocked by an LLM failure.

## Evidence Model

Research Brain uses four main tables:

- `research_sources`: papers, datasets, external results, generated artifacts.
- `research_evidence_chunks`: citable fragments tied to a source and optionally a `documents.id`.
- `research_claims`: atomic scientific claims with status and confidence.
- `research_edges`: lightweight graph relations such as `supports`, `contradicts`, `derived_from`, and `tests`.

Claim statuses:

- `supported`: directly grounded in a cited chunk.
- `partial`: limited or indirect support.
- `contradicted`: evidence conflicts with another claim.
- `hypothesis`: inference, not a fact.
- `open_question`: missing or explicitly unresolved evidence.

Trust tiers:

- `internal`: loaded papers, datasets, or generated artifacts from the platform.
- `external`: OpenScholar, BioLit, Edison, or other outside results.

Agents must not mix trust tiers silently. External evidence should be named as external when used.

## Anti-Hallucination Policy

Chat and deep research use Research Brain before broader literature search.

The response policy is strict:

- If there is no supported or partial internal evidence, do not state a loaded-paper claim as fact.
- If evidence is partial, use cautious language.
- If evidence is external, label it as external.
- If evidence conflicts, present the contradiction instead of inventing consensus.
- If the evidence pack is empty, say that the loaded papers do not provide enough evidence.

The `evidenceVerifierAgent` rewrites or blocks unsupported scientific claims before final output.

## Integration Points

### Chat

The chat agent receives an initial Research Brain evidence pack before the LLM loop. It also has a `research_brain_search` tool and should use it before `literature_search`.

### Deep Research

Each deep research iteration stores `researchBrainEvidence` in conversation state before planning. Planning, reflection, and replies can see this context. The final reply is checked by the evidence verifier, and a memory writer stores low-confidence hypotheses/open questions from the response without marking them as supported facts.

### Library

The Library still supports per-paper grounded Q&A. Each paper page also shows extracted Research Brain claims when a source is registered.

### UI

The `/brain` page lists sources, extraction status, and claims. Library pages can upload new global papers. Deep Research panels can display the evidence pack currently grounding the run.

## API Surface

- `GET /api/research-brain/sources`
- `GET /api/research-brain/sources/:id/claims`
- `POST /api/research-brain/search`
- `POST /api/research-brain/sources/:id/extract`
- `GET /api/research-brain/claims/:id`
- `POST /api/research-brain/sources/upload`

Read endpoints are usable with the existing auth resolver in development and authenticated environments. Mutating endpoints require auth.

## Roadmap

### Phase 1: Evidence Store

- Schema, source registration, claim extraction, search API, verifier, and UI MVP.

### Phase 2: Better Provenance

- Page/section extraction from PDFs.
- DOI/title normalization.
- Duplicate detection by DOI and canonical title.
- Stronger external evidence capture.

### Phase 3: Graph Reasoning

- Entity normalization for genes, diseases, compounds, organisms, methods.
- Contradiction detection between claims.
- Graph visualization and filters.

### Phase 4: Evaluation

- Regression prompts that ensure unsupported claims are rejected.
- Source-grounding scoring.
- Red-team tests for prompt injection inside uploaded papers.
