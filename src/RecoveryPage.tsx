import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, CheckSquare, Clock3, FileWarning, Film, FolderSearch2, Library as LibraryIcon, ListChecks, LoaderCircle, Play, RotateCcw, Search, SlidersHorizontal, Square, Trash2, X } from "lucide-react";
import { api } from "./api";
import { PlayerViewer } from "./Player";
import "./library.css";

type Recovered = {
  itemId: string; title: string; performer: string; source: string;
  duration: number; width: number; height: number; size: number; recoveredAt: string; cataloged: boolean;
};
type RecoveryAction = "rescued" | "deleted" | "skipped" | "failed";
type RecoveryReport = {
  scanned: number; rescued: number; deleted: number; skipped: number; failed: number; leftover: number; dryRun: boolean;
  items: Array<{ itemId: string; action: RecoveryAction }>;
};
type CatalogResult = { cataloged: boolean; reason?: string; storagePath?: string };
type ArchiveOutcome = { id: string; cataloged: boolean; reason?: string; failed?: boolean };
type RecoveryStatus = "" | "waiting" | "in-library";
type RecoverySort = "recent" | "oldest" | "largest" | "title";

function formatBytes(bytes = 0) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"]; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}
function formatDuration(seconds = 0) {
  if (!seconds) return "";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600); const minutes = Math.floor((whole % 3600) / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}` : `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}
function mediaDateLabel(value?: string): string {
  if (!value) return "Unknown date";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
function recoveredStamp(value?: string): number {
  const stamp = new Date(value ?? "").getTime();
  return Number.isNaN(stamp) ? 0 : stamp;
}
function qualityLabel(item: Pick<Recovered, "width" | "height">): string {
  if (item.width > 0 && item.height > 0) return `${Math.min(item.width, item.height)}p`;
  return "MP4";
}
function sourceDomain(value = ""): string {
  const source = value.trim();
  if (!source) return "";
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(source) ? source : `https://${source}`);
    return parsed.hostname.replace(/^www\./i, "") || source;
  } catch { return source; }
}
function playUrl(itemId: string) { return `/recovery?play=${encodeURIComponent(itemId)}`; }
function internalLink(event: React.MouseEvent, action: () => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); action();
}

/** Recovered recordings are playable through the same player as the library, but their stream and
 *  poster come from the recovery folder, so they are adapted to the media shape the viewer expects. */
function previewMedia(item: Recovered) {
  return {
    id: item.itemId, relativePath: `.recording-recovery/${item.itemId}/recovered.mp4`, kind: "video" as const,
    title: item.title, performer: item.performer, source: item.source, extension: ".mp4", mimeType: "video/mp4",
    size: item.size, modifiedAt: item.recoveredAt, duration: item.duration, width: item.width, height: item.height,
    favorite: false, progressSeconds: 0, completed: false, viewCount: 0,
    thumbnailUrl: `/api/recovery/${encodeURIComponent(item.itemId)}/thumbnail`, previewUrl: "",
    streamUrl: `/api/recovery/${encodeURIComponent(item.itemId)}/stream`,
  };
}

export function RecoveryPage({ setNotice }: { setNotice: (text: string) => void }) {
  const [items, setItems] = useState<Recovered[] | null>(null);
  const [search, setSearch] = useState(() => window.location.search);
  const [recovering, setRecovering] = useState(false);
  const [archiving, setArchiving] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RecoveryStatus>("");
  const [sort, setSort] = useState<RecoverySort>("recent");

  const load = useCallback(async () => api<Recovered[]>("/api/recovery"), []);
  useEffect(() => { void load().then(setItems).catch((error) => setNotice(error instanceof Error ? error.message : String(error))); }, [load, setNotice]);
  useEffect(() => {
    const changed = () => setSearch(window.location.search);
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  /** Selection never survives a filter change, so Archive/Delete can only ever touch visible rows. */
  useEffect(() => { setSelectedIds(new Set()); }, [query, status, sort]);

  const playId = useMemo(() => new URLSearchParams(search).get("play"), [search]);
  const preview = useMemo(() => items?.find((item) => item.itemId === playId) ?? null, [items, playId]);

  const waiting = useMemo(() => (items ?? []).filter((item) => !item.cataloged).length, [items]);
  const inLibrary = (items?.length ?? 0) - waiting;
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    const matched = (items ?? []).filter((item) => {
      if (status === "waiting" && item.cataloged) return false;
      if (status === "in-library" && !item.cataloged) return false;
      if (!term) return true;
      return `${item.title} ${item.performer} ${item.source}`.toLowerCase().includes(term);
    });
    const order = [...matched];
    if (sort === "largest") order.sort((a, b) => b.size - a.size);
    else if (sort === "title") order.sort((a, b) => a.title.localeCompare(b.title));
    else order.sort((a, b) => (sort === "oldest" ? 1 : -1) * (recoveredStamp(a.recoveredAt) - recoveredStamp(b.recoveredAt)));
    return order;
  }, [items, query, status, sort]);

  const openPreview = (item: Recovered) => {
    window.history.pushState({}, "", playUrl(item.itemId));
    setSearch(window.location.search);
  };
  const closePreview = () => { window.history.pushState({}, "", "/recovery"); setSearch(""); };

  const refresh = async () => { setItems(await load()); };

  const runRecovery = async () => {
    setRecovering(true);
    try {
      const report = await api<RecoveryReport>("/api/maintenance/cleanup-residual-ts", { method: "POST", body: JSON.stringify({ execute: true }) });
      await refresh();
      const leftover = report.leftover ? ` · ${report.leftover} rescued file${report.leftover === 1 ? "" : "s"} could not be removed from staging` : "";
      if (!report.scanned) setNotice("Recovery finished — no leftover captures were found.");
      else setNotice(`Recovery finished — ${report.rescued} recording${report.rescued === 1 ? "" : "s"} rescued, ${report.deleted} leftover${report.deleted === 1 ? "" : "s"} cleaned, ${report.skipped} skipped${report.failed ? `, ${report.failed} failed` : ""}${leftover} (scanned ${report.scanned}).`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setRecovering(false); }
  };

  const archiveOne = async (itemId: string) => {
    setArchiving((current) => new Set(current).add(itemId));
    try {
      const result = await api<CatalogResult>(`/api/recovery/${encodeURIComponent(itemId)}/catalog`, { method: "POST" });
      await refresh();
      setSelectedIds((current) => { const next = new Set(current); next.delete(itemId); return next; });
      if (result.cataloged) setNotice("Recording archived into your library.");
      else if (result.reason === "duplicate") setNotice("An identical file already exists — the recovered copy was removed.");
      else if (result.reason === "already-completed") setNotice("This recording was already in your library — the recovered copy was removed.");
      else setNotice("Recording cleared from the recovery folder.");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setArchiving((current) => { const next = new Set(current); next.delete(itemId); return next; }); }
  };

  const archiveSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setArchiving(new Set(ids));
    try {
      const outcomes: ArchiveOutcome[] = await Promise.all(ids.map(async (id) => {
        try { return { id, ...(await api<CatalogResult>(`/api/recovery/${encodeURIComponent(id)}/catalog`, { method: "POST" })) }; }
        catch (error) { return { id, cataloged: false, reason: error instanceof Error ? error.message : String(error), failed: true }; }
      }));
      await refresh();
      setSelectedIds(new Set()); setSelectionMode(false);
      const archived = outcomes.filter((outcome) => outcome.cataloged).length;
      const duplicates = outcomes.filter((outcome) => outcome.reason === "duplicate").length;
      const already = outcomes.filter((outcome) => outcome.reason === "already-completed").length;
      const failed = outcomes.filter((outcome) => outcome.failed).length;
      const parts = [`${archived} archived`];
      if (duplicates) parts.push(`${duplicates} duplicate`);
      if (already) parts.push(`${already} already in library`);
      if (failed) parts.push(`${failed} failed`);
      setNotice(parts.join(" · "));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setArchiving(new Set()); }
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length || !window.confirm(`Permanently delete ${ids.length} recovered ${ids.length === 1 ? "file" : "files"}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      const result = await api<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>("/api/recovery", { method: "DELETE", body: JSON.stringify({ itemIds: ids }) });
      await refresh();
      setSelectedIds(new Set()); if (!result.failed.length) setSelectionMode(false);
      const failed = result.failed.length;
      setNotice(`${result.deleted.length} recovered ${result.deleted.length === 1 ? "file" : "files"} permanently deleted${failed ? ` · ${failed} failed` : ""}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setDeleting(false); }
  };

  const toggleSelected = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectAll = () => setSelectedIds((current) => visible.every((item) => current.has(item.itemId)) ? new Set() : new Set(visible.map((item) => item.itemId)));
  const cancelSelection = () => { setSelectionMode(false); setSelectedIds(new Set()); };

  if (preview) return <PlayerViewer media={previewMedia(preview)} context={{}} autoStart={false} readOnly
    close={closePreview} favorite={() => {}} advance={() => {}} setNotice={setNotice}/>;

  const total = items?.length ?? 0;
  const allSelected = Boolean(visible.length) && visible.every((item) => selectedIds.has(item.itemId));
  const filteredOut = Boolean(total) && !visible.length;
  return <div className="library-mode recovery-shell">
    <section className="library-page recovery-page">
      <div className="library-intro">
        <div><p>COLLECT</p><h2>Recovery</h2><span>{total} rescued {total === 1 ? "recording" : "recordings"} kept outside the library</span></div>
        <div className="selection-actions">
          <button className="primary" disabled={recovering} onClick={() => void runRecovery()}>{recovering ? <LoaderCircle className="spin"/> : <RotateCcw/>}{recovering ? "Recovering…" : "Recovery"}</button>
          <button className="quiet" disabled={!selectedIds.size || Boolean(archiving.size)} onClick={() => void archiveSelected()}><Archive/>Archive{selectedIds.size ? ` (${selectedIds.size})` : ""}</button>
          {selectionMode ? <><span>{selectedIds.size} selected</span><button className="quiet" onClick={selectAll}>{allSelected ? "Clear" : "Select all"}</button><button className="delete-selection" disabled={!selectedIds.size || deleting} onClick={() => void deleteSelected()}>{deleting ? <LoaderCircle className="spin"/> : <Trash2/>}Delete</button><button className="quiet" disabled={deleting} onClick={cancelSelection}><X/>Cancel</button></> : <button className="quiet" disabled={!total} onClick={() => setSelectionMode(true)}><ListChecks/>Select</button>}
        </div>
      </div>
      <div className="filters recovery-filters">
        <label><Search/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search rescued recordings…" aria-label="Search rescued recordings"/></label>
        <div className="filter-buttons">
          <button className={status ? "" : "active"} onClick={() => setStatus("")}>All</button>
          <button className={status === "waiting" ? "active" : ""} onClick={() => setStatus("waiting")}><Clock3/>Waiting {waiting}</button>
          <button className={status === "in-library" ? "active" : ""} onClick={() => setStatus("in-library")}><LibraryIcon/>In library {inLibrary}</button>
        </div>
        <label className="sort"><SlidersHorizontal/><select aria-label="Sort rescued recordings" value={sort} onChange={(event) => setSort(event.target.value as RecoverySort)}><option value="recent">Recently recovered</option><option value="oldest">Oldest first</option><option value="largest">Largest files</option><option value="title">Title A–Z</option></select></label>
      </div>
      <p className="recovery-hint"><FileWarning/><span><b>Recovery</b> scans staging and the recovery folder for leftover captures, remuxes playable ones into <code>recovered.mp4</code> and deletes the unplayable ones. <b>Archive</b> moves a rescued file back into its canonical library path. Files stay out of your library until you archive them.</span></p>
      {items === null ? <div className="loading"><LoaderCircle className="spin"/>Loading rescued recordings…</div>
        : visible.length ? <div className={`media-grid ${selectionMode ? "selecting" : ""}`}>{visible.map((item) => <RecoveryCard key={item.itemId} item={item} selectionMode={selectionMode} selected={selectedIds.has(item.itemId)} toggleSelected={toggleSelected} open={openPreview} archive={archiveOne} archiving={archiving.has(item.itemId)}/>)}</div>
        : <div className="empty-state"><FolderSearch2/><h3>{filteredOut ? "No recordings match" : "Nothing to recover"}</h3><p>{filteredOut ? "Adjust the search or filters to see your rescued recordings again." : "Run Recovery after an interrupted recording to look for leftover captures."}</p></div>}
    </section>
  </div>;
}

function RecoveryCard({ item, selectionMode, selected, toggleSelected, open, archive, archiving }: {
  item: Recovered; selectionMode: boolean; selected: boolean; toggleSelected: (id: string) => void;
  open: (item: Recovered) => void; archive: (id: string) => void; archiving: boolean;
}) {
  const href = playUrl(item.itemId); const activate = () => selectionMode ? toggleSelected(item.itemId) : open(item);
  return <article className={`media-card ${selected ? "selected" : ""}`}>
    {selectionMode && <button className="selection-control" aria-label={selected ? `Deselect ${item.title}` : `Select ${item.title}`} aria-pressed={selected} onClick={() => toggleSelected(item.itemId)}>{selected ? <CheckSquare/> : <Square/>}</button>}
    <a className="poster" href={href} aria-label={selectionMode ? `${selected ? "Deselect" : "Select"} ${item.title}` : `Preview ${item.title}`} onClick={(event) => internalLink(event, activate)}>
      <span className="media-art"><img className="poster-still" src={`/api/recovery/${encodeURIComponent(item.itemId)}/thumbnail`} alt="" loading="lazy" decoding="async"/></span>
      <span className="play"><Play/></span><span className="type"><Film/></span>
      {item.duration > 0 && <time>{formatDuration(item.duration)}</time>}
      {item.cataloged && <span className="watch-label complete">In library</span>}
    </a>
    <div className="media-copy">
      <a className="media-title" href={href} onClick={(event) => internalLink(event, activate)}>{item.title}</a>
      <p>{item.performer || "Unsorted"}{item.source ? ` - ${sourceDomain(item.source)}` : ""} · {formatBytes(item.size)}</p>
      <div className="media-facts"><span>{qualityLabel(item)}</span><i/><time dateTime={item.recoveredAt}>{mediaDateLabel(item.recoveredAt)}</time></div>
    </div>
    {!selectionMode && <button className="archive-button" aria-label={`Archive ${item.title}`} title="Archive — move into the library" disabled={archiving} onClick={() => archive(item.itemId)}>{archiving ? <LoaderCircle className="spin"/> : <Archive/>}</button>}
  </article>;
}
