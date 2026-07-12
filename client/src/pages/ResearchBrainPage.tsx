import { route } from "preact-router";
import { useState } from "preact/hooks";
import { Icon } from "../components/icons";
import { BUTTON_ICON_CLASS } from "../components/ui/Button";
import { ExternalLink } from "../utils/externalLinks";
import { TabList, TabPanel, Tabs, type TabItem } from "../components/ui/Tabs";
import { ProvenanceBadge } from "../components/ProvenanceBadge";
import { CompoundAuthorityBadge } from "../components/CompoundAuthorityBadge";
import { openProvenanceLightbox } from "../utils/provenanceTrigger";
import {
  reextractResearchBrainSource,
  ResearchBrainBioprospectingFact,
  ResearchBrainFactEntityPatch,
  ResearchBrainReviewStatus,
  updateBioprospectingFactEntities,
  updateBioprospectingFactReview,
  updateBioprospectingFactsReviewBulk,
  uploadResearchBrainSource,
  useResearchBrainClaims,
  useResearchBrainEvidenceSearch,
  useResearchBrainSources,
} from "../hooks/useResearchBrain";

interface Props {
  path?: string;
  coralGptMode?: boolean;
}

type BrainTab = "evidence" | "sources";

/** Namespaces the generated `id`s that wire each tab to its panel. */
const BRAIN_TABS_ID = "brain";

const BRAIN_TABS: TabItem<BrainTab>[] = [
  {
    value: "evidence",
    label: (
      <>
        <Icon name="search" size={15} />
        <span>Evidence</span>
      </>
    ),
  },
  {
    value: "sources",
    label: (
      <>
        <Icon name="folder" size={15} />
        <span>Sources</span>
      </>
    ),
  },
];

const ENTITY_FIELDS: Array<{
  key: keyof ResearchBrainFactEntityPatch;
  label: string;
}> = [
  { key: "species", label: "Species" },
  { key: "genus", label: "Genus" },
  { key: "family", label: "Family" },
  { key: "organismGroup", label: "Group" },
  { key: "geography", label: "Geography" },
  { key: "ecosystem", label: "Ecosystem" },
  { key: "organismPart", label: "Part" },
  { key: "compound", label: "Compound" },
  { key: "compoundClass", label: "Class" },
  { key: "moleculeType", label: "Molecule" },
  { key: "bioactivity", label: "Bioactivity" },
  { key: "applicationArea", label: "Application" },
  { key: "assayModel", label: "Assay/model" },
  { key: "condition", label: "Condition" },
];

function statusLabel(status: string | null | undefined) {
  if (!status) return "—";
  return status.replace(/_/g, " ");
}

function formatMeasurement(fact: ResearchBrainBioprospectingFact) {
  const parts = [
    fact.measurementValue != null
      ? `${fact.measurementValue}${fact.measurementUnit ? ` ${fact.measurementUnit}` : ""}`
      : null,
    fact.measurementDirection,
    fact.condition,
    fact.timepoint,
    fact.pValue != null ? `p=${fact.pValue}` : null,
    fact.sampleSize != null ? `n=${fact.sampleSize}` : null,
  ].filter(Boolean);

  return parts.length ? parts.join(" · ") : "";
}

function factTitle(fact: ResearchBrainBioprospectingFact) {
  return (
    fact.species ||
    fact.genus ||
    fact.family ||
    fact.organismGroup ||
    "Bioprospecting fact"
  );
}

function strengthLabel(strength: string) {
  if (strength === "direct") return "direct";
  if (strength === "indirect") return "indirect";
  if (strength === "hypothesis") return "hypothesis";
  return "review";
}

function reviewLabel(status: string) {
  if (status === "verified") return "verified";
  if (status === "needs_review") return "needs review";
  if (status === "incorrect") return "incorrect";
  if (status === "quarantined") return "quarantined";
  return "unreviewed";
}

/**
 * The human-review state is a SEMANTIC badge color. Basecoat ships only
 * `destructive`, so the four states map onto the project `data-tone` family —
 * see `badges.css`.
 */
function reviewTone(status?: string): "success" | "warning" | "danger" | "neutral" {
  if (status === "verified") return "success";
  if (status === "needs_review") return "warning";
  if (status === "incorrect" || status === "quarantined") return "danger";
  return "neutral";
}

function correctionFieldLabel(field: string) {
  const match = ENTITY_FIELDS.find((entry) => entry.key === field);
  return match?.label || statusLabel(field);
}

export function ResearchBrainPage({ coralGptMode = false }: Props) {
  const { sources, isLoading, error, refetch } = useResearchBrainSources();
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<BrainTab>("evidence");
  const [query, setQuery] = useState("Acropora thermal stress");
  const [measurementMin, setMeasurementMin] = useState("");
  const [measurementUnit, setMeasurementUnit] = useState("");
  const [measurementDirection, setMeasurementDirection] = useState("");
  const [condition, setCondition] = useState("");
  const [reviewStatusFilter, setReviewStatusFilter] = useState("");
  const [evidenceStrengthFilter, setEvidenceStrengthFilter] = useState("");
  const [sourceIdFilter, setSourceIdFilter] = useState("");
  const [sourceTrustTierFilter, setSourceTrustTierFilter] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [bulkReviewNote, setBulkReviewNote] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [reviewingFactId, setReviewingFactId] = useState<string | null>(null);
  const [isBulkReviewing, setIsBulkReviewing] = useState(false);
  const [updatingEntityFactId, setUpdatingEntityFactId] = useState<
    string | null
  >(null);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [entityEdits, setEntityEdits] = useState<
    Record<string, ResearchBrainFactEntityPatch>
  >({});
  const [selectedFactIds, setSelectedFactIds] = useState<Set<string>>(
    () => new Set(),
  );
  const selectedSource =
    sources.find((s) => s.id === selectedSourceId) || sources[0];
  const {
    claims,
    isLoading: claimsLoading,
    refetch: refetchClaims,
  } = useResearchBrainClaims(selectedSource?.id);
  const {
    evidencePack,
    isLoading: evidenceLoading,
    error: evidenceError,
    search,
  } = useResearchBrainEvidenceSearch("Acropora thermal stress");

  const facts = evidencePack?.bioprospectingFacts || [];
  const directCount = facts.filter(
    (fact) => fact.evidenceStrength === "direct",
  ).length;
  const indirectCount = facts.filter(
    (fact) => fact.evidenceStrength === "indirect",
  ).length;
  const hypothesisCount = facts.filter(
    (fact) => fact.evidenceStrength === "hypothesis",
  ).length;
  const selectedVisibleCount = facts.filter((fact) =>
    selectedFactIds.has(fact.id),
  ).length;
  const allVisibleSelected =
    facts.length > 0 && selectedVisibleCount === facts.length;

  const handleUpload = async (file?: File) => {
    if (!file) return;
    setIsUploading(true);
    setUploadError("");
    try {
      const result = await uploadResearchBrainSource(file);
      await refetch();
      setSelectedSourceId(result.sourceId);
      setActiveTab("sources");
    } catch (err: any) {
      setUploadError(err?.message || "Could not load the paper");
    } finally {
      setIsUploading(false);
    }
  };

  const handleExtract = async () => {
    if (!selectedSource?.id) return;
    await reextractResearchBrainSource(selectedSource.id);
    await Promise.all([refetch(), refetchClaims()]);
  };

  const handleEvidenceSearch = async (event?: Event) => {
    event?.preventDefault();
    await search({
      query,
      limit: 16,
      measurementMin: measurementMin ? Number(measurementMin) : undefined,
      measurementUnit: measurementUnit || undefined,
      measurementDirection: measurementDirection
        ? (measurementDirection as any)
        : undefined,
      condition: condition || undefined,
      reviewStatus: reviewStatusFilter
        ? (reviewStatusFilter as ResearchBrainReviewStatus | "all")
        : undefined,
      evidenceStrength: evidenceStrengthFilter
        ? (evidenceStrengthFilter as any)
        : undefined,
      sourceId: sourceIdFilter || undefined,
      sourceTrustTier: sourceTrustTierFilter
        ? (sourceTrustTierFilter as "internal" | "external" | "all")
        : undefined,
    });
  };

  const toggleFactSelection = (factId: string) => {
    setSelectedFactIds((current) => {
      const next = new Set(current);
      if (next.has(factId)) next.delete(factId);
      else next.add(factId);
      return next;
    });
  };

  const toggleVisibleSelection = () => {
    setSelectedFactIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const fact of facts) next.delete(fact.id);
      } else {
        for (const fact of facts) next.add(fact.id);
      }
      return next;
    });
  };

  const handleBulkReview = async (reviewStatus: ResearchBrainReviewStatus) => {
    const factIds = facts
      .filter((fact) => selectedFactIds.has(fact.id))
      .map((fact) => fact.id);
    if (factIds.length === 0) return;
    setIsBulkReviewing(true);
    setReviewError("");
    try {
      await updateBioprospectingFactsReviewBulk(
        factIds,
        reviewStatus,
        bulkReviewNote,
      );
      setSelectedFactIds((current) => {
        const next = new Set(current);
        for (const factId of factIds) next.delete(factId);
        return next;
      });
      await handleEvidenceSearch();
    } catch (err: any) {
      setReviewError(err?.message || "Could not update in bulk");
    } finally {
      setIsBulkReviewing(false);
    }
  };

  const handleReviewFact = async (
    fact: ResearchBrainBioprospectingFact,
    reviewStatus: ResearchBrainReviewStatus,
  ) => {
    setReviewingFactId(fact.id);
    setReviewError("");
    try {
      await updateBioprospectingFactReview(
        fact.id,
        reviewStatus,
        reviewNotes[fact.id] ?? fact.reviewNote ?? null,
      );
      await handleEvidenceSearch();
    } catch (err: any) {
      setReviewError(err?.message || "Could not update the review");
    } finally {
      setReviewingFactId(null);
    }
  };

  const getEntityFieldValue = (
    fact: ResearchBrainBioprospectingFact,
    key: keyof ResearchBrainFactEntityPatch,
  ) => {
    const edited = entityEdits[fact.id]?.[key];
    if (edited != null) return String(edited);
    const value = fact[key as keyof ResearchBrainBioprospectingFact];
    return typeof value === "string" ? value : "";
  };

  const setEntityFieldValue = (
    factId: string,
    key: keyof ResearchBrainFactEntityPatch,
    value: string,
  ) => {
    setEntityEdits((current) => ({
      ...current,
      [factId]: {
        ...(current[factId] || {}),
        [key]: value,
      },
    }));
  };

  const handleSaveEntities = async (fact: ResearchBrainBioprospectingFact) => {
    const edited = entityEdits[fact.id] || {};
    const patch = ENTITY_FIELDS.reduce<ResearchBrainFactEntityPatch>(
      (next, field) => {
        const value = getEntityFieldValue(fact, field.key).trim();
        next[field.key] = value || null;
        return next;
      },
      {},
    );

    setUpdatingEntityFactId(fact.id);
    setReviewError("");
    try {
      await updateBioprospectingFactEntities(fact.id, {
        ...patch,
        ...edited,
      });
      setEntityEdits((current) => {
        const next = { ...current };
        delete next[fact.id];
        return next;
      });
      await handleEvidenceSearch();
    } catch (err: any) {
      setReviewError(err?.message || "Could not save entities");
    } finally {
      setUpdatingEntityFactId(null);
    }
  };

  return (
    <div className="library-page">
      <main className="library-main brain-main">
        <div className="library-heading brain-heading">
          <div>
            <h1>Research Brain</h1>
            <p>
              Structured evidence extracted from uploaded papers. The
              agent uses it as the first source of truth.
            </p>
          </div>
          <label className="btn library-link-btn brain-upload-btn" data-variant="outline">
            <Icon name="upload" size={16} className={BUTTON_ICON_CLASS} />
            <span>{isUploading ? "Loading…" : "Upload paper"}</span>
            <input
              type="file"
              accept=".pdf,.md,.txt,.docx"
              disabled={isUploading}
              onChange={(e) =>
                handleUpload((e.target as HTMLInputElement).files?.[0])
              }
            />
          </label>
        </div>

        {uploadError && (
          <div className="alert" data-tone="danger" role="alert">
            <strong>{uploadError}</strong>
          </div>
        )}
        {reviewError && (
          <div className="alert" data-tone="danger" role="alert">
            <strong>{reviewError}</strong>
          </div>
        )}

        <Tabs className="brain-tabs">
          <TabList
            idPrefix={BRAIN_TABS_ID}
            label="Research Brain"
            tabs={BRAIN_TABS}
            value={activeTab}
            // See AdminPage: the arrow keeps `T` pinned to `BrainTab`.
            onChange={(value) => setActiveTab(value)}
          />

        {activeTab === "evidence" && (
          <TabPanel idPrefix={BRAIN_TABS_ID} value="evidence">
          <section className="brain-evidence-workspace">
            <form
              className="card brain-evidence-search"
              onSubmit={handleEvidenceSearch}
            >
              <div className="input-group brain-search-main">
                <Icon name="search" size={17} />
                <input
                  value={query}
                  onInput={(e) =>
                    setQuery((e.target as HTMLInputElement).value)
                  }
                  placeholder="Search species, compound, bioactivity, or condition"
                />
                <button
                  className="btn brain-search-btn"
                  data-variant="primary"
                  type="submit"
                  aria-label="Search evidence"
                >
                  <Icon name="chevronRight" size={18} className={BUTTON_ICON_CLASS} />
                </button>
              </div>
              <div className="brain-filter-row">
                <label>
                  Minimum value
                  <input
                    class="input"
                    type="number"
                    value={measurementMin}
                    onInput={(e) =>
                      setMeasurementMin((e.target as HTMLInputElement).value)
                    }
                    placeholder="500"
                  />
                </label>
                <label>
                  Unit
                  <select
                    class="select"
                    value={measurementUnit}
                    onChange={(e) =>
                      setMeasurementUnit((e.target as HTMLSelectElement).value)
                    }
                  >
                    <option value="">All</option>
                    <option value="%">%</option>
                    <option value="fold-change">fold-change</option>
                  </select>
                </label>
                <label>
                  Direction
                  <select
                    class="select"
                    value={measurementDirection}
                    onChange={(e) =>
                      setMeasurementDirection(
                        (e.target as HTMLSelectElement).value,
                      )
                    }
                  >
                    <option value="">All</option>
                    <option value="increase">Increase</option>
                    <option value="decrease">Decrease</option>
                    <option value="no_change">No change</option>
                    <option value="mixed">Mixed</option>
                  </select>
                </label>
                <label>
                  Condition
                  <input
                    class="input"
                    value={condition}
                    onInput={(e) =>
                      setCondition((e.target as HTMLInputElement).value)
                    }
                    placeholder="thermal stress"
                  />
                </label>
                <label>
                  Review
                  <select
                    class="select"
                    value={reviewStatusFilter}
                    onChange={(e) =>
                      setReviewStatusFilter(
                        (e.target as HTMLSelectElement).value,
                      )
                    }
                  >
                    <option value="">Active</option>
                    <option value="all">All</option>
                    <option value="unreviewed">Unreviewed</option>
                    <option value="verified">Verified</option>
                    <option value="needs_review">Needs review</option>
                    <option value="incorrect">Incorrect</option>
                    <option value="quarantined">Quarantined</option>
                  </select>
                </label>
                <label>
                  Strength
                  <select
                    class="select"
                    value={evidenceStrengthFilter}
                    onChange={(e) =>
                      setEvidenceStrengthFilter(
                        (e.target as HTMLSelectElement).value,
                      )
                    }
                  >
                    <option value="">All</option>
                    <option value="direct">Direct</option>
                    <option value="indirect">Indirect</option>
                    <option value="hypothesis">Hypothesis</option>
                    <option value="unknown">Review</option>
                  </select>
                </label>
                <label>
                  Trust tier
                  <select
                    class="select"
                    value={sourceTrustTierFilter}
                    onChange={(e) =>
                      setSourceTrustTierFilter(
                        (e.target as HTMLSelectElement).value,
                      )
                    }
                  >
                    <option value="">All</option>
                    <option value="internal">Internal</option>
                    <option value="external">External</option>
                  </select>
                </label>
                <label>
                  Source
                  <select
                    class="select"
                    value={sourceIdFilter}
                    onChange={(e) =>
                      setSourceIdFilter((e.target as HTMLSelectElement).value)
                    }
                  >
                    <option value="">All</option>
                    {sources.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </form>

            {evidenceLoading && (
              <div className="library-state">Searching evidence…</div>
            )}
            {evidenceError && !evidenceLoading && (
              <div className="alert" data-tone="danger" role="alert">
                <strong>{evidenceError}</strong>
              </div>
            )}

            {evidencePack && !evidenceLoading && (
              <>
                <div className="card brain-plan-panel">
                  <div>
                    <span className="brain-plan-kicker">Query planner</span>
                    <h2>{evidencePack.queryPlan.intentLabel}</h2>
                    <p>{evidencePack.queryPlan.strategy}</p>
                  </div>
                  <div className="brain-plan-stats">
                    <span className="badge" data-tone="brand">
                      {facts.length} facts
                    </span>
                    <span className="badge" data-tone="brand">
                      {directCount} direct
                    </span>
                    <span className="badge" data-tone="brand">
                      {indirectCount} indirect
                    </span>
                    <span className="badge" data-tone="brand">
                      {hypothesisCount} hypothesis
                    </span>
                  </div>
                </div>

                {evidencePack.queryPlan.cautions.length > 0 && (
                  <div className="alert brain-caution" data-tone="warning">
                    <Icon name="alertTriangle" size={16} />
                    <strong>{evidencePack.queryPlan.cautions.join(" ")}</strong>
                  </div>
                )}

                <div className="card brain-bulk-toolbar">
                  <label className="brain-select-all">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleVisibleSelection}
                    />
                    <span>
                      {selectedVisibleCount > 0
                        ? `${selectedVisibleCount} selected`
                        : "Select visible"}
                    </span>
                  </label>
                  <input
                    className="input brain-bulk-note"
                    value={bulkReviewNote}
                    onInput={(e) =>
                      setBulkReviewNote((e.target as HTMLInputElement).value)
                    }
                    placeholder="Optional bulk note"
                  />
                  <div className="brain-bulk-actions">
                    <button
                      className="btn"
                      data-variant="outline"
                      data-size="sm"
                      disabled={selectedVisibleCount === 0 || isBulkReviewing}
                      onClick={() => handleBulkReview("verified")}
                    >
                      Verify
                    </button>
                    <button
                      className="btn"
                      data-variant="outline"
                      data-size="sm"
                      disabled={selectedVisibleCount === 0 || isBulkReviewing}
                      onClick={() => handleBulkReview("needs_review")}
                    >
                      Review
                    </button>
                    <button
                      className="btn"
                      data-variant="outline"
                      data-size="sm"
                      disabled={selectedVisibleCount === 0 || isBulkReviewing}
                      onClick={() => handleBulkReview("incorrect")}
                    >
                      Incorrect
                    </button>
                    <button
                      className="btn"
                      data-variant="outline"
                      data-size="sm"
                      disabled={selectedVisibleCount === 0 || isBulkReviewing}
                      onClick={() => handleBulkReview("quarantined")}
                    >
                      Quarantine
                    </button>
                  </div>
                </div>

                <div className="brain-evidence-grid">
                  <section className="brain-facts-list">
                    {facts.length === 0 && (
                      <div className="empty">
                        <header>
                          <p>No bioprospecting facts for this search.</p>
                        </header>
                      </div>
                    )}
                    {facts.map((fact) => (
                      <article
                        key={fact.id}
                        className={`card brain-fact-card strength-${fact.evidenceStrength}`}
                      >
                        <label className="brain-fact-select">
                          <input
                            type="checkbox"
                            checked={selectedFactIds.has(fact.id)}
                            onChange={() => toggleFactSelection(fact.id)}
                          />
                          <span>Select</span>
                        </label>
                        <div className="brain-fact-header">
                          <div>
                            <span className="brain-fact-kicker">
                              {strengthLabel(fact.evidenceStrength)} ·{" "}
                              {statusLabel(fact.matchType)}
                            </span>
                            <h3>{factTitle(fact)}</h3>
                          </div>
                          <span className="badge brain-strength-badge" data-tone="neutral">
                            {fact.confidence}
                          </span>
                        </div>

                        <div
                          className="badge brain-review-status"
                          data-tone={reviewTone(fact.reviewStatus)}
                        >
                          <Icon name="check" size={14} />
                          <span>
                            Review: {reviewLabel(fact.reviewStatus)}
                            {fact.reviewedAt
                              ? ` · ${new Date(
                                  fact.reviewedAt,
                                ).toLocaleDateString()}`
                              : ""}
                          </span>
                        </div>
                        {fact.reviewNote && (
                          <div className="brain-review-note">
                            <strong>Note:</strong> {fact.reviewNote}
                          </div>
                        )}
                        {fact.lastEntityCorrection &&
                          Object.keys(fact.lastEntityCorrection.fields || {})
                            .length > 0 && (
                            <div className="brain-correction-history">
                              <div className="brain-correction-title">
                                Last correction
                                {fact.lastEntityCorrection.correctedAt
                                  ? ` · ${new Date(
                                      fact.lastEntityCorrection.correctedAt,
                                    ).toLocaleDateString()}`
                                  : ""}
                              </div>
                              {Object.entries(fact.lastEntityCorrection.fields)
                                .slice(0, 4)
                                .map(([field, change]) => (
                                  <div
                                    className="brain-correction-row"
                                    key={field}
                                  >
                                    <span>{correctionFieldLabel(field)}</span>
                                    <code>{change.before || "empty"}</code>
                                    <Icon name="chevronRight" size={14} />
                                    <code>{change.after || "empty"}</code>
                                  </div>
                                ))}
                            </div>
                          )}

                        <div className="brain-fact-fields">
                          {/*
                            PR #3 of `bioprospecting-compound-authority`
                            — render the CompoundAuthorityBadge next to
                            the raw `compound` value when canonical
                            resolution has produced a different
                            display name (or the resolution is
                            pending / failed). The component is
                            responsible for hiding itself when the
                            value is an extract (`skipped`) or when
                            the canonical name matches the raw text
                            (no diff to show). When the badge hides
                            itself, we still render the raw text so
                            the user sees the original compound name.
                          */}
                          {fact.compound && (
                            <>
                              {fact.compoundAuthorityStatus ? (
                                <CompoundAuthorityBadge
                                  compound={fact.compound}
                                  compoundCanonicalId={
                                    fact.compoundCanonicalId ?? null
                                  }
                                  compoundAuthorityStatus={
                                    fact.compoundAuthorityStatus
                                  }
                                  compoundAuthorityError={
                                    fact.compoundAuthorityError ?? null
                                  }
                                  canonicalName={
                                    fact.compoundCanonicalName ?? null
                                  }
                                  inchiKey={fact.compoundInchiKey ?? null}
                                  pubchemCid={
                                    fact.compoundPubchemCid ?? null
                                  }
                                  variant="card"
                                />
                              ) : (
                                <span className="badge" data-tone="brand">
                                  {fact.compound}
                                </span>
                              )}
                            </>
                          )}
                          {fact.compoundClass && (
                            <span className="badge" data-tone="brand">
                              {fact.compoundClass}
                            </span>
                          )}
                          {fact.bioactivity && (
                            <span className="badge" data-tone="brand">
                              {fact.bioactivity}
                            </span>
                          )}
                          {fact.applicationArea && (
                            <span className="badge" data-tone="brand">
                              {fact.applicationArea}
                            </span>
                          )}
                          {fact.geography && (
                            <span className="badge" data-tone="brand">
                              {fact.geography}
                            </span>
                          )}
                          {fact.ecosystem && (
                            <span className="badge" data-tone="brand">
                              {fact.ecosystem}
                            </span>
                          )}
                        </div>

                        {fact.resultSummary && <p>{fact.resultSummary}</p>}
                        {formatMeasurement(fact) && (
                          <div className="brain-measurement">
                            <Icon name="barChart" size={15} />
                            <span>{formatMeasurement(fact)}</span>
                          </div>
                        )}

                        <div className="brain-fact-source">
                          <span>{fact.sourceTitle || "Internal source"}</span>
                          {/*
                            PR #3 — provenance affordance on fact
                            cards. The badge is the keyboard-
                            focusable entry point to the lightbox;
                            its visible label changes from
                            "provenance: text-only" to "view
                            source" so the user knows it's an
                            action, not a status. The lightbox
                            header re-asserts the text-only status
                            when applicable.
                          */}
                          <ProvenanceBadge
                            kind="text-only"
                            variant="card"
                            label="view source"
                            ariaLabel={`View source PDF for fact ${fact.id}`}
                            onActivate={(event) => {
                              // Anchor the badge to the fact id
                              // so the ProvenanceProvider can
                              // open the lightbox for the right
                              // fact. The badge does not know
                              // about a per-fact sourceId; the
                              // lightbox resolves it from the
                              // provenance payload.
                              const target =
                                (event?.currentTarget as HTMLElement | undefined) ??
                                null;
                              openProvenanceLightbox(
                                fact.id,
                                fact.evidenceTableId ?? null,
                                target,
                              );
                            }}
                          />
                          {fact.doiUrl && (
                            <ExternalLink
                              href={fact.doiUrl}
                              label={`DOI for this fact`}
                            >
                              DOI
                            </ExternalLink>
                          )}
                          {fact.evidenceUrl && (
                            <button
                              onClick={() => route(fact.evidenceUrl || "")}
                            >
                              fragment {fact.chunkIndex ?? ""}
                            </button>
                          )}
                        </div>

                        {fact.snippet && (
                          <blockquote>{fact.snippet}</blockquote>
                        )}

                        <div className="brain-entity-editor">
                          <div className="brain-entity-editor-title">
                            Entity correction
                          </div>
                          <div className="brain-entity-grid">
                            {ENTITY_FIELDS.map((field) => (
                              <label key={field.key}>
                                {field.label}
                                <input
                                  class="input"
                                  value={getEntityFieldValue(fact, field.key)}
                                  onInput={(e) =>
                                    setEntityFieldValue(
                                      fact.id,
                                      field.key,
                                      (e.target as HTMLInputElement).value,
                                    )
                                  }
                                />
                              </label>
                            ))}
                          </div>
                          <button
                            className="btn brain-entity-save"
                            data-variant="outline"
                            data-size="xs"
                            disabled={updatingEntityFactId === fact.id}
                            onClick={() => handleSaveEntities(fact)}
                          >
                            Save entities
                          </button>
                        </div>

                        <div className="brain-review-note-editor">
                          <label>
                            Review note
                            <textarea
                              class="textarea"
                              value={
                                reviewNotes[fact.id] ?? fact.reviewNote ?? ""
                              }
                              rows={2}
                              placeholder="Reason for the decision, suggested correction, or specific concern"
                              onInput={(e) =>
                                setReviewNotes((current) => ({
                                  ...current,
                                  [fact.id]: (e.target as HTMLTextAreaElement)
                                    .value,
                                }))
                              }
                            />
                          </label>
                        </div>

                        <div className="brain-review-actions">
                          <button
                            className="btn"
                            data-variant="outline"
                            data-size="xs"
                            disabled={reviewingFactId === fact.id}
                            onClick={() =>
                              handleReviewFact(
                                fact,
                                fact.reviewStatus || "unreviewed",
                              )
                            }
                          >
                            Save note
                          </button>
                          <button
                            className="btn"
                            data-variant="outline"
                            data-size="xs"
                            disabled={reviewingFactId === fact.id}
                            onClick={() => handleReviewFact(fact, "verified")}
                          >
                            Verify
                          </button>
                          <button
                            className="btn"
                            data-variant="outline"
                            data-size="xs"
                            disabled={reviewingFactId === fact.id}
                            onClick={() =>
                              handleReviewFact(fact, "needs_review")
                            }
                          >
                            Review
                          </button>
                          <button
                            className="btn"
                            data-variant="outline"
                            data-size="xs"
                            disabled={reviewingFactId === fact.id}
                            onClick={() => handleReviewFact(fact, "incorrect")}
                          >
                            Incorrect
                          </button>
                          <button
                            className="btn"
                            data-variant="outline"
                            data-size="xs"
                            disabled={reviewingFactId === fact.id}
                            onClick={() =>
                              handleReviewFact(fact, "quarantined")
                            }
                          >
                            Quarantine
                          </button>
                        </div>
                      </article>
                    ))}
                  </section>

                  <aside className="card brain-evidence-side">
                    <h3>Suggested sections</h3>
                    <div className="brain-section-tags">
                      {evidencePack.queryPlan.answerSections.map((section) => (
                        <span key={section} className="badge" data-tone="brand">
                          {section}
                        </span>
                      ))}
                    </div>

                    <h3>Sources</h3>
                    <div className="brain-source-mini-list">
                      {evidencePack.sources.map((source) => (
                        <button
                          key={source.id}
                          onClick={() =>
                            source.paperUrl ? route(source.paperUrl) : undefined
                          }
                        >
                          <strong>{source.title}</strong>
                          <span>
                            {source.kind} · {source.trustTier}
                            {source.doi ? ` · DOI ${source.doi}` : ""}
                          </span>
                        </button>
                      ))}
                      {evidencePack.sources.length === 0 && (
                        <div className="empty">
                          <header>
                            <p>No sources.</p>
                          </header>
                        </div>
                      )}
                    </div>
                  </aside>
                </div>
              </>
            )}
          </section>
          </TabPanel>
        )}

        {activeTab === "sources" && (
          <TabPanel idPrefix={BRAIN_TABS_ID} value="sources">
            {isLoading && (
              <div className="library-state">Loading Research Brain…</div>
            )}
            {error && !isLoading && (
              <div className="alert" data-tone="danger" role="alert">
                <strong>{error}</strong>
              </div>
            )}

            {!isLoading && !error && (
              <div className="brain-layout">
                <section className="card brain-source-list">
                  {sources.map((source) => (
                    <button
                      key={source.id}
                      className={`brain-source-item ${
                        selectedSource?.id === source.id ? "active" : ""
                      }`}
                      onClick={() => setSelectedSourceId(source.id)}
                    >
                      <div>
                        <strong>{source.title}</strong>
                        <span>
                          {source.trust_tier} ·{" "}
                          {statusLabel(source.extraction_status)}
                        </span>
                      </div>
                      <Icon name="chevronRight" size={16} />
                    </button>
                  ))}
                  {sources.length === 0 && (
                    <div className="empty">
                      <header>
                        <p>No sources registered yet.</p>
                      </header>
                    </div>
                  )}
                </section>

                <section className="card brain-claims-panel">
                  {selectedSource ? (
                    <>
                      <div className="brain-claims-header">
                        <div>
                          <h2>{selectedSource.title}</h2>
                          <p>
                            {selectedSource.source_kind} ·{" "}
                            {selectedSource.trust_tier}
                            {selectedSource.doi
                              ? ` · DOI ${selectedSource.doi}`
                              : ""}
                          </p>
                        </div>
                        <button
                          className="btn library-link-btn"
                          data-variant="outline"
                          onClick={handleExtract}
                        >
                          <Icon name="refresh" size={16} className={BUTTON_ICON_CLASS} />
                          <span>Re-extract</span>
                        </button>
                      </div>

                      {claimsLoading && (
                        <div className="library-state">Loading claims…</div>
                      )}
                      {!claimsLoading && claims.length === 0 && (
                        <div className="empty">
                          <header>
                            <p>No extracted claims for this source.</p>
                          </header>
                        </div>
                      )}
                      <div className="brain-claims-list">
                        {claims.map((claim) => (
                          <article key={claim.id} className="brain-claim-card">
                            <div className="brain-claim-meta">
                              <span className="badge brain-claim-chip" data-tone="brand">
                                {claim.status}
                              </span>
                              <span className="badge brain-claim-chip" data-tone="brand">
                                {claim.confidence}
                              </span>
                              <span className="badge brain-claim-chip" data-tone="brand">
                                {claim.trust_tier}
                              </span>
                            </div>
                            <p>{claim.claim}</p>
                            {claim.chunk?.content && (
                              <blockquote>
                                {claim.chunk.content.slice(0, 260)}…
                              </blockquote>
                            )}
                          </article>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="empty">
                      <header>
                        <h3>No source selected</h3>
                        <p>Choose a source to see its claims.</p>
                      </header>
                    </div>
                  )}
                </section>
              </div>
            )}
          </TabPanel>
        )}
        </Tabs>
      </main>
    </div>
  );
}
