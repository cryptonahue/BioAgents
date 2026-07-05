/**
 * Load and cache a PDF.js document from the API proxy endpoint.
 *
 * The PDF bytes are streamed from `GET /api/research-brain/sources/:id/pdf`
 * (auth required; the endpoint proxies the S3 download — see
 * `src/routes/research-brain.ts`). The hook returns a `PdfDocumentProxy`
 * that the EvidenceViewer uses to render pages and read the text layer.
 *
 * The document is loaded once per `sourceId` and torn down on unmount
 * via `destroy()`. Caching across mounts is intentionally NOT done
 * here — the EvidenceViewer's lifecycle is short (lightbox or route
 * page), and re-loading a 5 MB PDF is cheaper than holding one in
 * memory after the user navigates away.
 */
import { useCallback, useEffect, useState } from "preact/hooks";

import { pdfjsLib, type PdfDocumentProxy } from "../lib/pdfjs";

function getAuthToken(): string | null {
  return localStorage.getItem("bioagents_auth_token");
}

function getStableUserId(): string {
  let id = localStorage.getItem("dev_user_id");
  if (!id) {
    id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("dev_user_id", id);
  }
  return id;
}

export function usePdfDocument(sourceId: string | null) {
  const [doc, setDoc] = useState<PdfDocumentProxy | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [numPages, setNumPages] = useState(0);

  const load = useCallback(async () => {
    if (!sourceId) {
      setDoc(null);
      setNumPages(0);
      return;
    }
    setIsLoading(true);
    setError("");
    try {
      const token = getAuthToken();
      const userId = getStableUserId();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      headers["X-User-Id"] = userId;

      // The PDF proxy can return a JSON error envelope (e.g. when the
      // storage provider is unconfigured, returning 502 with
      // `{error, message}`). PDF.js will surface the raw response as
      // "Unexpected server response (NNN)" — opaque to the user. Probe
      // the URL with a HEAD-ish GET first and surface the API's own
      // message when the body isn't a PDF.
      const probe = await fetch(
        `/api/research-brain/sources/${sourceId}/pdf`,
        {
          method: "GET",
          headers: { ...headers, Range: "bytes=0-0" },
          credentials: "include",
        },
      );
      if (!probe.ok) {
        let apiMessage = "";
        const contentType = probe.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          try {
            const body = await probe.json();
            apiMessage = body?.message || body?.error || "";
          } catch {
            // ignore — fall through to status-based message
          }
        }
        throw new Error(
          apiMessage ||
            `PDF proxy returned ${probe.status} ${probe.statusText}`,
        );
      }

      // PDF.js accepts a URL with `httpHeaders` for cross-origin auth
      // — we set them inline. Credentials are also included for the
      // same-site cookie fallback.
      const task = pdfjsLib.getDocument({
        url: `/api/research-brain/sources/${sourceId}/pdf`,
        httpHeaders: headers,
        withCredentials: true,
      });
      const loaded = await task.promise;
      setDoc(loaded);
      setNumPages(loaded.numPages);
    } catch (err: any) {
      setError(err?.message || "Failed to load PDF");
      setDoc(null);
      setNumPages(0);
    } finally {
      setIsLoading(false);
    }
  }, [sourceId]);

  useEffect(() => {
    load();
    return () => {
      // Cleanup the in-memory document on unmount. PDF.js holds onto
      // typed arrays; without destroy() they leak across lightbox
      // opens.
      setDoc((prev) => {
        if (prev) {
          try {
            prev.destroy();
          } catch {
            // destroy is best-effort — the page is going away
          }
        }
        return null;
      });
    };
  }, [load]);

  const goToPage = useCallback(
    async (page: number) => {
      if (!doc) return null;
      const target = Math.min(Math.max(1, page), doc.numPages);
      return doc.getPage(target);
    },
    [doc],
  );

  return { doc, isLoading, error, numPages, goToPage, reload: load };
}
