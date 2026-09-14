import React, { useEffect, useMemo, useRef, useState } from "react";
import type HlsInstance from "hls.js";
import { AlertTriangle, ArrowLeft, Download, Eye, LoaderCircle, Maximize, Minimize, Pause, Play, Radio, RefreshCw, Search, Server, Star, UserPlus, Users, Volume2, VolumeX } from "lucide-react";
import { api } from "./api";
import { loadPlayerAudio, savePlayerAudio } from "./player-audio";
import { monitorVideoStalls } from "./video-stall-recovery";
import { usePlayerFullscreen } from "./player-fullscreen";
import "./player.css";
import "./watch-page.css";
import "./live-player.css";

export type LiveCam = {
  id: string; username: string; title?: string; pageUrl: string; thumbnailUrl?: string; viewers?: number; age?: number; gender?: string; tags?: string[];
  providerId: string; providerName: string; favorite?: boolean; online?: boolean; performerId?: string; statusUnavailable?: boolean;
};
type LiveCamFavorite = Pick<LiveCam, "providerId" | "id" | "username" | "title" | "pageUrl" | "thumbnailUrl">;
type Provider = { id: string; name: string; ok: boolean; count: number; pending?: boolean; error?: string; warning?: string };
type LiveCamResult = { available: boolean; reason?: string; items: LiveCam[]; total: number; page: number; pageSize: number; pages: number; providers: Provider[]; complete?: boolean };

export function mergeLiveCamRefresh(previous: LiveCamResult | null, next: LiveCamResult): LiveCamResult {
  if (!previous || next.complete) return next;
  const pending = new Set(next.providers.filter((provider) => provider.pending).map((provider) => provider.id));
  const retained = previous.items.filter((cam) => pending.has(cam.providerId));
  const total = next.total + previous.providers.filter((provider) => pending.has(provider.id)).reduce((sum, provider) => sum + provider.count, 0);
  return { ...next, total, pages: Math.max(1, Math.ceil(total / next.pageSize)),
    items: [...next.items, ...retained].sort((a, b) => Number(!b.statusUnavailable && b.online !== false) - Number(!a.statusUnavailable && a.online !== false) || (b.viewers ?? 0) - (a.viewers ?? 0)).slice(0, next.pageSize),
  };
}

// A provider that never answers would otherwise be advertised as "loading…" forever: the stream
// guard abandons a hung provider without a terminal status, so the last snapshot is patched to
// report it as unavailable. Rooms that did arrive stay on screen.
export function markLiveCamInterrupted(result: LiveCamResult): LiveCamResult {
  if (!result.providers.some((provider) => provider.pending)) return result;
  return {
    ...result,
    providers: result.providers.map((provider) => provider.pending
      ? { ...provider, pending: false, ok: false, error: "Did not respond in time. Refresh to try again." }
      : provider),
  };
}

export type LiveCamPreset = { query?: string; providerId?: string; gender?: "female" | "male" | "couple" | "trans" | ""; favoritesOnly?: boolean; page?: number };

export function liveCamPresetFromSearch(search: string, pathname = ""): LiveCamPreset {
  const params = new URLSearchParams(search); const gender = params.get("gender") ?? "";
  return {
    query: params.get("q") ?? "", providerId: params.get("source") ?? "",
    gender: (["female", "male", "couple", "trans"].includes(gender) ? gender : "") as LiveCamPreset["gender"],
    favoritesOnly: pathname === "/live-cam/favorites" || params.get("favorites") === "1",
    page: Math.max(1, Number(params.get("page") ?? 1) || 1),
  };
}

export function liveCamListUrl(preset: LiveCamPreset = {}) {
  const params = new URLSearchParams();
  if (preset.query) params.set("q", preset.query); if (preset.providerId) params.set("source", preset.providerId);
  if (preset.gender) params.set("gender", preset.gender); if ((preset.page ?? 1) > 1) params.set("page", String(preset.page));
  if (preset.favoritesOnly) params.set("favorites", "1");
  const query = params.toString(); return `/live-cam${query ? `?${query}` : ""}`;
}

export function liveCamUrl(cam: Pick<LiveCam, "providerId" | "id">) {
  return `/live-cam/${encodeURIComponent(cam.providerId)}/${encodeURIComponent(cam.id)}`;
}

export function LiveCamUnavailable({ reason }: { reason: string }) {
  return <div className="live-unavailable"><span><Server/></span><p>OPEN EASYX SOURCES</p><h2>No live-cam plugin is ready</h2><small>{reason}</small><code>Plugins → Sources &amp; live</code></div>;
}

export function shouldRecoverNativeLiveMediaError(code: number | undefined, hidden: boolean, foregroundedAt: number, currentTime: number): boolean {
  return code === 4 && (hidden || (foregroundedAt > 0 && currentTime - foregroundedAt < 5_000));
}

export function LivePlayer({ cam, close }: { cam: LiveCam; close: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const player = useRef<HTMLDivElement>(null); const hideTimer = useRef<number | undefined>(undefined);
  const initialAudio = useRef(loadPlayerAudio(undefined, { volume: 1, muted: true }));
  const [streamUrl, setStreamUrl] = useState(""); const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false); const [waiting, setWaiting] = useState(true); const [controls, setControls] = useState(true);
  const [volume, setVolume] = useState(initialAudio.current.volume); const [muted, setMuted] = useState(initialAudio.current.muted);
  const { fullscreen, pageFullscreen, toggleFullscreen } = usePlayerFullscreen(player, video, cam.id);
  const reveal = () => {
    setControls(true); window.clearTimeout(hideTimer.current);
    if (!video.current?.paused) hideTimer.current = window.setTimeout(() => setControls(false), 2400);
  };
  const togglePlayback = () => {
    const element = video.current; if (!element) return;
    if (element.paused) void element.play().catch(() => setWaiting(false)); else element.pause();
  };
  const toggleMute = () => {
    const element = video.current; if (!element) return;
    element.muted = !element.muted; setMuted(element.muted); savePlayerAudio({ volume: element.volume, muted: element.muted });
  };
  useEffect(() => {
    const element = video.current; if (!element) return;
    element.volume = initialAudio.current.volume; element.muted = initialAudio.current.muted;
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (!fullscreen) close(); return; }
      if (["INPUT", "SELECT", "BUTTON"].includes((event.target as HTMLElement).tagName)) return;
      if (event.code === "Space" || event.key.toLowerCase() === "k") { event.preventDefault(); togglePlayback(); }
      else if (event.key.toLowerCase() === "m") toggleMute();
      else if (event.key.toLowerCase() === "f") void toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); window.clearTimeout(hideTimer.current); };
  }, [close, fullscreen, pageFullscreen]);
  useEffect(() => {
    let active = true; setStreamUrl(""); setError(""); setWaiting(true);
    void api<{ streamUrl: string }>("/api/live-cams/stream", { method: "POST", body: JSON.stringify({ providerId: cam.providerId, cam }) })
      .then((result) => { if (active) setStreamUrl(result.streamUrl); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [cam, retry]);
  useEffect(() => {
    const element = video.current; if (!element || !streamUrl) return;
    let hls: HlsInstance | undefined; let active = true; let nativeHls = false; let wasPlayingBeforeHidden = false; let needsNativeRecovery = false; let recoveryQueued = false; let foregroundedAt = 0;
    const recoverNativeStream = () => {
      if (!active || recoveryQueued) return;
      recoveryQueued = true; setError(""); setWaiting(true); setPlaying(false); setRetry((value) => value + 1);
    };
    const mediaError = () => {
      if (!active) return;
      const code = element.error?.code;
      if (nativeHls && shouldRecoverNativeLiveMediaError(code, document.hidden, foregroundedAt, Date.now())) {
        needsNativeRecovery = true; setError(""); setWaiting(true); setPlaying(false);
        if (!document.hidden) recoverNativeStream();
        return;
      }
      setWaiting(false); setPlaying(false);
      setError(code ? `Safari could not play this live stream (media error ${code}).` : "The live stream could not be played.");
    };
    const visibilityChanged = () => {
      if (!nativeHls) return;
      if (document.hidden) { wasPlayingBeforeHidden = !element.paused; return; }
      foregroundedAt = Date.now();
      if (!wasPlayingBeforeHidden) return;
      if (needsNativeRecovery || element.error?.code === 4) { recoverNativeStream(); return; }
      void element.play().catch(() => { if (element.error?.code === 4) recoverNativeStream(); });
    };
    element.addEventListener("error", mediaError);
    document.addEventListener("visibilitychange", visibilityChanged);
    const start = async () => {
      if (element.canPlayType("application/vnd.apple.mpegurl")) {
        nativeHls = true;
        element.src = streamUrl; element.load();
        await element.play().catch((reason) => { if (reason instanceof DOMException && reason.name === "NotAllowedError") setWaiting(false); else throw reason; });
        return;
      }
      const { default: Hls } = await import("hls.js"); if (!active) return;
      if (!Hls.isSupported()) { setError("This browser cannot play HLS live streams."); return; }
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30, highBufferWatchdogPeriod: 2, nudgeMaxRetry: 5 }); hls.loadSource(streamUrl); hls.attachMedia(element);
      hls.on(Hls.Events.MANIFEST_PARSED, () => void element.play().catch(() => setWaiting(false)));
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !hls) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        setError("The live stream stopped or could not be decoded.");
      });
    };
    void start().catch(() => setError("The live player could not be initialized."));
    return () => { active = false; element.removeEventListener("error", mediaError); document.removeEventListener("visibilitychange", visibilityChanged); hls?.destroy(); element.pause(); element.removeAttribute("src"); element.load(); };
  }, [streamUrl]);
  useEffect(() => {
    const element = video.current;
    if (!element || !streamUrl) return;
    return monitorVideoStalls(element);
  }, [streamUrl]);
  return <div className="live-stage live-watch-stage">
    <div ref={player} className={`custom-player live-custom-player ${pageFullscreen ? "page-fullscreen" : ""} ${controls || !playing ? "controls-visible" : "controls-hidden"}`} tabIndex={0} onMouseMove={reveal} onTouchStart={reveal} onMouseLeave={() => playing && setControls(false)}>
      <div className="player-surface" onClick={togglePlayback} onDoubleClick={() => void toggleFullscreen()}><video ref={video} playsInline muted={muted} preload="auto"
        onPlay={() => { setPlaying(true); setWaiting(false); setError(""); reveal(); }} onPlaying={() => { setPlaying(true); setWaiting(false); setError(""); }} onPause={() => { setPlaying(false); setWaiting(false); }} onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)}
        onVolumeChange={(event) => { const audio = { volume: event.currentTarget.volume, muted: event.currentTarget.muted }; setVolume(audio.volume); setMuted(audio.muted); initialAudio.current = audio; savePlayerAudio(audio); }}/></div>
      {waiting && !error && <div className="player-buffering"><LoaderCircle className="spin"/></div>}
      {!playing && !waiting && !error && <button className="player-center-play" onClick={togglePlayback} aria-label="Play live stream"><Play fill="currentColor"/></button>}
      <div className="player-controls" onClick={(event) => event.stopPropagation()}><div className="player-control-row"><div className="player-controls-left">
        <button className="player-icon-button" onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause fill="currentColor"/> : <Play fill="currentColor"/>}</button>
        <div className="player-volume"><button className="player-icon-button" onClick={toggleMute} aria-label={muted || volume === 0 ? "Unmute" : "Mute"}>{muted || volume === 0 ? <VolumeX/> : <Volume2/>}</button><input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => { const element = video.current; if (!element) return; element.volume = Number(event.target.value); element.muted = element.volume === 0; }}/></div>
        <span className="player-live-status"><Radio/><i/>ON AIR</span>
      </div><div className="player-controls-right"><button className="player-icon-button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? <Minimize/> : <Maximize/>}</button></div></div></div>
    </div>
    {!streamUrl && !error && <div className="live-stage-status"><LoaderCircle className="spin"/><b>Opening live stream…</b><small>Open EasyX is resolving a fresh provider URL.</small></div>}
    {error && <div className="live-stage-status error"><AlertTriangle/><b>Live player unavailable</b><small>{error}</small><button className="quiet" onClick={() => setRetry((value) => value + 1)}><RefreshCw/>Try again</button></div>}
  </div>;
}

export function LiveCamRecordButton({ cam }: { cam: LiveCam }) {
  const [recording, setRecording] = useState<"idle" | "queueing" | "queued">("idle"); const [itemId, setItemId] = useState(""); const [recordError, setRecordError] = useState("");
  const record = async () => {
    if (recording !== "idle") return;
    setRecording("queueing"); setRecordError("");
    try { const item = await api<{ itemId: string }>("/api/live-cams/record", { method: "POST", body: JSON.stringify({ providerId: cam.providerId, cam }) }); setItemId(item.itemId); setRecording("queued"); }
    catch (reason) { setRecording("idle"); setRecordError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <>{recording === "queued" ? <a className="quiet" href={`/activity?search=${encodeURIComponent(itemId)}`}><Download/>Manage recording</a> : <button className="quiet" onClick={() => void record()} disabled={recording === "queueing"}><Download/>{recording === "queueing" ? "Queuing…" : "Record live"}</button>}{recordError && <p className="row-error">{recordError}</p>}</>;
}

export function LiveCamFavoriteButton({ cam }: { cam: LiveCam }) {
  const [favorite, setFavorite] = useState(Boolean(cam.favorite)); const [saving, setSaving] = useState(false); const [favoriteError, setFavoriteError] = useState("");
  useEffect(() => setFavorite(Boolean(cam.favorite)), [cam.favorite]);
  const toggle = async () => {
    if (saving) return;
    const next = !favorite; setSaving(true); setFavoriteError("");
    try {
      await api("/api/live-cams/favorites", { method: "PUT", signal: AbortSignal.timeout(15_000), body: JSON.stringify({ providerId: cam.providerId, cam, favorite: next }) });
      setFavorite(next); window.dispatchEvent(new CustomEvent("easyx:live-favorites"));
    } catch (reason) { setFavoriteError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <>{<button className={`quiet live-favorite-button${favorite ? " active" : ""}`} onClick={() => void toggle()} disabled={saving} aria-pressed={favorite}><Star fill={favorite ? "currentColor" : "none"}/>{saving ? "Saving…" : favorite ? "Favorited" : "Favorite creator"}</button>}{favoriteError && <p className="row-error" role="alert">{favoriteError}</p>}</>;
}

export function LiveCamPerformerButton({ cam }: { cam: LiveCam }) {
  const [saving, setSaving] = useState(false); const [performerId, setPerformerId] = useState(cam.performerId ?? ""); const [performerError, setPerformerError] = useState("");
  useEffect(() => setPerformerId(cam.performerId ?? ""), [cam.performerId]);
  const create = async () => {
    if (saving || performerId) return;
    setSaving(true); setPerformerError("");
    try {
      const result = await api<{ performer: { id: string } }>("/api/live-cams/performer", { method: "POST", body: JSON.stringify({ providerId: cam.providerId, cam }) });
      setPerformerId(result.performer.id);
    } catch (reason) { setPerformerError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };
  return <>{performerId
    ? <a className="quiet" href={`/performers?performer=${encodeURIComponent(performerId)}`}><UserPlus/>Manage performer</a>
    : <button className="quiet" onClick={() => void create()} disabled={saving}><UserPlus/>{saving ? "Creating…" : "Add performer"}</button>}
    {performerError && <p className="row-error">{performerError}</p>}</>;
}

export function LiveCamCard({ cam, open }: { cam: LiveCam; open: (cam: LiveCam) => void }) {
  const unavailable = Boolean(cam.statusUnavailable);
  const offline = cam.online === false && !unavailable;
  return <a className={`live-card${offline ? " offline" : ""}`} href={offline ? undefined : liveCamUrl(cam)} aria-disabled={offline || undefined} onClick={(event) => {
    if (offline) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); open(cam);
  }}>
    <span className="live-thumb">{cam.thumbnailUrl ? <img src={cam.thumbnailUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }}/> : <Users/>}{!offline && !unavailable && <em><Eye/>{Number(cam.viewers ?? 0).toLocaleString()}</em>}<strong>{cam.providerName}</strong>{!offline && <span><Play/></span>}</span>
    <span className="live-copy"><b>{cam.username}</b>{cam.age ? <i>{cam.age}</i> : null}<small>{cam.title && cam.title !== cam.username ? cam.title : (cam.tags?.slice(0, 3).map((tag) => `#${tag}`).join(" ") || "Public live broadcast")}</small></span>
  </a>;
}

export function LiveCamViewer({ providerId, camId, close }: { providerId: string; camId: string; close: () => void }) {
  const [cam, setCam] = useState<LiveCam | null>(null); const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setCam(null); setError("");
    void api<LiveCam>(`/api/live-cams/${encodeURIComponent(providerId)}/${encodeURIComponent(camId)}`, { signal: controller.signal })
      .then(setCam).catch((reason) => { if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [providerId, camId]);
  useEffect(() => { if (cam) document.title = `${cam.username} live · Open EasyX`; }, [cam]);
  if (error) return <article className="watch-page"><div className="live-unavailable compact"><span><Radio/></span><h2>This cam is no longer live</h2><small>{error}</small><button className="quiet" onClick={close}><ArrowLeft/>Back to Live Cam</button></div></article>;
  if (!cam) return <article className="watch-page"><div className="loading"><LoaderCircle className="spin"/>Opening live cam…</div></article>;
  return <article className="watch-page live-watch-page">
    <section className="theater-stage"><LivePlayer cam={cam} close={close}/></section>
    <section className="watch-info">
      <div className="watch-heading"><div><span className="watch-eyebrow">LIVE · {cam.providerName}</span><h1>{cam.username}</h1><p>{cam.title && cam.title !== cam.username ? cam.title : "Public live broadcast"}</p></div><div className="watch-actions"><LiveCamPerformerButton cam={cam}/><LiveCamFavoriteButton cam={cam}/><LiveCamRecordButton cam={cam}/><button className="quiet" onClick={close}><ArrowLeft/>Back to Live Cam</button></div></div>
      <div className="watch-meta"><span className="live-meta-on-air"><Radio/>ON AIR</span><span><Eye/>{Number(cam.viewers ?? 0).toLocaleString()} viewers</span><span><Radio/>{cam.providerName}</span>{cam.age ? <span>{cam.age} years old</span> : null}</div>
      {cam.tags?.length ? <div className="live-watch-tags">{cam.tags.slice(0, 12).map((tag) => <span key={tag}>#{tag}</span>)}</div> : null}
    </section>
  </article>;
}

export function LiveCamPage({ preset, route, open }: { preset: LiveCamPreset; route: (preset: LiveCamPreset) => void; open: (cam: LiveCam) => void }) {
  const [result, setResult] = useState<LiveCamResult | null>(null);
  const searchInput = useRef<HTMLInputElement>(null); const searchTimer = useRef<number | undefined>(undefined);
  const [search, setSearch] = useState(preset.query ?? ""); const [providerId, setProviderId] = useState(preset.providerId ?? "");
  const [gender, setGender] = useState<LiveCamPreset["gender"]>(preset.gender ?? ""); const [favoritesOnly, setFavoritesOnly] = useState(Boolean(preset.favoritesOnly)); const [page, setPage] = useState(preset.page ?? 1);
  const [favorites, setFavorites] = useState<LiveCamFavorite[]>([]);
  const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [refresh, setRefresh] = useState(0);
  const resultRef = useRef<LiveCamResult | null>(null);
  const filtersKeyRef = useRef<string | null>(null);
  const pagesFloor = useRef(1); // Keep the highest page count seen for the current filter set so pagination never shrinks mid-refresh.
  const applyResult = (value: LiveCamResult | null) => { resultRef.current = value; setResult(value); };
  const params = useMemo(() => new URLSearchParams({ page: String(page), pageSize: "24", search, providerId, gender: gender ?? "", favoritesOnly: favoritesOnly ? "1" : "" }), [page, search, providerId, gender, favoritesOnly]);
  useEffect(() => {
    const syncFromLocation = () => {
      const next = liveCamPresetFromSearch(window.location.search, window.location.pathname);
      if (searchInput.current) searchInput.current.value = next.query ?? "";
      setSearch(next.query ?? ""); setProviderId(next.providerId ?? ""); setGender(next.gender ?? ""); setFavoritesOnly(Boolean(next.favoritesOnly)); setPage(next.page ?? 1);
    };
    window.addEventListener("popstate", syncFromLocation); window.addEventListener("easyx:navigate", syncFromLocation);
    return () => { window.removeEventListener("popstate", syncFromLocation); window.removeEventListener("easyx:navigate", syncFromLocation); window.clearTimeout(searchTimer.current); };
  }, []);
  useEffect(() => { route({ query: search, providerId, gender, favoritesOnly, page }); }, [search, providerId, gender, favoritesOnly, page]);
  useEffect(() => {
    const loadFavorites = () => void api<{ items: LiveCamFavorite[] }>("/api/live-cams/favorites").then((value) => setFavorites(value.items)).catch(() => undefined);
    loadFavorites(); window.addEventListener("easyx:live-favorites", loadFavorites);
    return () => window.removeEventListener("easyx:live-favorites", loadFavorites);
  }, []);
  // Return to the top of the list whenever the page changes (Next / Previous), so a new page
  // does not open scrolled down where the previous page left off.
  useEffect(() => { window.scrollTo({ top: 0, behavior: "smooth" }); }, [page]);
  useEffect(() => {
    const filtersKey = `${search}\u0000${providerId}\u0000${gender ?? ""}\u0000${favoritesOnly ? "1" : "0"}`;
    const filtersChanged = filtersKeyRef.current !== filtersKey;
    filtersKeyRef.current = filtersKey;
    if (filtersChanged) pagesFloor.current = 1;
    // Soft path (auto-refresh or page change): keep the current grid visible and keep pagination usable.
    // Hard path (filter change or first load): show the loading state.
    const soft = !filtersChanged && resultRef.current !== null;
    if (soft) setRefreshing(true); else { setLoading(true); applyResult(null); }
    const controller = new AbortController(); let events: EventSource | undefined; let complete = false; let gotSnapshot = false; let guard = 0;
    const finalize = () => { window.clearTimeout(guard); events?.close(); setLoading(false); setRefreshing(false); };
    const fallback = () => {
      const abort = new AbortController(); const timeout = window.setTimeout(() => abort.abort(), 60_000);
      void api<LiveCamResult>(`/api/live-cams?${params}`, { signal: abort.signal }).then((value) => {
        if (controller.signal.aborted) return;
        pagesFloor.current = Math.max(pagesFloor.current, value.pages);
        applyResult(value);
      }).catch((reason) => {
        if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) return;
        applyResult({ available: false, reason: reason instanceof Error ? reason.message : String(reason), items: [], total: 0, page, pageSize: 24, pages: 1, providers: [] });
      }).finally(() => { window.clearTimeout(timeout); finalize(); });
    };
    const timer = window.setTimeout(() => {
      if (!("EventSource" in window)) { fallback(); return; }
      events = new EventSource(`/api/live-cams/events?${params}`);
      events.onmessage = (event) => {
        const next = JSON.parse(event.data) as Omit<LiveCamResult, "available">;
        gotSnapshot = true; pagesFloor.current = Math.max(pagesFloor.current, next.pages);
        applyResult({ available: true, ...next });
        if (next.complete) { complete = true; finalize(); }
      };
      // Deadlock guards: a hung provider means `complete` never arrives, which used to leave the
      // pagination (and Refresh) disabled forever. Keep the partial snapshot and stop advertising
      // the missing providers as still loading; with nothing on screen at all, fall back to the
      // one-shot REST endpoint, whose server side is bounded by the same provider budget.
      const interrupt = () => {
        events?.close();
        if (!gotSnapshot) { fallback(); return; }
        const current = resultRef.current;
        if (current) applyResult(markLiveCamInterrupted(current));
        finalize();
      };
      events.onerror = () => { if (complete) return; interrupt(); };
      // A Stripchat catalogue crawl needs tens of seconds on a slow host, so the old 30s guard fired
      // before the provider could ever finish: the page looked permanently stuck and kept a
      // "loading…" provider entry forever. The guard is now longer than the server-side budget.
      guard = window.setTimeout(() => { if (complete) return; interrupt(); }, 90_000);
    }, 180);
    return () => { window.clearTimeout(timer); window.clearTimeout(guard); controller.abort(); events?.close(); };
  }, [params, refresh]);
  useEffect(() => {
    if (loading || refreshing) return;
    const timer = window.setInterval(() => { if (!document.hidden) setRefresh((value) => value + 1); }, 60_000);
    return () => window.clearInterval(timer);
  }, [loading, refreshing]);
  const reset = (action: () => void) => { action(); setPage(1); };
  const providers = result?.providers ?? []; const allCount = providers.filter((provider) => provider.ok && !provider.pending).reduce((sum, provider) => sum + provider.count, 0);
  const loadedProviders = providers.filter((provider) => !provider.pending).length;
  // Providers that stopped reporting without a payload: either the stream guard fired or the
  // provider failed outright. Both are surfaced as "unavailable" instead of a permanent spinner.
  const stalledProviders = providers.filter((provider) => !provider.pending && !provider.ok);
  const onlineFavorites = favoritesOnly ? result?.items.filter((cam) => cam.online !== false && !cam.statusUnavailable) ?? [] : [];
  const offlineFavorites = favoritesOnly ? result?.items.filter((cam) => cam.online === false) ?? [] : [];
  const camGrid = (items: LiveCam[]) => <div className="live-grid">{items.map((cam) => <LiveCamCard cam={cam} open={open} key={`${cam.providerId}:${cam.id}`}/>)}</div>;
  return <section className="live-page">
    <div className="library-intro live-intro"><div><p>LIVE NOW</p><h2>Live Cam</h2><span>Public live rooms aggregated by your installed Open EasyX source plugins</span></div><button className="quiet" onClick={() => setRefresh((value) => value + 1)}><RefreshCw className={loading || refreshing ? "spin" : ""}/>Refresh</button></div>
    {result?.available !== false && <div className="live-filters">
      <label><Search/><input ref={searchInput} defaultValue={search} onChange={(event) => { const value = event.currentTarget.value; window.clearTimeout(searchTimer.current); searchTimer.current = window.setTimeout(() => { setSearch(value); setPage(1); }, 300); }} placeholder="Search live cams or tags…"/></label>
      <label><Radio/><select aria-label="Filter live provider" value={providerId} onChange={(event) => reset(() => setProviderId(event.target.value))}><option value="">All live sources ({allCount.toLocaleString()}{loading ? "+" : ""})</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} ({provider.pending ? "loading…" : provider.ok ? provider.count.toLocaleString() : "unavailable"})</option>)}</select></label>
      <div className="live-genders"><button className={favoritesOnly ? "active favorite" : "favorite"} onClick={() => reset(() => setFavoritesOnly((value) => !value))}><Star fill={favoritesOnly ? "currentColor" : "none"}/>Favorites</button><button className={!gender ? "active" : ""} onClick={() => reset(() => setGender(""))}>All</button>{[["female", "Women"], ["male", "Men"], ["couple", "Couples"], ["trans", "Trans"]].map(([value, label]) => <button key={value} className={gender === value ? "active" : ""} onClick={() => reset(() => setGender(value as LiveCamPreset["gender"]))}>{label}</button>)}</div>
    </div>}

    {loading && !result ? <div className="loading"><LoaderCircle className="spin"/>Loading live cams…</div>
      : result?.available === false ? <LiveCamUnavailable reason={result.reason ?? "No live-cam provider is available in Open EasyX."}/>
      : result && !result.providers.length ? <div className="live-unavailable compact"><span><Radio/></span><h2>No live-cam plugin installed</h2><small>Install a live provider such as Chaturbate Live from Plugins. It will appear here automatically.</small></div>
      : result?.items.length ? <>
        <div className="live-summary"><b>{result.total.toLocaleString()}{loading || refreshing ? "+" : ""} {favoritesOnly ? (result.total === 1 ? "favorite creator" : "favorite creators") : (result.total === 1 ? "live cam" : "live cams")}</b><span>{loading || refreshing ? `Loading sources ${loadedProviders}/${result.providers.length}` : stalledProviders.length ? `${stalledProviders.map((provider) => provider.name).join(", ")} did not respond · showing partial results` : favoritesOnly ? `${onlineFavorites.length} live on this page` : `${result.providers.filter((provider) => provider.ok && provider.count > 0).length} active sources`}</span></div>
        {favoritesOnly ? <div className="favorite-live-sections">{onlineFavorites.length > 0 && <section><h3><i/>Live now</h3>{camGrid(onlineFavorites)}</section>}{offlineFavorites.length > 0 && <section className="offline"><h3><i/>Offline</h3>{camGrid(offlineFavorites)}</section>}</div> : camGrid(result.items)}
        {/* Pagination is driven by page bounds only. Tying it to `loading` used to grey out Next for the
            whole time a slow provider kept the SSE stream open, so users saw the bar but could not click. */}
        {(() => { const pages = Math.max(result.pages, pagesFloor.current); return pages > 1 ? <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></div> : null; })()}
      </> : loading && result ? <div className="loading"><LoaderCircle className="spin"/>Loading sources {loadedProviders}/{result.providers.length}… {result.total.toLocaleString()} live cams found</div>
      : <div className="live-unavailable compact"><span>{favoritesOnly ? <Star/> : <Radio/>}</span><h2>{favoritesOnly ? (favorites.length ? "No favorites match these filters" : "No favorite creators yet") : "No public cams are live"}</h2><small>{favoritesOnly ? (favorites.length ? "Try another source, search, or gender filter." : "Open a live stream and select Favorite creator to add it here, or connect your provider account in Plugins.") : "Try another source or filter. Installed providers are refreshed every 60 seconds."}</small></div>}
  </section>;
}
