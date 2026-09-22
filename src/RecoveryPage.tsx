import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, CheckSquare, Clock3, FileWarning, Film, FolderSearch2, Library as LibraryIcon, ListChecks, LoaderCircle, Play, RotateCcw, Search, SlidersHorizontal, Square, Trash2, X } from "lucide-react";
import { api } from "./api";
import { PlayerViewer } from "./Player";
import "./library.css";

type Recovered = {
  itemId: string; title: string; performer: string; source: string;
  duration: number; width: number; height: number; size: number; recoveredAt: string; cataloged: boolean;
};
type CatalogResult = { cataloged: boolean; reason?: string; storagePath?: string };
type ArchiveOutcome = { id: string; cataloged: boolean; reason?: string; failed?: boolean };
type RecoveryStatus = "" | "waiting" | "in-library";
type RecoverySort = "recent" | "oldest" | "largest" | "title";
/** A single in-flight page job (archive or delete on the rescued files). While `job` is not null the
 *  action buttons are locked so two jobs can never overlap and corrupt the same staged files. The
 *  Recovery sweep is deliberately not one of these: it runs in the background, so it is watched on
 *  the Activity page rather than holding this page hostage. */
type Job = { kind: "archive" | "delete"; label: string; total: number; done: number; current?: string; indeterminate: boolean; startedAt: number };
/** A sweep can outlast a slow box's patience, so the watcher is generous: 900 polls at 2s. */
const RECOVERY_WATCH_INTERVAL_MS = 2000;
const RECOVERY_WATCH_ATTEMPTS = 900;
type TaskSnapshot = { id: string; status: string; error?: string; result?: Record<string, unknown> };

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
  const [job, setJob] = useState<Job | null>(null);
  const [recoveryTaskId, setRecoveryTaskId] = useState<string | null>(null);
  const busy = job !== null;
  const [elapsed, setElapsed] = useState(0);
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
  useEffect(() => {
    if (!job) { setElapsed(0); return; }
    const startedAt = job.startedAt;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [job]);

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
  const titleOf = (id: string) => items?.find((item) => item.itemId === id)?.title ?? id;

  /**
   * Pick up whatever the sweep rescued once it reaches a terminal state. The sweep is minutes of
   * ffmpeg work over possibly dozens of folders, so its real progress bar lives on the Activity page
   * next to the recordings; all this page does is leave a notice and refresh the list afterwards.
   */
  const watchRecovery = async (taskId: string) => {
    for (let attempt = 0; attempt < RECOVERY_WATCH_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, RECOVERY_WATCH_INTERVAL_MS));
      let task: TaskSnapshot;
      try { ({ task } = await api<{ task: TaskSnapshot }>(`/api/tasks/${taskId}`)); }
      catch (error) {
        // An expired record means the sweep finished faster than the first poll; refresh so whatever
        // it rescued shows up, and stop. Anything else is transient and worth another poll.
        if (error instanceof Error && /not found/i.test(error.message)) { setRecoveryTaskId(null); await refresh(); return; }
        continue;
      }
      if (task.status === "queued" || task.status === "running") continue;
      setRecoveryTaskId(null);
      await refresh();
      if (task.status === "failed") { setNotice(`Recovery failed — ${task.error ?? "unknown error"}`); return; }
      if (task.status === "cancelled") { setNotice("Recovery stopped — anything already rescued is listed below."); return; }
      const count = (key: string) => Number(task.result?.[key] ?? 0) || 0;
      if (!count("scanned")) { setNotice("Recovery finished — no leftover captures were found."); return; }
      const leftover = count("leftover") ? ` · ${count("leftover")} rescued file${count("leftover") === 1 ? "" : "s"} could not be removed from staging` : "";
      const failed = count("failed") ? `, ${count("failed")} failed` : "";
      setNotice(`Recovery finished — ${count("rescued")} recording${count("rescued") === 1 ? "" : "s"} rescued, ${count("deleted")} leftover${count("deleted") === 1 ? "" : "s"} cleaned, ${count("skipped")} skipped${failed}${leftover} (scanned ${count("scanned")}).`);
      return;
    }
    setRecoveryTaskId(null);
  };

  /**
   * The Recovery button only starts the sweep. The request answers as soon as the job is registered,
   * which is what keeps this page responsive on a 1-core box: the remuxing shows up on the Activity
   * page, and the finished files appear here when the sweep completes.
   */
  const runRecovery = async () => {
    if (busy || recoveryTaskId) return;
    try {
      const { taskId } = await api<{ taskId: string }>("/api/maintenance/cleanup-residual-ts", { method: "POST", body: JSON.stringify({ execute: true }) });
      setRecoveryTaskId(taskId);
      setNotice("Recovery started — follow the progress on the Activity page.");
      void watchRecovery(taskId);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
  };

  const archiveOne = async (itemId: string) => {
    if (busy) return;
    setJob({ kind: "archive", label: "Archiving…", total: 1, done: 0, current: titleOf(itemId), indeterminate: true, startedAt: Date.now() });
    try {
      const result = await api<CatalogResult>(`/api/recovery/${encodeURIComponent(itemId)}/catalog`, { method: "POST" });
      await refresh();
      setSelectedIds((current) => { const next = new Set(current); next.delete(itemId); return next; });
      if (result.cataloged) setNotice("Recording archived into your library.");
      else if (result.reason === "duplicate") setNotice("An identical file already exists — the recovered copy was removed.");
      else if (result.reason === "already-completed") setNotice("This recording was already in your library — the recovered copy was removed.");
      else setNotice("Recording cleared from the recovery folder.");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setJob(null); }
  };

  /** Archive the current selection one item at a time so the progress bar can show real done/total. */
  const archiveSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length || busy) return;
    setJob({ kind: "archive", label: "Archiving…", total: ids.length, done: 0, indeterminate: false, startedAt: Date.now() });
    const outcomes: ArchiveOutcome[] = [];
    try {
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        setJob((current) => current && ({ ...current, done: index, current: titleOf(id) }));
        try { outcomes.push({ id, ...(await api<CatalogResult>(`/api/recovery/${encodeURIComponent(id)}/catalog`, { method: "POST" })) }); }
        catch (error) { outcomes.push({ id, cataloged: false, reason: error instanceof Error ? error.message : String(error), failed: true }); }
        setJob((current) => current && ({ ...current, done: index + 1 }));
      }
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
    finally { setJob(null); }
  };

  /** Delete the current selection one item at a time so the progress bar can show real done/total. */
  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (!ids.length || busy) return;
    if (!window.confirm(`Permanently delete ${ids.length} recovered ${ids.length === 1 ? "file" : "files"}? This cannot be undone.`)) return;
    setJob({ kind: "delete", label: "Deleting…", total: ids.length, done: 0, indeterminate: false, startedAt: Date.now() });
    const deleted: string[] = []; const failed: Array<{ id: string; error: string }> = [];
    try {
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        setJob((current) => current && ({ ...current, done: index, current: titleOf(id) }));
        try {
          const result = await api<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>("/api/recovery", { method: "DELETE", body: JSON.stringify({ itemIds: [id] }) });
          deleted.push(...result.deleted); failed.push(...result.failed);
        } catch (error) { failed.push({ id, error: error instanceof Error ? error.message : String(error) }); }
        setJob((current) => current && ({ ...current, done: index + 1 }));
      }
      await refresh();
      setSelectedIds(new Set()); if (!failed.length) setSelectionMode(false);
      setNotice(`${deleted.length} recovered ${deleted.length === 1 ? "file" : "files"} permanently deleted${failed.length ? ` · ${failed.length} failed` : ""}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setJob(null); }
  };

  const toggleSelected = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectAll = () => setSelectedIds((current) => visible.every((item) => current.has(item.itemId)) ? new Set() : new Set(visible.map((item) => item.itemId)));
  const cancelSelection = () => { setSelectionMode(false); setSelectedIds(new Set()); };

  // The playback view renders outside the recovery shell, so it still needs the `.library-mode`
  // wrapper: library.css is @scope'd to it, and without it the Back button falls back to the
  // browser's default light button style (light pill with light text — unreadable).
  if (preview) return <div className="library-mode"><PlayerViewer media={previewMedia(preview)} context={{}} autoStart={false} readOnly
    close={closePreview} favorite={() => {}} advance={() => {}} setNotice={setNotice}/></div>;

  const total = items?.length ?? 0;
  const allSelected = Boolean(visible.length) && visible.every((item) => selectedIds.has(item.itemId));
  const filteredOut = Boolean(total) && !visible.length;
  const recovering = recoveryTaskId !== null;
  const deleting = busy && job?.kind === "delete";
  return <div className={`library-mode recovery-shell${busy ? " recovery-busy" : ""}`}>
    <section className="library-page recovery-page">
      <div className="library-intro">
        <div><p>COLLECT</p><h2>Recovery</h2><span>{total} rescued {total === 1 ? "recording" : "recordings"} kept outside the library</span></div>
        <div className="selection-actions">
          <button className="primary" disabled={busy || recovering} onClick={() => void runRecovery()}>{recovering ? <LoaderCircle className="spin"/> : <RotateCcw/>}{recovering ? "Recovering…" : "Recovery"}</button>
          <button className="quiet" disabled={busy || !selectedIds.size} onClick={() => void archiveSelected()}><Archive/>Archive{selectedIds.size ? ` (${selectedIds.size})` : ""}</button>
          {selectionMode ? <><span>{selectedIds.size} selected</span><button className="quiet" disabled={busy} onClick={selectAll}>{allSelected ? "Clear" : "Select all"}</button><button className="delete-selection" disabled={busy || !selectedIds.size} onClick={() => void deleteSelected()}>{deleting ? <LoaderCircle className="spin"/> : <Trash2/>}Delete</button><button className="quiet" disabled={busy} onClick={cancelSelection}><X/>Cancel</button></> : <button className="quiet" disabled={busy || !total} onClick={() => setSelectionMode(true)}><ListChecks/>Select</button>}
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
      {job && <RecoveryJobBar job={job} elapsed={elapsed}/>}
      {items === null ? <div className="loading"><LoaderCircle className="spin"/>Loading rescued recordings…</div>
        : visible.length ? <div className={`media-grid ${selectionMode ? "selecting" : ""}`}>{visible.map((item) => <RecoveryCard key={item.itemId} item={item} selectionMode={selectionMode} selected={selectedIds.has(item.itemId)} busy={busy} toggleSelected={toggleSelected} open={openPreview} archive={archiveOne}/>)}</div>
        : <div className="empty-state"><FolderSearch2/><h3>{filteredOut ? "No recordings match" : "Nothing to recover"}</h3><p>{filteredOut ? "Adjust the search or filters to see your rescued recordings again." : "Run Recovery after an interrupted recording to look for leftover captures."}</p></div>}
    </section>
  </div>;
}

function RecoveryCard({ item, selectionMode, selected, busy, toggleSelected, open, archive }: {
  item: Recovered; selectionMode: boolean; selected: boolean; busy: boolean; toggleSelected: (id: string) => void;
  open: (item: Recovered) => void; archive: (id: string) => void;
}) {
  const href = playUrl(item.itemId); const activate = () => selectionMode ? toggleSelected(item.itemId) : open(item);
  return <article className={`media-card ${selected ? "selected" : ""}`}>
    {selectionMode && <button className="selection-control" aria-label={selected ? `Deselect ${item.title}` : `Select ${item.title}`} aria-pressed={selected} disabled={busy} onClick={() => toggleSelected(item.itemId)}>{selected ? <CheckSquare/> : <Square/>}</button>}
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
    {!selectionMode && <button className="archive-button" aria-label={`Archive ${item.title}`} title="Archive — move into the library" disabled={busy} onClick={() => archive(item.itemId)}><Archive/></button>}
  </article>;
}

function RecoveryJobBar({ job, elapsed }: { job: Job; elapsed: number }) {
  const percent = job.indeterminate ? 0 : Math.round((job.done / Math.max(1, job.total)) * 100);
  const time = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  return <div className="recovery-job" role="status" aria-live="polite">
    <LoaderCircle className="spin recovery-job-icon"/>
    <div className="recovery-job-body">
      <div className="recovery-job-label">{job.label}</div>
      <div className="recovery-job-meta">
        {job.indeterminate
          ? `Running for ${time} — this step can take several minutes, keep this tab open.`
          : `${job.done} / ${job.total} done${job.current ? ` · ${job.current}` : ""} · ${time}`}
      </div>
      <div className={`recovery-progress${job.indeterminate ? " indeterminate" : ""}`}><i style={job.indeterminate ? undefined : { width: `${percent}%` }}/></div>
    </div>
  </div>;
}
