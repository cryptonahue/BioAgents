# Research Brain Ingestion

This guide prepares the system for large private paper corpora.

## Goal

Research Brain stores papers as:

- `documents`: searchable chunks with embeddings.
- `research_sources`: citable source records with DOI, file path, hash, size, and extraction status.
- `research_evidence_chunks`: source-grounded evidence fragments.
- `research_claims`: general scientific claims linked to evidence fragments.
- `research_bioprospecting_facts`: structured marine bioprospecting facts such as species, compound, bioactivity, assay, application, and quoted evidence.

The ingestion command is resumable by filename, file path, and SHA-256 content hash.

## Before Loading A Large Corpus

Run migrations:

```bash
bun run migrate
```

Copy or mount papers into the configured docs folder:

```bash
KNOWLEDGE_DOCS_PATH=docs
```

Important: keep internal project documentation outside the ingestion corpus. If
`KNOWLEDGE_DOCS_PATH=docs`, then `docs/` should contain only scientific sources
that are meant to become evidence. Put project notes and implementation docs in
`documentation/docs/` instead.

By default, ingestion ignores `research-brain.md` because it is an internal
project note, not a scientific source. You can set additional ignore patterns:

```bash
KNOWLEDGE_INGEST_IGNORE=research-brain.md,README.md,tmp/
```

Supported corpus file types:

- PDF
- Markdown
- DOCX
- TXT

## Standard Ingestion

Preview what would happen before processing:

```bash
bun run ingest:docs -- --path docs --dry-run
```

Run ingestion:

```bash
bun run ingest:docs -- --path docs
```

This will:

- walk the folder recursively
- skip already indexed files
- parse one document at a time
- chunk and embed the document
- register the paper in Research Brain
- extract general scientific claims
- record progress in `research_ingestion_runs`

## Bioprospecting Extraction

For large corpora, run normal ingestion first, then run structured
bioprospecting extraction as a separate step:

```bash
bun run extract:bioprospecting -- --status pending --limit 10
```

Preview selected sources without extracting:

```bash
bun run extract:bioprospecting -- --status pending --limit 10 --dry-run
```

Extract one source:

```bash
bun run extract:bioprospecting -- --source-id <research_source_id>
```

Useful controls:

```bash
bun run extract:bioprospecting -- --status pending --limit 5 --max-chunks 80 --batch-chunks 8 --timeout-ms 120000 --retries 1
```

You can still run extraction during ingestion for small tests:

```bash
bun run ingest:docs -- --path docs --bioprospecting
```

For very large corpora, prefer the separate `extract:bioprospecting` command so
the API and ingestion pipeline stay responsive.

## Taxonomy Normalization

After bioprospecting extraction, normalize taxonomy links:

```bash
bun run normalize:taxonomy -- --limit 500 --dry-run
bun run normalize:taxonomy -- --limit 500
```

When network access is available, attach WoRMS identifiers and accepted-name
metadata:

```bash
bun run normalize:taxonomy -- --limit 500 --worms
```

This creates or reuses local taxa in `research_taxa`, stores aliases in
`research_taxon_aliases`, and writes normalized species/genus/family IDs back to
`research_bioprospecting_facts`.

WoRMS enrichment is conservative. It only attaches external IDs when the service
returns a clear name/rank match, and it keeps local fact provenance intact.

The command is resumable. Facts with no taxonomy fields are marked `skipped`,
and normalized facts are marked `normalized`, so later runs only process
pending records.

## Measurement Backfill

Structured extraction now supports quantitative measurement fields. For existing
facts or simple obvious cases, run a conservative measurement backfill:

```bash
bun run normalize:measurements -- --limit 500 --dry-run
bun run normalize:measurements -- --limit 500
```

This only fills measurements when the text has obvious values such as `%` or
`fold-change`. Ambiguous numeric statements are left untouched for future LLM or
human review.

Useful settings:

```bash
BIOPROSPECTING_MAX_CHUNKS=80
BIOPROSPECTING_BATCH_CHUNKS=8
BIOPROSPECTING_BATCH_TIMEOUT_MS=120000
BIOPROSPECTING_BATCH_RETRIES=1
KNOWLEDGE_INGEST_BATCH_SIZE=50
```

## Forcing Reprocessing

```bash
bun run ingest:docs -- --path docs --force
```

Use this only when you intentionally want to reinsert documents. Normal runs skip known files.

Dry-run with force shows which files would process if dedupe were ignored:

```bash
bun run ingest:docs -- --path docs --dry-run --force
```

## Evidence Standard

The agent should only make strong scientific claims when Research Brain returns
supported or partial evidence. Research Brain now includes structured
bioprospecting facts in the same evidence pack used by the chat agent and
answer-time verifier.

Structured bioprospecting facts should include:

- source
- DOI when available
- evidence fragment
- quote
- evidence type
- confidence
- status: supported, partial, contradicted, hypothesis, or open question

If the evidence pack has no general claims and no bioprospecting facts, the chat
agent should answer that the loaded papers do not provide enough evidence.
