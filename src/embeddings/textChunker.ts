import { CONFIG } from "./config";
import type { PageOffset } from "./documentProcessor";

export interface Chunk {
  title: string;
  content: string;
  metadata: any;
  chunkIndex: number;
  totalChunks: number;
}

/**
 * Map a character offset in the document to its 1-indexed page using the
 * offset→page ranges produced by the PDF parser. Returns undefined when there
 * is no page map (non-PDF documents) or the offset falls outside every range.
 */
function pageForOffset(
  offset: number,
  pageOffsets?: PageOffset[],
): number | undefined {
  if (!pageOffsets || pageOffsets.length === 0) return undefined;
  let fallback: number | undefined;
  for (const range of pageOffsets) {
    if (offset >= range.start && offset < range.end) return range.page;
    // Track the last page whose range begins at or before the offset so an
    // offset landing in the separator between pages still resolves sensibly.
    if (offset >= range.start) fallback = range.page;
  }
  return fallback ?? pageOffsets[0].page;
}

export class TextChunker {
  constructor(
    private maxChunkSize: number = CONFIG.CHUNK_SIZE,
    private overlapSize: number = CONFIG.CHUNK_OVERLAP,
  ) {}

  chunkDocument(doc: {
    title: string;
    content: string;
    metadata: any;
  }): Chunk[] {
    const text = doc.content;
    // `pageOffsets` is present only for PDFs. Strip it from the metadata we
    // spread onto each chunk so the (potentially large) map is not duplicated
    // into every chunk row — the resolved `page` is all downstream needs.
    const { pageOffsets, ...baseMetadata } = (doc.metadata || {}) as {
      pageOffsets?: PageOffset[];
      [key: string]: any;
    };

    // If document is small enough, return as single chunk
    if (text.length <= this.maxChunkSize) {
      return [
        {
          title: doc.title,
          content: text,
          metadata: {
            ...baseMetadata,
            page: pageForOffset(0, pageOffsets),
            isFullDocument: true,
            chunkIndex: 0,
            totalChunks: 1,
          },
          chunkIndex: 0,
          totalChunks: 1,
        },
      ];
    }

    const chunks: Chunk[] = [];
    let start = 0;
    let chunkIndex = 0;

    while (start < text.length) {
      const end = Math.min(start + this.maxChunkSize, text.length);

      // Try to break at natural boundaries
      let actualEnd = end;
      if (end < text.length) {
        const boundaries = [
          text.lastIndexOf("\n\n", end), // Paragraph break
          text.lastIndexOf("\n", end), // Line break
          text.lastIndexOf(". ", end), // Sentence end
          text.lastIndexOf(" ", end), // Word boundary
        ];

        const bestBoundary = boundaries.find(
          (pos) => pos > start + this.maxChunkSize * 0.5,
        );
        if (bestBoundary && bestBoundary > start) {
          actualEnd = bestBoundary + (text[bestBoundary] === "." ? 2 : 1);
        }
      }

      const chunkContent = text.slice(start, actualEnd).trim();
      if (chunkContent) {
        chunks.push({
          title: doc.title,
          content: chunkContent,
          metadata: {
            ...baseMetadata,
            chunkStart: start,
            chunkEnd: actualEnd,
            page: pageForOffset(start, pageOffsets),
            isChunk: true,
            chunkIndex,
            totalChunks: 0, // Will be updated after all chunks are created
          },
          chunkIndex,
          totalChunks: 0, // Will be updated after all chunks are created
        });
      }

      start = Math.max(actualEnd - this.overlapSize, actualEnd);
      chunkIndex++;
    }

    // Update total chunks count in metadata
    chunks.forEach((chunk) => {
      chunk.totalChunks = chunks.length;
      chunk.metadata.totalChunks = chunks.length;
    });

    return chunks;
  }
}
