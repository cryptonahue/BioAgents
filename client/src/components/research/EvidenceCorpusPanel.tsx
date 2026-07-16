import { Icon } from "../icons";
import { useLibraryTotal } from "../../hooks/useLibrary";

/**
 * "Searched your library — 2 of 47 papers matched."
 *
 * The single most useful line in the whole research panel, and it was missing.
 *
 * When the agent cannot answer, it writes paragraphs about what "the loaded
 * evidence" does not contain. But the reader has no idea what the loaded
 * evidence IS — 3 papers or 3000? So an honest "I don't have the papers for
 * this" reads as "this agent is useless" instead of "my library is thin". Same
 * fact, and only one of the two tells the scientist what to do next.
 *
 * Everything here is derived from the passages the pack already carries (each
 * one knows its source title), so the matched set and the per-paper fragment
 * counts cost nothing. Only the library TOTAL needs a request, and if it fails
 * the headline degrades to "N papers matched".
 */

interface CorpusPassage {
  sourceTitle?: string | null;
}

interface Props {
  passages?: CorpusPassage[];
}

export function EvidenceCorpusPanel({ passages }: Props) {
  // Hook first: it must run on every render, before any early return.
  const libraryTotal = useLibraryTotal();

  if (!passages || passages.length === 0) return null;

  const byTitle = new Map<string, number>();
  for (const passage of passages) {
    const title = passage.sourceTitle?.trim();
    if (!title) continue;
    byTitle.set(title, (byTitle.get(title) ?? 0) + 1);
  }

  const matched = [...byTitle.entries()].sort((a, b) => b[1] - a[1]);
  if (matched.length === 0) return null;

  const headline =
    libraryTotal && libraryTotal > 0
      ? `Searched your library — ${matched.length} of ${libraryTotal} papers matched`
      : `Searched your library — ${matched.length} ${matched.length === 1 ? "paper" : "papers"} matched`;

  return (
    <div className="card research-corpus">
      <div className="research-corpus-head">
        <figure className="research-corpus-icon">
          <Icon name="bookOpen" size={16} />
        </figure>
        <span className="research-corpus-title">{headline}</span>
      </div>

      <div className="item-group research-corpus-list">
        {matched.map(([title, count]) => (
          <div
            key={title}
            className="item research-corpus-item"
            data-variant="outline"
            data-size="xs"
          >
            <figure className="research-corpus-glyph">
              <Icon name="checkCircle" size={12} />
            </figure>
            <section>
              <h4 className="research-corpus-paper">{title}</h4>
            </section>
            <aside className="research-corpus-count">
              {count} {count === 1 ? "fragment" : "fragments"}
            </aside>
          </div>
        ))}
      </div>
    </div>
  );
}
