# BioAgents Bioprospection Roadmap

This roadmap defines the next stages for turning BioAgents into a marine bioprospection agent that can process a large private corpus and answer with strict evidence provenance.

## Product Goal

Build an evidence-first agent for marine bioprospection.

Given a species, genus, region, ecosystem, molecule, or desired activity, the system should identify:

- direct evidence from loaded papers
- indirect evidence from related taxa or similar ecosystems
- candidate compounds and biomolecules
- known bioactivities and assays
- possible applications such as anticancer, anti-inflammatory, antimicrobial, antioxidant, cosmetic, biomaterials, and thermal resistance
- limitations, contradictions, and research gaps
- sources, fragments, DOI links, and quoted evidence for every scientific claim

The core rule is:

> No scientific factual claim should be shown as established unless it is grounded in a stored evidence fragment.

## Current State

Already implemented:

- Research Brain evidence schema: sources, evidence chunks, claims, graph edges.
- Local paper library and per-paper grounded Q&A.
- Incremental ingestion command: `bun run ingest:docs -- --path docs`.
- Ingestion dry-run command: `bun run ingest:docs -- --path docs --dry-run`.
- Large-corpus preparation: file hash, ingestion run tracking, dedupe by title/path/hash.
- Structured bioprospecting fact table.
- Bioprospecting extractor for species, compound, bioactivity, assay, application, quote, source, and fragment.
- Bioprospecting search endpoint.
- Dedicated bioprospecting extraction command: `bun run extract:bioprospecting`.
- Per-source bioprospecting status tracking.
- Batch timeout and retry controls for LLM extraction.
- Structured bioprospecting facts are now included in the Research Brain evidence pack used by the chat agent.
- Answer-time verification treats bioprospecting facts as valid evidence only when they carry source, fragment, status, confidence, and quote/snippet provenance.
- Evidence-pack facts are classified by retrieval relationship: direct species, same genus, genus-level, same family, compound/activity match, ecological analogy, or keyword match.
- Local taxonomy normalization tables now store canonical taxa, aliases, parent relations, and normalized taxon IDs on bioprospecting facts.
- Bioprospecting search now uses normalized taxon IDs before text matching, so same-genus evidence can be found even when compound/activity keywords do not match.
- Structured measurement fields are available for bioprospecting facts, and `bun run normalize:measurements` can backfill obvious `%` and fold-change values.
- Search can infer simple quantitative filters such as `over 500%`, `increase`, and `thermal stress`, and can prioritize explicitly named compounds.

Current test corpus:

- 2 indexed scientific PDFs.
- Extraction test produced 14 structured facts from the coral bleaching metabolomics paper.
- Extraction test produced 6 structured facts from the coral microbiome paper.

Important findings from the test:

- The pipeline works end to end.
- Extraction quality is promising for metabolomics/thermal-stress papers.
- LLM extraction latency is high; some batches took 90-110 seconds.
- Search can now return bioprospecting facts even when no general claims are found.
- Test searches can distinguish direct evidence for `Acropora aspera` from same-genus indirect evidence when the user asks about another `Acropora` species.
- Internal documentation should not live in the corpus folder used for scientific paper ingestion.

## External Review Backlog

An external review highlighted several gaps and feature ideas. Items below are
tracked as future work, not as implemented capabilities.

High-impact priorities:

- Authority-backed taxonomy: integrate WoRMS first, then GBIF/NCBI where useful.
- Structured numerics: continue improving quantitative extraction beyond the
  initial measurement fields and conservative backfill.
- Evidence review UI: expose facts, source links, quotes, confidence, and human
  review actions to non-technical scientific users.

Scaling priorities:

- Reduce LLM extraction latency through pre-filtering, smaller prompts,
  specialized extractors, caching, and worker pools.
- Use cheap NER/regex/entity passes before LLM extraction so only candidate
  chunks are sent to expensive structured extraction.
- Add parallel PDF processing with backpressure and resumable worker queues.
- Add near-duplicate detection for multiple versions of the same paper.

Scientific reliability priorities:

- Add pairwise contradiction detection across facts.
- Add structured uncertainty and statistics.
- Quarantine unsupported or weak facts before they reach answer generation.
- Prefer authority-verified taxon names over LLM-supplied names.

Reef-agent differentiation ideas:

- Coral reef knowledge graph for bleaching events, symbiont clades, disease
  states, restoration events, nursery data, genotypes, and growth rates.
- Environmental data integrations such as sea-surface temperature, bleaching
  alerts, reef monitoring programs, biodiversity occurrences, and local ocean
  models.
- Assisted-evolution evidence tracking: selection trials, parent lineages,
  heat-tolerance assays, and performance comparisons.
- Acoustic-monitoring integration candidates for reef soundscape health, fish
  and invertebrate activity, and longitudinal reef change signals.
- Bleaching-risk module that combines species/location/thermal-response facts
  with environmental time series. This must be labeled as predictive modeling,
  not literature evidence.
- Grey-literature ingestion for marine protected area reports, reef restoration
  programs, NGO reports, tourism surveys, and monitoring reports with lower
  trust tier and explicit provenance.
- Proactive agent features: new-paper monitoring, weekly evidence briefs,
  citation tracking, and alerts for high-relevance reef papers.

## Stage 1 - Corpus Hygiene

Goal: make sure only valid scientific sources enter Research Brain.

Tasks:

- Keep private papers in a dedicated path such as `corpus/papers` or mounted volume `/data/papers`.
- Keep project notes and internal docs outside the ingestion corpus.
- Add ignore rules for files such as `.gitkeep`, project markdown, logs, exports, and temporary files.
- Add corpus source categories:
  - peer-reviewed paper
  - review
  - database export
  - patent
  - preprint
  - internal note
- Add a dry-run command that lists files that would be ingested before processing.
- Add an operator checklist that must pass before a 60GB corpus run starts.

Acceptance criteria:

- A dry run clearly shows only scientific sources.
- No internal project documentation is registered as a paper source.
- Duplicate files are skipped by hash.

## Stage 2 - Production Ingestion

Goal: safely process the future 60GB corpus.

Tasks:

- Run `bun run ingest:docs -- --path <papers-path>` on a VPS with stable network.
- Store ingestion run status in `research_ingestion_runs`.
- Add per-file status reporting:
  - pending
  - parsed
  - embedded
  - source_registered
  - claims_extracted
  - bioprospecting_pending
  - bioprospecting_extracted
  - failed
- Add retry support for failed files.
- Add a way to resume a run from failed/pending files only.
- Add rate limits for embedding and extraction requests.

Acceptance criteria:

- A failed run can be resumed without reprocessing completed papers.
- Ingestion can process papers one at a time without loading the full corpus into memory.
- Operators can see how many files were processed, skipped, or failed.

Future scaling tasks:

- Add worker pool support for parsing and embedding multiple PDFs in parallel.
- Add BullMQ backpressure so API traffic and corpus processing do not compete
  uncontrollably.
- Add near-duplicate detection for multiple PDFs of the same paper using DOI,
  title similarity, hash, and extracted metadata.
- Cache taxonomic lookups and repeated entity resolution.

## Stage 3 - Better Paper Parsing

Goal: improve source fidelity.

Current parser extracts raw PDF text, but does not reliably preserve page-level layout, tables, figure captions, or exact page references.

Tasks:

- Preserve page numbers for every evidence chunk.
- Extract captions separately.
- Extract tables separately where possible.
- Mark chunk type:
  - abstract
  - methods
  - results
  - discussion
  - table
  - figure_caption
  - references
- Avoid extracting claims from references-only chunks unless the task is citation discovery.
- Detect scanned/image-only PDFs and mark them as needing OCR.

Acceptance criteria:

- Every high-value claim has at least source title, DOI if available, fragment index, and page when extractable.
- Table-derived facts are not mixed with narrative text without marking their origin.
- Reference list snippets are not treated as primary findings.

## Stage 4 - Bioprospecting Extraction Quality

Goal: make extracted facts more useful for species/molecule/application search.

Tasks:

- Run structured extraction as a separate workflow after ingestion.
- Improve structured extraction prompt and schema.
- Split extraction into specialized passes:
  - taxonomy/entity extraction
  - compound and molecule extraction
  - bioactivity and assay extraction
  - application/opportunity extraction
  - contradiction/limitation extraction
- Add confidence rules:
  - high: species, compound, activity, assay, and result are directly tied in one local context
  - medium: most fields are direct but one field is implicit or broad
  - low: textual mention only
- Separate biological stress responses from application claims.
- Add explicit relation types:
  - contains_compound
  - shows_bioactivity
  - tested_in_assay
  - associated_with_resistance
  - proposed_application
  - related_taxon_evidence
  - open_question
- Add structured numeric fields:
  - measurement_value
  - measurement_unit
  - measurement_direction
  - measurement_min
  - measurement_max
  - timepoint
  - condition
  - p_value
  - sample_size
  - statistical_test
- Add a conservative backfill for obvious percentages and fold-change values.
- Add pre-filtering before LLM extraction:
  - species/taxon regex
  - compound dictionaries
  - assay keywords
  - bioactivity/application keywords
  - cheap NER where available

Acceptance criteria:

- Extraction can be run in small batches by source status.
- The system does not label a thermal-stress metabolite as an application unless the paper supports that framing.
- The system can answer "what compounds are reported for this species/genus?" from structured facts.
- The system can distinguish direct evidence from hypotheses.
- The system can answer quantitative queries such as "show heat-stress glucose
  increases greater than 500%" when papers contain enough structured data.

## Stage 5 - Verification Layer

Goal: reduce hallucinations by blocking unsupported claims.

Current status:

- The chat agent receives a Research Brain evidence pack before answering.
- The evidence pack now includes both general claims and structured bioprospecting facts.
- The answer verifier blocks answers when the loaded corpus has no evidence, and it can use bioprospecting facts as evidence when they are present.

Tasks:

- Add a claim-by-claim verifier after extraction.
- Store verifier output:
  - supported
  - partial
  - contradicted
  - unsupported
  - unclear
- Require a quote for every supported fact.
- Remove or quarantine unsupported facts.
- Add contradiction detection across papers.
- Add contradiction rules:
  - same species/taxon + same compound + opposite bioactivity direction
  - same assay + result divergence above configured threshold
  - same condition/timepoint with incompatible quantitative result
  - LLM judge for high-risk ambiguous pairs, grounded only in stored quotes
- Harden answer-time verification so final responses may only use facts from the evidence pack, including strict checks for unsupported fields.

Acceptance criteria:

- If no evidence exists, the agent says there is not enough evidence.
- Unsupported generated content is removed before reaching the user.
- Every displayed scientific claim links to source/fragment/quote.

## Stage 6 - Taxonomy And Entity Normalization

Goal: support questions about related species, sister species, and geographic analogies.

Current status:

- Added `research_taxa` and `research_taxon_aliases`.
- Added normalized taxon links to `research_bioprospecting_facts`.
- Added `bun run normalize:taxonomy` with `--dry-run`, `--limit`, and resumable status tracking.
- Current sample corpus normalized `Acropora aspera`, `Acropora`, and `Symbiodinium`.
- Facts without taxonomy fields are marked `skipped` so large backfills do not repeatedly scan them.
- Search test: `Acropora millepora xenotest` retrieves `Acropora aspera` facts through the normalized `Acropora` genus link and labels them as same-genus indirect evidence.
- Quantitative search test: `show glucose increases over 500% under thermal stress` retrieves the glucose fact, while `show all increases over 500% under thermal stress` retrieves all matching measured facts.

Tasks:

- Add normalized entity tables for:
  - species
  - genus
  - family
  - compound
  - activity
  - assay/model
  - geography/ecosystem
- Integrate or import taxonomic references:
  - WoRMS
  - GBIF
  - NCBI Taxonomy
- Add external identifier columns inside `research_taxa.external_ids`:
  - worms_aphia_id
  - gbif_taxon_key
  - ncbi_tax_id
- Store synonyms and accepted names.
- Add authority validation before inserting new taxa when an external source is available.
- Add relation graph:
  - species belongs_to genus
  - genus belongs_to family
  - species related_to species
  - compound has_activity activity
  - species reported_in geography

Acceptance criteria:

- A query for a species can find evidence for its genus and family.
- The answer clearly labels evidence as direct, same-genus, same-family, or ecological analogy.
- Synonyms do not split evidence across duplicate species records.
- Accepted names and synonyms from external authorities can be attached without
  losing local fact provenance.

## Stage 7 - Query Planner For User Questions

Goal: choose the correct evidence retrieval strategy based on the user question.

Current status:

- Research Brain now adds lightweight evidence classification to bioprospecting facts at answer time.
- The classification is conservative and uses only fields already stored in the fact plus the user query.
- This is not a replacement for a real taxonomy graph, but it prevents obvious overclaiming while the corpus is still small.
- Implemented: a lightweight rule-based query planner now labels the question type and attaches an answer strategy, suggested sections, external-literature fallback policy, and cautions to each evidence pack.
- The chat agent and verifier are instructed to follow that query plan before adding broader synthesis.

Question types:

- species exploration: "I have this species in my region; what can we explore?"
- molecule exploration: "Which compounds are reported in these corals?"
- activity search: "Find anticancer or anti-inflammatory precursors in reefs."
- comparison: "Compare this anemone with a related one from China."
- application search: "Could this organism have cosmetic applications?"
- evidence audit: "Show me only directly supported claims."

For each question type, the agent should retrieve:

- direct facts
- nearby taxonomy facts
- ecosystem/geography analogies
- relevant literature search results if local evidence is insufficient
- limitations and missing evidence

Acceptance criteria:

- The user can ask a broad exploratory question and get a structured answer.
- The answer separates direct evidence, indirect evidence, and hypotheses.
- The answer does not blur "reported in this species" with "reported in a related species."
- Current implementation covers this as a conservative first pass; the next upgrade is to make retrieval itself more adaptive per question type.

## Stage 8 - UI For Evidence Review

Goal: make evidence inspectable.

Current status:

- Implemented: `/brain` now has an Evidence tab for searching the same Research Brain evidence pack used by the chat agent.
- The UI shows the query planner intent, suggested answer sections, cautions, direct/indirect/hypothesis counts, evidence cards, measurements, source title, DOI link, internal fragment link, and quote/snippet when available.
- Implemented filters cover broad query text, minimum measurement value, measurement unit, measurement direction, and condition.
- The Sources tab still supports source inspection, claims, upload, and re-extraction.
- Implemented: human review status can be stored per fact as `verified`, `needs_review`, `incorrect`, or `quarantined`.
- Implemented: verified facts are prioritized in search results, while incorrect and quarantined facts are excluded from normal evidence retrieval.
- Implemented: evidence review filters now include active/all review states, specific review status, and evidence strength.
- Implemented: reviewer notes can be saved per fact and are included in the evidence pack.
- Implemented: reviewers can edit extracted entity fields such as species, genus, family, compound, bioactivity, application, assay/model, geography, ecosystem, and condition. Taxonomy-related edits mark the fact for taxonomy re-normalization.
- Implemented: the latest entity correction is visible in the evidence card and included in the evidence pack prompt.
- Implemented: evidence review filters include source trust tier and individual source selection.
- Implemented: visible facts can be selected and bulk-marked as verified, needs review, incorrect, or quarantined with an optional shared note.
- Pending: full reviewer history UI and richer normalized-entity pickers tied to authority records.

Tasks:

- Add a Research Brain view for bioprospecting facts.
- Filters:
  - species
  - genus
  - compound
  - bioactivity
  - application
  - source
  - confidence
  - evidence status
- Show evidence cards:
  - fact summary
  - source title
  - DOI
  - fragment link
  - quote
  - confidence/status
- Add "mark as wrong", "needs review", and "verified by human" actions.
- Add bulk filters for:
  - direct vs indirect evidence
  - normalized taxon
  - source trust tier
  - quantitative range once structured numerics exist
- Add reviewer workflow:
  - confirm fact
  - edit normalized entity
  - quarantine fact
  - request re-extraction
  - attach note

Acceptance criteria:

- A human reviewer can inspect and correct extracted facts.
- The agent can prefer human-verified facts.
- Bad extractions can be quarantined.

## Stage 9 - Coral Reef Knowledge Graph

Goal: make BioAgents useful as a reef-specialized scientific assistant, not only
a generic marine bioprospecting tool.

Graph domains:

- bleaching events:
  - year/date
  - reef/location
  - severity
  - species affected
  - reported thermal conditions
- symbionts:
  - Symbiodiniaceae clade/type
  - host association
  - thermal tolerance notes
- disease states:
  - white syndrome
  - black band disease
  - white plague
  - other locally reported disease labels
- restoration:
  - outplanting
  - larval propagation
  - assisted evolution
  - nursery source
  - genotype/lineage when available
- nursery and field monitoring:
  - fragment ID
  - parent colony
  - growth rate
  - survival
  - bleaching/disease outcome

Acceptance criteria:

- A user can ask for reef context around a species or location.
- The answer separates literature-derived facts, monitoring data, and predictive
  or management hypotheses.
- Restoration and monitoring records are clearly labeled by trust tier and data
  source.

## Stage 10 - Environmental And Monitoring Integrations

Goal: connect paper evidence to environmental and field context.

Candidate integrations to evaluate:

- sea-surface temperature and bleaching alert feeds
- biodiversity occurrence data
- reef monitoring programs
- regional oceanographic data portals
- local biogeochemical models
- reef soundscape/acoustic-monitoring systems

Tasks:

- Create external observation tables with source, timestamp, location, method,
  uncertainty, and trust tier.
- Add geospatial normalization for reef names, coordinates, and regions.
- Link facts to locations only when evidence explicitly supports the location.
- Build a bleaching-risk prototype that combines species/location facts with
  environmental time series.

Acceptance criteria:

- Environmental observations are never presented as paper evidence.
- Predictive outputs are labeled as model-derived and uncertain.
- Users can inspect source, timestamp, location, and method for every external
  observation.

## Stage 11 - Grey Literature And Trust Tiers

Goal: include conservation-relevant sources without flattening evidence quality.

Source types:

- peer-reviewed papers
- preprints
- patents
- management reports
- NGO restoration reports
- MPA monitoring reports
- tourism or citizen-science surveys
- internal field notes

Tasks:

- Extend ingestion metadata to classify grey literature.
- Add extraction prompts tuned for reports instead of papers.
- Require explicit trust-tier labels in answers.
- Add reviewer approval before low-trust evidence can support strong claims.

Acceptance criteria:

- Grey literature can be searched and cited.
- The answer clearly distinguishes peer-reviewed papers from reports and field
  notes.
- Low-trust material is treated as lead generation unless human-verified.

## Stage 12 - Proactive Reef Agent

Goal: move from passive Q&A to monitored scientific intelligence.

Tasks:

- Monitor new papers and reports from configured sources.
- Generate weekly evidence briefs.
- Alert on new evidence for configured taxa, reefs, compounds, or applications.
- Track citations to selected papers or projects.
- Queue new sources for ingestion, extraction, taxonomy normalization, and
  evidence review.

Acceptance criteria:

- Alerts include source, reason for relevance, and evidence status.
- No alert claims scientific novelty unless grounded in retrieved evidence.
- Users can configure watchlists by species, genus, reef, compound, activity,
  and geography.

## Stage 13 - VPS Deployment Plan

Goal: deploy safely when the corpus is ready.

Minimum VPS needs depend on corpus size and embedding throughput, but for 60GB:

- enough disk for source PDFs, parsed text, database growth, and backups
- stable network for embeddings/LLM extraction
- long-running workers
- Redis enabled for background processing
- logs and restart policy

Deployment tasks:

- Move corpus to mounted storage.
- Run database migrations.
- Start API and worker containers.
- Run normal ingestion first.
- Run bioprospecting extraction separately.
- Monitor ingestion runs and failed files.

Acceptance criteria:

- Ingestion survives restarts.
- Worker can process extraction jobs in the background.
- API remains usable while ingestion/extraction runs.

## Stage 14 - Evaluation

Goal: measure reliability.

Create test sets:

- species-to-compound questions
- compound-to-activity questions
- same-genus comparison questions
- anticancer/anti-inflammatory search questions
- "no evidence" questions
- contradiction questions

Metrics:

- citation coverage
- unsupported claim rate
- direct vs indirect evidence labeling accuracy
- extraction precision
- extraction recall on manually reviewed papers
- answer abstention quality

Acceptance criteria:

- No answer presents unsupported claims as fact.
- Every important answer has evidence links.
- The system abstains when evidence is missing.
