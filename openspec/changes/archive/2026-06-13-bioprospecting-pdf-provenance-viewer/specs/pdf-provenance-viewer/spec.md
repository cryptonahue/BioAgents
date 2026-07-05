# Spec: pdf-provenance-viewer

## Purpose

Make every bioprospecting fact auditable in one click. When a user
sees a fact in the evidence pack or library, the user can open the
source PDF, jump to the exact page, and see a highlight box over the
text, table row, or figure region the fact was extracted from. When
no bbox is available (legacy data), the user still gets the source
page with a text-chunk highlight and a `provenance: text-only` badge
so they can verify the claim manually.

The viewer ships as a hybrid: a lightbox overlay for inline
auditing, and a dedicated full-screen route (`/library/:docId/viewer`
or `/viewer/:sourceId`) for deep inspection. Both surfaces share the
same PDF.js mount and bbox overlay component; both read from the
same backend endpoints.

## Requirements

### Requirement: Provenance API Endpoints

The system MUST expose three REST endpoints that resolve fact and
source provenance into the JSON the viewer needs to render a
highlight overlay.

**Endpoint 1: `GET /api/research-brain/sources/:sourceId/evidence`**

Returns all tables, figures, and chunks for a source so the viewer
can list the provenance objects on the page.

```json
{
  "sourceId": "uuid",
  "tables": [
    {
      "id": "uuid",
      "page": 4,
      "tableIndex": 0,
      "headers": ["**Treatment** | Control [mg/mL]", "**Treatment** | Dose [mg/mL]"],
      "rows": [["0", "-", "1.2"], ["24", "3.1", "5.4"]],
      "markdown": "...",
      "bbox": { "x": 72, "y": 144, "w": 216, "h": 180, "page": 4, "units": "pt" },
      "extractionProvider": "local",
      "extractionConfidence": 0.87
    }
  ],
  "figures": [
    {
      "id": "uuid",
      "page": 2,
      "figureIndex": 0,
      "bbox": { "x": 100, "y": 200, "w": 300, "h": 220, "page": 2, "units": "pt" },
      "caption": "Figure 3. Cell viability assay results."
    }
  ],
  "chunks": [
    {
      "id": "uuid",
      "page": 3,
      "chunkIndex": 7,
      "content": "Q. officinale extract inhibited...",
      "bbox": null
    }
  ]
}
```

**Endpoint 2: `GET /api/research-brain/sources/:sourceId/pdf`**

Streams the source PDF file to the viewer. The endpoint MUST proxy
through the API rather than handing out a presigned S3 URL, so the
caller never receives credentials that grant broader bucket access.

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: inline; filename="<sanitized-title>.pdf"
<binary PDF bytes>
```

**Endpoint 3: `GET /api/research-brain/facts/:factId/provenance`**

Returns the full provenance chain for a single fact — the resolved
table or figure (with bbox and page), the supporting chunk, and the
source pointer. The shape makes the lightbox one call away.

```json
{
  "factId": "uuid",
  "sourceId": "uuid",
  "sourceTitle": "Marine algae compounds as...",
  "doi": "10.xxxx/xxxxx",
  "provenance": {
    "type": "table" | "figure" | "chunk" | "text-only",
    "table": { ... } | null,
    "figure": { ... } | null,
    "chunk": {
      "id": "uuid",
      "page": 3,
      "chunkIndex": 7,
      "content": "Q. officinale extract inhibited..."
    } | null,
    "bbox": { "x": 0, "y": 0, "w": 0, "h": 0, "page": 0, "units": "pt" } | null
  }
}
```

`provenance.type` follows this precedence:

1. `table` — the fact has `evidence_table_id` set and the table row
   is resolvable.
2. `figure` — the fact has `evidence_figure_id` set and the figure
   is resolvable.
3. `chunk` — the fact has a `chunk_id` set; bbox is null; the
   viewer falls back to a text-chunk highlight.
4. `text-only` — the fact has no bbox, no chunk, and no table/
   figure. The response still includes the source pointer and
   `provenance.bbox: null` so the lightbox can render the badge.

#### Scenario: Evidence endpoint returns tables and figures

- GIVEN a source with 3 tables and 2 figures in
  `research_evidence_tables` / `research_evidence_figures`
- WHEN `GET /api/research-brain/sources/S/evidence` is called
- THEN the response is `{ tables: [...3], figures: [...2], chunks:
  [...] }`
- AND the order is by `(page, tableIndex)` ascending for tables
  and `(page, figureIndex)` ascending for figures

#### Scenario: PDF endpoint streams the source

- GIVEN a source S with `file_path` pointing to a valid PDF in S3
  storage
- WHEN `GET /api/research-brain/sources/S/pdf` is called
- THEN the response is HTTP 200 with `Content-Type: application/pdf`
  and the binary bytes of the PDF
- AND no S3 credentials are exposed in the response (the API
  performs the fetch internally)

#### Scenario: Fact provenance resolves to a table

- GIVEN a fact F with `evidence_table_id = T` set
- WHEN `GET /api/research-brain/facts/F/provenance` is called
- THEN `provenance.type = "table"`
- AND `provenance.table` contains the full table object including
  `bbox`
- AND `provenance.bbox` equals `provenance.table.bbox`

#### Scenario: Fact provenance resolves to a chunk (no bbox)

- GIVEN a fact F with `chunk_id = C` but no `evidence_table_id` and
  no `evidence_figure_id`
- WHEN the provenance endpoint is called
- THEN `provenance.type = "chunk"`
- AND `provenance.chunk` contains the chunk's page, content, and
  index
- AND `provenance.bbox` is `null`
- AND the response is still 200 (the legacy path is supported)

#### Scenario: Fact provenance falls back to text-only

- GIVEN a fact F with neither bbox provenance nor a chunk
- WHEN the provenance endpoint is called
- THEN `provenance.type = "text-only"`
- AND `provenance.chunk` is `null`
- AND `provenance.bbox` is `null`
- AND the response is still 200

#### Scenario: Unknown source returns 404

- GIVEN a non-existent `sourceId`
- WHEN `GET /api/research-brain/sources/{id}/evidence` is called
- THEN the response is HTTP 404 with
  `{ "error": "Source not found" }`

#### Scenario: Unknown fact returns 404

- GIVEN a non-existent `factId`
- WHEN `GET /api/research-brain/facts/{id}/provenance` is called
- THEN the response is HTTP 404 with
  `{ "error": "Fact not found" }`

### Requirement: PDF Viewer Route

The system MUST expose a dedicated full-screen viewer route. Two
equivalent URL forms are supported, both resolving to the same
component:

- `/library/:docId/viewer` — document-scoped, for users coming
  from the library page.
- `/viewer/:sourceId` — source-scoped, for users coming from
  research brain or evidence pack links.

The route MUST be implemented as a client-side page component
(`LibraryViewerPage` for the library form, `SourceViewerPage` for
the source form) that mounts a PDF.js viewer with the source PDF
loaded from the proxy endpoint.

**URL hash contract:**

The viewer reads the following URL hash keys on mount and restores
them on every reload:

- `#bbox=x,y,w,h` — coordinates in PDF point space. Overrides any
  default highlight.
- `#page=N` — 1-indexed page to scroll into view. Defaults to 1.
- `#type=table|figure|chunk` — provenance type, controls highlight
  styling. Defaults to `chunk` when not specified.

The route MUST be deep-linkable: a user reloading the page with the
hash intact lands on the same page and the same highlight box.

#### Scenario: Dedicated viewer route loads a PDF

- GIVEN a source S whose PDF is reachable via the proxy endpoint
- WHEN the user navigates to `/viewer/S`
- THEN the route renders a full-screen PDF.js viewer
- AND the viewer loads `GET /api/research-brain/sources/S/pdf`
- AND page 1 is visible
- AND no highlight is shown (no bbox in the hash)

#### Scenario: Hash drives page and bbox

- GIVEN the user navigates to `/viewer/S#bbox=72,144,216,180&page=4&type=table`
- WHEN the viewer mounts
- THEN page 4 is scrolled into view
- AND a highlight box is drawn at the transformed bbox
- AND the highlight uses the table styling (e.g., a blue border)

#### Scenario: Hash survives reload

- GIVEN a viewer state with the URL
  `/viewer/S#bbox=72,144,216,180&page=4&type=table`
- WHEN the user reloads the page
- THEN the URL is preserved (no client router strips the hash)
- AND the same page, bbox, and type are restored
- AND the user lands on the same visual state

#### Scenario: Library form is equivalent

- GIVEN a document D whose `source_id` is S
- WHEN the user navigates to `/library/D/viewer#page=3&type=chunk`
- THEN the viewer mounts with `sourceId = D.source_id`
- AND the same hash contract applies
- AND the URL survives reload

### Requirement: PDF.js Mount And Highlight Overlay

The system MUST mount a PDF.js viewer inside both the dedicated
route and the lightbox component. The mount handles page rendering
and exposes a `pdfViewer` instance the highlight overlay reads
from to position boxes.

**Render scale contract:**

- The viewer MUST render pages at 1.5× scale (the same scale the
  local table provider uses to compute bboxes). The scale is a
  module constant `PDFJS_RENDER_SCALE = 1.5`; it MUST NOT be
  parameterized per document.
- To transform a stored bbox (in points) to screen pixels, the
  viewer multiplies `x`, `y`, `w`, `h` by 1.5.
- The PDF.js text layer is enabled so the user can select and copy
  text (read-only interaction).

**Highlight overlay behavior:**

- A highlight is rendered as a CSS-positioned div absolutely
  positioned over the rendered page.
- The overlay layer tracks scroll and zoom — the highlight must
  follow the page as the user scrolls, but in Phase 1 the zoom
  level is fixed at 1.5× and does not change.
- The overlay supports up to one active highlight per viewer
  instance. If multiple bboxes are passed (e.g., a table that
  spans rows), the overlay renders one div per bbox.

#### Scenario: Viewer renders at the fixed scale

- GIVEN any source PDF
- WHEN the viewer mounts
- THEN pages are rendered at 1.5× the source resolution
- AND the rendered canvas dimensions are 1.5× the natural PDF
  point dimensions

#### Scenario: Bbox transforms to screen pixels

- GIVEN a stored bbox `{ x: 72, y: 144, w: 216, h: 180, page: 4 }`
- WHEN the overlay renders on page 4 (at 1.5× scale)
- THEN the highlight div is positioned at CSS `left: 108px`,
  `top: 216px`, `width: 324px`, `height: 270px`
- (i.e., the four coords are multiplied by 1.5)

#### Scenario: Multiple bboxes render as multiple highlights

- GIVEN a table spanning two visually separate regions on the
  same page (e.g., wrapped table)
- WHEN the overlay receives both bboxes
- THEN it renders one highlight div per bbox
- AND each div uses the same styling

#### Scenario: Read-only with selection and copy

- GIVEN the viewer is open
- WHEN the user selects text on a page
- THEN the selection is visible (PDF.js text layer is on)
- AND the user can copy the selection to the clipboard
- AND no inline editing is exposed (the v1 contract)

### Requirement: Evidence Lightbox Component

The system MUST provide an `EvidenceLightbox` Preact component that
opens an inline viewer over the current page. The lightbox is the
default affordance for fact citations; the dedicated route is the
"open in tab" escalation.

**Lightbox behavior:**

- The lightbox is a modal overlay that mounts the same PDF.js
  viewer used by the dedicated route.
- It opens with a single fact in context: the source PDF, the
  resolved page, and the bbox highlight.
- `Esc` closes the lightbox.
- Focus is trapped inside the lightbox while it is open.
- The lightbox exposes a single button: "Open in tab". Clicking
  the button navigates to `/viewer/:sourceId#bbox=...&page=...&type=...`
  in a new tab and closes the lightbox.
- The lightbox supports all four provenance types:
  `table` (blue highlight), `figure` (purple), `chunk` (yellow),
  `text-only` (no highlight, badge only).

#### Scenario: Lightbox opens on fact citation click

- GIVEN the user is on the library page and clicks a fact citation
- WHEN the click handler fires
- THEN the lightbox mounts
- AND the lightbox fetches the provenance for that fact
- AND the source PDF is loaded into the PDF.js viewer
- AND the resolved page is scrolled into view
- AND the bbox is highlighted

#### Scenario: Esc closes the lightbox

- GIVEN the lightbox is open
- WHEN the user presses Esc
- THEN the lightbox unmounts
- AND focus returns to the fact citation that opened it

#### Scenario: Open-in-tab navigates to the dedicated route

- GIVEN the lightbox is open on a fact with
  `provenance.type = "table"` and `bbox = { ... }` on page 4
- WHEN the user clicks "Open in tab"
- THEN the browser opens a new tab at
  `/viewer/{sourceId}#bbox=72,144,216,180&page=4&type=table`
- AND the lightbox closes in the original tab

#### Scenario: Focus is trapped inside the lightbox

- GIVEN the lightbox is open
- WHEN the user tabs through interactive elements
- THEN focus cycles only through elements inside the lightbox
- AND focus does NOT escape to the underlying page

### Requirement: Text-Chunk Fallback And Badges

The system MUST support a text-chunk highlight path for facts that
have a `chunk_id` but no `evidence_table_id` and no
`evidence_figure_id`. The fallback renders a highlight over the
resolved chunk text rather than a bbox, and badges the fact with
`provenance: text-only` so the user knows the citation is not
visually anchored.

**Fallback rendering:**

- The viewer fetches the chunk's page and content via
  `GET /api/research-brain/sources/S/evidence`.
- The lightbox uses PDF.js's text-layer search API to find the
  first occurrence of the chunk's first 80 characters on the
  resolved page.
- The match is highlighted with a yellow overlay (the `chunk`
  styling).
- If the chunk's text is not found on the page (e.g., the chunk
  was extracted from a different page than recorded), the
  lightbox shows the source page with no highlight and a
  `provenance: text-only` badge.

**Badges:**

- The fact card on the evidence pack and library pages MUST show
  a `provenance: text-only` badge for any fact with `provenance.
  type = "text-only"`.
- The badge is a small pill rendered next to the fact's source
  title; it is informational, not a warning, and uses neutral
  styling.
- A fact with `provenance.type = "table" | "figure"` does NOT
  show the badge — the dedicated highlight is the provenance
  signal.

#### Scenario: Chunk highlight on the source page

- GIVEN a fact F with `chunk_id = C`, no `evidence_table_id`, no
  `evidence_figure_id`, where C is on page 3 of source S
- WHEN the user clicks F's citation
- THEN the lightbox opens at page 3
- AND the text-layer search locates C's first 80 characters
- AND a yellow highlight is drawn over the match
- AND the badge is NOT shown (chunk highlight is its own signal)

#### Scenario: text-only badge on legacy facts

- GIVEN a fact F with no chunk, no table, and no figure
- WHEN the user clicks F's citation
- THEN the lightbox opens at page 1
- AND a `provenance: text-only` badge is visible in the lightbox
  header
- AND no highlight is drawn

#### Scenario: text-only badge on fact cards

- GIVEN a fact F with `provenance.type = "text-only"`
- WHEN the fact is rendered on the evidence pack or library page
- THEN a `provenance: text-only` badge appears next to the source
  title
- AND the badge is keyboard-focusable and exposes an accessible
  label ("Text-only provenance — click to view source page")

#### Scenario: Missing chunk text gracefully degrades

- GIVEN a fact F with `chunk_id = C` and C's content does not
  appear on its recorded page
- WHEN the lightbox opens
- THEN the resolved page is shown
- AND the badge `provenance: text-only` is shown
- AND a soft message reads "Chunk text not found on this page;
  showing the source for manual verification"

### Requirement: Citation Click Integration

The system MUST wire fact citations on the evidence pack and
library pages to open the lightbox. The wiring is client-side; it
does not change the API contract.

**Behavior:**

- Any element with the role `button` and `data-provenance-trigger`
  attribute (set by the rendering code) opens the lightbox when
  activated (click or Enter keypress).
- The trigger carries the `factId` in its `data-fact-id` attribute
  so the lightbox knows which fact's provenance to fetch.
- The same trigger also navigates to the dedicated viewer when
  modifier-clicked (Ctrl/Cmd+click), preserving the "open in tab"
  keyboard pattern.
- A trigger MUST NOT navigate by default — it opens the lightbox.
  Dedicated viewer navigation is only via the lightbox's "Open in
  tab" button or modifier-click.

#### Scenario: Click on fact citation opens the lightbox

- GIVEN a fact card with a citation element carrying
  `data-provenance-trigger` and `data-fact-id = F`
- WHEN the user clicks the citation
- THEN the lightbox opens
- AND the URL hash does NOT change (lightbox is in-page, not a
  route change)

#### Scenario: Modifier-click opens the dedicated route

- GIVEN a fact card with the same trigger
- WHEN the user Ctrl/Cmd-clicks the citation
- THEN a new tab opens at `/viewer/{sourceId}#...` carrying the
  resolved bbox, page, and type
- AND the original tab is unchanged

#### Scenario: Keyboard activation

- GIVEN a fact card citation is focused
- WHEN the user presses Enter
- THEN the lightbox opens (same as a click)

### Requirement: Read-Only Contract

The system MUST expose a read-only viewer in Phase 1. Inline cell
editing, char-level provenance, and write-back annotations are out
of scope.

**Behavior:**

- The PDF.js text layer is enabled. The user can select text and
  copy to the clipboard.
- No edit affordances (no form fields, no text inputs, no "save
  annotation" button) are rendered.
- No write operations are exposed against `research_evidence_tables`
  or `research_evidence_figures` from the viewer. The viewer is
  strictly a consumer of the read endpoints defined above.
- The proposal's Out-of-Scope list (inline cell editing, char-level
  offsets, annotation export) is encoded as testable "MUST NOT"
  rules here so future changes cannot silently expand the surface.

#### Scenario: User can select and copy

- GIVEN the viewer is open on any page
- WHEN the user selects a paragraph and presses Ctrl/Cmd+C
- THEN the selected text is on the clipboard
- AND no API write call is made

#### Scenario: No edit affordances are rendered

- GIVEN the viewer is open
- WHEN the page is inspected
- THEN there are no `<textarea>`, no `<input>`, no "save" buttons,
  and no editable `contenteditable` regions inside the viewer
  root

#### Scenario: Viewer does not write to evidence tables

- GIVEN the viewer is open
- WHEN any viewer interaction occurs
- THEN no HTTP method other than `GET` is issued against
  `/api/research-brain/sources/...` or
  `/api/research-brain/facts/...`
- AND no INSERT/UPDATE/DELETE runs against
  `research_evidence_tables` or `research_evidence_figures`
