# Delta for pdf-provenance-viewer

## ADDED Requirements

### Requirement: Lightbox Renders Extracted Figure Image

The system MUST render the extracted figure image at the top
of the `EvidenceLightbox` when the figure's `imageUrl` is
present in the provenance response. When `imageUrl` is absent
(the bbox-only case), the lightbox preserves the pre-change
behavior: a purple bbox over the PDF page with no `<img>`.

**Behavior contract:**

- The `EvidenceLightbox` component reads `provenance.figure.
  imageUrl`, `provenance.figure.width`, `provenance.figure.
  height`, and `provenance.figure.mimeType` from the
  provenance response (see `figure-image-extraction`
  capability, `Evidence Endpoint Image URL` requirement).
- When `imageUrl` is present, the lightbox MUST render a
  cropped image header above the PDF page: a single `<img>`
  element with `src={imageUrl}`, `alt={caption ?? "Figure
  preview"}`, `width` / `height` set to the
  response-provided values (so the layout does not shift
  when the bytes load), and `loading="lazy"` (the image is
  below the fold on most viewports; lazy is the safer
  default).
- The `<img>` MUST be wrapped in a container with
  `role="img"` and an `aria-label` carrying the figure
  caption. This is the screen-reader contract; the alt text
  alone is not enough for the lightbox's modal context.
- When `imageUrl` is absent (bbox-only), the lightbox
  renders the existing purple bbox with no `<img>` (pre-
  change behavior is preserved end-to-end).
- The image header is keyboard-focusable: pressing `Tab`
  reaches the "Open image" and "Download" buttons (see
  below) in the natural reading order.

#### Scenario: Lightbox shows the image header for a figure with imageUrl

- GIVEN a fact F whose `provenance.type = "figure"` and
  `provenance.figure.imageUrl = "/api/research-brain/figures/
  {id}/image"`, `width = 450`, `height = 330`
- WHEN the user clicks F's citation
- THEN the lightbox mounts
- AND the header section renders an `<img>` with
  `src="/api/research-brain/figures/{id}/image"`, `alt`
  set to the figure caption (or "Figure preview" if null),
  `width="450"`, `height="330"`, `loading="lazy"`
- AND the `role="img"` wrapper has an `aria-label` equal
  to the figure caption
- AND the PDF page is still rendered below the image
  header (the image is supplementary, not a replacement)

#### Scenario: Lightbox skips the image header for bbox-only

- GIVEN a fact F whose `provenance.type = "figure"` and
  `provenance.figure` has no `imageUrl` field (storage_path
  was null at extraction time)
- WHEN the user clicks F's citation
- THEN the lightbox mounts
- AND no `<img>` header is rendered
- AND the purple bbox is drawn over the figure region
- AND the caption is shown next to the bbox
- AND this is byte-for-byte identical to the pre-change
  lightbox behavior

#### Scenario: Image header is keyboard-accessible

- GIVEN the lightbox is open with the image header rendered
- WHEN the user tabs into the lightbox
- THEN focus reaches the "Open image" button first
- AND then the "Download" button
- AND then the rest of the lightbox controls (PDF viewer,
  "Open in tab", close)
- AND focus does NOT escape the lightbox (the existing
  focus-trap contract is preserved)

### Requirement: Lightbox Figure Buttons

The system MUST expose two new buttons in the
`EvidenceLightbox` header when the figure has an
`imageUrl`: "Open image" and "Download". Both are visible
ONLY when `imageUrl` is present; the bbox-only case shows no
buttons.

**Button contracts:**

- **"Open image"** — opens the image URL in a new browser
  tab via `window.open(imageUrl, "_blank",
  "noopener,noreferrer")`. The `noopener,noreferrer` flags
  are required (no `window.opener` exposure, no Referer
  leak). The button is a `<button type="button">` with
  `aria-label="Open figure image in new tab"`.
- **"Download"** — triggers a file download of the image
  bytes. The button reads the image bytes via
  `fetch(imageUrl, { credentials: "include" })` (so the
  session cookie is sent), wraps them in a `Blob` with the
  response's `Content-Type`, and triggers a download via a
  synthetic `<a download>` click. The download's
  `download` attribute is set to
  `figure-{figureIndex}.{png|jpg}` (derived from
  `mimeType`). The button is a `<button type="button">` with
  `aria-label="Download figure image"`.
- Both buttons are positioned in the image header, side by
  side, right-aligned. They are NOT inside the PDF viewer's
  controls (the PDF viewer remains read-only — see
  `Read-Only Contract` in the base spec).
- Both buttons MUST be visually distinguishable from the
  PDF viewer's controls (different background, different
  icon, different color). They are figure-specific
  affordances, not viewer navigation.

#### Scenario: Open image opens in a new tab

- GIVEN the lightbox is open with a figure that has
  `imageUrl = "/api/research-brain/figures/{id}/image"`
- WHEN the user clicks "Open image"
- THEN `window.open` is called with the image URL,
  `"_blank"`, and `"noopener,noreferrer"`
- AND a new tab opens at the image URL
- AND the original tab's lightbox is unchanged

#### Scenario: Download triggers a file save

- GIVEN the lightbox is open with a figure whose
  `mimeType = "image/png"` and `figureIndex = 3`
- WHEN the user clicks "Download"
- THEN a `fetch` is issued against `imageUrl` with
  `credentials: "include"`
- AND the response bytes are wrapped in a `Blob` with
  `type: "image/png"`
- AND a synthetic `<a>` with
  `href: <blob URL>, download: "figure-3.png"` is
  clicked
- AND the browser saves the file as `figure-3.png`
- AND a second click on the button does NOT accumulate
  multiple downloads (the blob URL is revoked after the
  click)

#### Scenario: Buttons are hidden for bbox-only figures

- GIVEN a figure with no `imageUrl`
- WHEN the lightbox renders
- THEN the "Open image" and "Download" buttons are NOT
  rendered
- AND the lightbox header shows only the existing
  caption + close button

### Requirement: Bbox Color Split (Green vs Purple)

The system MUST switch the `BboxOverlay` border color for
figures based on whether the figure has an extracted image.

**Color contract:**

- **Green border** (e.g., `border-emerald-500`, `2px solid`)
  — rendered when `provenance.figure.imageUrl` is present.
  The green signals "this figure has a downloadable,
  verifiable image".
- **Purple border** (the pre-change color, e.g.,
  `border-purple-500`, `2px solid`) — rendered when
  `imageUrl` is absent. The purple is the legacy "bbox-only"
  signal and continues to mean "I see the region, but I
  don't have a clean crop of it".
- The split applies to:
  - The bbox overlay on the PDF page inside the lightbox.
  - The bbox overlay on the dedicated viewer route
    (`/viewer/:sourceId`).
  - The list of figures in the `evidence` endpoint's UI
    (figure cards with mini bboxes).
- The split MUST NOT apply to non-figure bboxes (tables
  remain blue, chunks remain yellow, per the pre-change
  contract in `pdf-provenance-viewer` `Evidence Lightbox
  Component`).

#### Scenario: Figure with imageUrl gets a green border

- GIVEN a figure with `imageUrl` in the provenance response
- WHEN the lightbox or viewer renders
- THEN the figure's bbox is drawn with a green border
  (2px solid, emerald-500)
- AND the bbox's `data-provenance-figure-status` attribute
  is set to `"with-image"` (for end-to-end test selectors)

#### Scenario: Bbox-only figure keeps a purple border

- GIVEN a figure with no `imageUrl` in the provenance
  response
- WHEN the lightbox or viewer renders
- THEN the figure's bbox is drawn with a purple border
  (2px solid, purple-500) — the pre-change color
- AND the bbox's `data-provenance-figure-status` attribute
  is set to `"bbox-only"`

#### Scenario: Tables and chunks are unaffected

- GIVEN a table bbox (provenance.type = "table") and a
  chunk highlight (provenance.type = "chunk")
- WHEN the viewer renders
- THEN the table's border is still blue (pre-change
  contract) and the chunk's border is still yellow
  (pre-change contract)
- AND the green/purple split applies ONLY to
  `provenance.type = "figure"`

### Requirement: Viewer Header Shows Figure Index and Page

The system MUST surface the figure's index on its page and
its page number in the viewer header, so the user can
identify which figure they are inspecting when the
provenance object is opened directly (deep link with
`type=figure`).

**Header contract:**

- The viewer header (top of the lightbox and the dedicated
  viewer route) MUST render the figure identifier as
  `Figure {figureIndex} (page {page})` when
  `provenance.type = "figure"`. Example: `Figure 2 (page
  4)`.
- The header text MUST be visible regardless of whether
  the figure has an image (`imageUrl` present or not).
- The header is a sibling of the "Open in tab" / "Close"
  buttons in the existing lightbox toolbar; the new text
  is left-aligned, the buttons are right-aligned.
- The same header is shown on the dedicated viewer route
  when navigated to via a deep link
  (`/viewer/{S}#type=figure&page=N`). On the dedicated
  route, the header is rendered above the PDF page.

#### Scenario: Lightbox shows figure index and page

- GIVEN a figure with `figureIndex = 2` and `page = 4`
- WHEN the lightbox mounts
- THEN the header shows the literal text
  `Figure 2 (page 4)`
- AND the header is visible to screen readers
  (`aria-label="Figure 2 on page 4"`)

#### Scenario: Dedicated viewer route shows figure header

- GIVEN a deep link
  `/viewer/{S}#bbox=...&page=4&type=figure`
- WHEN the viewer mounts
- THEN the header above the PDF page shows
  `Figure {N} (page 4)` where N is the figure index of the
  bbox being highlighted
- AND the text is left-aligned in the viewer header bar

## MODIFIED Requirements

### Requirement: Provenance API Endpoints

The `GET /api/research-brain/sources/:sourceId/evidence`
endpoint's `figures` array gains the `imageUrl`, `width`,
`height`, and `mimeType` fields (all optional — present only
when the figure has an extracted image). The endpoint's
ordering, `bbox` shape, and `caption` contract are
unchanged. The endpoint remains read-only.

(Previously: the figures array contained `id`, `page`,
`figureIndex`, `bbox`, `caption` only. The delta adds the
four optional image fields.)

#### Scenario: Evidence endpoint returns image fields when present

- GIVEN a figure row with
  `storage_path = 'figures/{S}/0.png'`, `width = 450`,
  `height = 330`, `mime_type = 'image/png'`
- WHEN the evidence endpoint is called
- THEN the figure entry contains
  `imageUrl: "/api/research-brain/figures/{id}/image"`,
  `width: 450`, `height: 330`, `mimeType: "image/png"`
- AND the existing `id`, `page`, `figureIndex`, `bbox`,
  `caption` fields are unchanged
- AND the figure's position in the array is unchanged
  (still ordered by `(page, figureIndex)` ascending)

#### Scenario: Evidence endpoint omits image fields for bbox-only

- GIVEN a figure row with `storage_path = NULL`
- WHEN the evidence endpoint is called
- THEN the figure entry has NO `imageUrl`, `width`,
  `height`, or `mimeType` fields
- AND the existing `id`, `page`, `figureIndex`, `bbox`,
  `caption` fields are unchanged
- AND the consumer (lightbox, viewer, library page) can
  detect the bbox-only case via the absence of `imageUrl`

### Requirement: Evidence Lightbox Component

The `EvidenceLightbox` component gains the image header and
the "Open image" / "Download" buttons (see `Lightbox Renders
Extracted Figure Image` and `Lightbox Figure Buttons`
above) for figures with `imageUrl`. The component's
existing focus-trap, Esc-to-close, and "Open in tab"
contracts are unchanged. The lightbox supports all four
provenance types as before: `table` (blue), `figure`
(green-with-image / purple-bbox-only, see `Bbox Color
Split`), `chunk` (yellow), `text-only` (no highlight,
badge only).

(Previously: the lightbox rendered figures with a purple
bbox and no image header. The delta adds the conditional
green-with-image path and the two new buttons.)

#### Scenario: Lightbox color split matches image availability

- GIVEN a fact with `provenance.type = "figure"`
- WHEN the lightbox renders
- THEN the bbox border is GREEN (emerald-500) if
  `provenance.figure.imageUrl` is present
- AND the bbox border is PURPLE (purple-500) if
  `imageUrl` is absent
- AND the image header (`<img>`) is shown iff the border
  is green

#### Scenario: Lightbox preserves all four provenance types

- GIVEN the lightbox supports `table`, `figure`, `chunk`,
  `text-only` provenance types
- WHEN the lightbox renders a non-figure fact
- THEN the existing colors apply (blue for table, yellow
  for chunk, badge-only for text-only)
- AND the figure-only deltas (image header, buttons,
  figure-index header) are NOT rendered for non-figure
  types

### Requirement: Read-Only Contract

The viewer remains read-only. The new "Open image" and
"Download" buttons do NOT mutate any DB row. They are
read-only affordances on top of the same proxy endpoint.
The "Open image" button uses `window.open` (a read-only
navigation); the "Download" button uses `fetch` + `Blob`
+ a synthetic `<a>` click (a read-only data export). No
write operation is introduced.

(Previously: the viewer was strictly a consumer of the read
endpoints. The delta preserves that contract; the new
buttons are read-only navigation / export.)

#### Scenario: Buttons do not write to the database

- GIVEN the lightbox is open and the user clicks "Open
  image" or "Download"
- WHEN the click handler fires
- THEN no HTTP method other than `GET` (for the proxy
  fetch) is issued against
  `/api/research-brain/figures/...`
- AND no INSERT/UPDATE/DELETE runs against
  `research_evidence_figures` or
  `research_bioprospecting_facts`
- AND no state change is observable in the DB

#### Scenario: Read-only affordances match viewer contract

- GIVEN the viewer is open
- WHEN the page is inspected
- THEN the new "Open image" and "Download" buttons are
  inside the lightbox header, NOT inside the PDF viewer's
  controls
- AND the PDF viewer itself is unchanged (no
  `<textarea>`, no `<input>`, no "save" button, no
  editable region — the pre-change contract is preserved)
- AND the only HTTP methods issued by the buttons are
  `GET` (proxy fetch) and `GET` (window.open navigation)
