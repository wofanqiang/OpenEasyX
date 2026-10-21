import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, EyeOff, FileWarning, FolderSearch2, LoaderCircle, RotateCcw, Search, Trash2 } from "lucide-react";
import { api } from "./api";
import "./library.css";

/** A row the library is hiding. Deliberately not a `Media`: it has no working thumbnail or stream
 *  URL, because every one of those routes filters hidden rows out. */
type HiddenMedia = {
  id: string; relativePath: string; kind: "video" | "image"; title: string; performer: string; source: string;
  extension: string; size: number; modifiedAt: string; addedAt: string;
  duration: number; width: number; height: number;
};
type HiddenPage = { items: HiddenMedia[]; total: number; page: number; pageSize: number; pages: number };

const PAGE_SIZE = 48;
const SEARCH_DEBOUNCE_MS = 250;

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"]; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}
function mediaDateLabel(value?: string): string {
  if (!value) return "Unknown date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
function qualityLabel(item: HiddenMedia): string {
  if (item.width > 0 && item.height > 0) return item.kind === "video" ? `${Math.min(item.width, item.height)}p` : `${item.width}×${item.height}`;
  return item.extension.replace(/^\./, "").toUpperCase() || (item.kind === "video" ? "Video" : "Photo");
}
function sourceDomain(value = "") {
  const source = value.trim();
  if (!source) return "";
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(source) ? source : `https://${source}`);
    return parsed.hostname.replace(/^www\./i, "") || source;
  } catch { return source; }
}

/**
 * The way back out of a hidden entry.
 *
 * Every listing filters `playable=1`, and an entry is hidden exactly when a read failed, so it had
 * no visible surface at all: the only way to see or clear one was to edit the database over SSH.
 * Restore re-checks the file first, because putting an unreadable entry back would just hide it
 * again on the next visit.
 *
 * Paging and search are server-side: filtering one page client-side would answer "nothing matches"
 * for an entry that is simply on another page.
 */
export function HiddenMediaPage({ setNotice, refresh }: { setNotice: (text: string) => void; refresh: () => void }) {
  const [result, setResult] = useState<HiddenPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState(1);
  // A response for an older query must never overwrite a newer one.
  const requestId = useRef(0);

  const load = useCallback(async (targetPage: number, term: string) => {
    const id = requestId.current + 1;
    requestId.current = id;
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(PAGE_SIZE) });
    if (term.trim()) params.set("q", term.trim());
    const next = await api<HiddenPage>(`/api/library/hidden?${params.toString()}`);
    if (requestId.current === id) setResult(next);
  }, []);

  useEffect(() => {
    void load(page, applied).catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [load, page, applied, setNotice]);

  useEffect(() => {
    const timer = window.setTimeout(() => { setPage(1); setApplied(query); }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  /** Reloads after a row leaves this page; a page that is now past the end steps back. */
  const reloadAfterRemoval = async () => {
    const remaining = (result?.items.length ?? 1) - 1;
    await load(remaining > 0 ? page : Math.max(1, page - 1), applied);
    refresh();
  };

  const restore = async (item: HiddenMedia) => {
    setBusy(item.id);
    try {
      await api(`/api/library/hidden/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
      setNotice(`Restored “${item.title}” to the library.`);
      await reloadAfterRemoval();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const remove = async (item: HiddenMedia) => {
    if (!window.confirm(`Permanently remove “${item.title}”? Its file is deleted if it still exists.`)) return;
    setBusy(item.id);
    try {
      const outcome = await api<{ fileDeleted: boolean }>(`/api/library/hidden/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      setNotice(outcome.fileDeleted ? `Deleted “${item.title}” and its file.` : `“${item.title}” was already gone — the entry is cleared.`);
      await reloadAfterRemoval();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const total = result?.total ?? 0;
  const searching = applied.trim().length > 0;
  const items = useMemo(() => result?.items ?? [], [result]);
  return <section className="library-page">
    <div className="library-intro">
      <div><p>COLLECTION</p><h2>Hidden</h2><span>{total} {total === 1 ? "entry" : "entries"} hidden from every listing{searching ? ` · filtered by “${applied.trim()}”` : ""}</span></div>
    </div>
    <div className="filters">
      <label><Search/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search hidden entries…" aria-label="Search hidden entries"/></label>
    </div>
    <p className="recovery-hint"><FileWarning/><span>An entry lands here when the library could not read its file — usually a recording with no video track, or a file that disappeared outside the app. <b>Restore</b> checks the file is readable before putting it back; <b>Remove</b> clears the entry and deletes the file if it is still there.</span></p>
    {result === null ? <div className="loading"><LoaderCircle className="spin"/>Loading hidden entries…</div>
      : items.length ? <>
          <div className="media-grid">{items.map((item) => <article className="media-card" key={item.id}>
            <span className="poster" aria-hidden="true"><span className="media-art"><EyeOff/></span><span className="type">{item.kind === "video" ? "FILM" : "IMG"}</span>
              {item.duration > 0 && <time>{Math.floor(item.duration / 60)}:{String(Math.floor(item.duration % 60)).padStart(2, "0")}</time>}
            </span>
            <div className="media-copy">
              <span className="media-title">{item.title}</span>
              <p>{item.performer || "Unsorted"}{item.source ? ` - ${sourceDomain(item.source)}` : ""} · {formatBytes(item.size)}</p>
              <div className="media-facts"><span>{qualityLabel(item)}</span><i/><time dateTime={item.modifiedAt}>{mediaDateLabel(item.modifiedAt)}</time></div>
              <div className="selection-actions">
                <button className="quiet" disabled={busy === item.id} onClick={() => void restore(item)}>{busy === item.id ? <LoaderCircle className="spin"/> : <RotateCcw/>}Restore</button>
                <button className="delete-selection" disabled={busy === item.id} onClick={() => void remove(item)}><Trash2/>Remove</button>
              </div>
            </div>
          </article>)}</div>
          {(result?.pages ?? 1) > 1 && <div className="pagination">
            <button disabled={page <= 1 || busy !== null} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft/>Previous</button>
            <span>Page {result?.page ?? page} of {result?.pages ?? 1} · {total} hidden</span>
            <button disabled={page >= (result?.pages ?? 1) || busy !== null} onClick={() => setPage((current) => current + 1)}>Next<ChevronRight/></button>
          </div>}
        </>
      : <div className="empty-state"><FolderSearch2/><h3>{searching ? "No entries match" : "Nothing is hidden"}</h3><p>{searching ? "Adjust the search to see the hidden entries again." : "Every indexed file is readable, so the library has nothing to hide."}</p></div>}
  </section>;
}
