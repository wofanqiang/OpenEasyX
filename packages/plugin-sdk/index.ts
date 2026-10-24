export type PluginCapability =
  | "identity-search"
  | "source-discovery"
  | "media-listing"
  | "download-resolver"
  | "live-cam"
  | "library-hook";

export type SettingField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "session";
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  cookieDomains?: string[];
  sessionFormat?: "cookies" | "raw-json";
};

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string;
  capabilities: PluginCapability[];
  settings?: SettingField[];
  browserAuth?: {
    loginUrl: string;
    sessionSetting: string;
    capture?: "cookies" | "onlyfans" | "manyvids" | "authorization-header";
    requestDomains?: string[];
  };
  sourceUrlPatterns?: string[];
  fallback?: boolean;
  polling?: {
    mode: "periodic" | "live";
    defaultIntervalSeconds: number;
    minimumIntervalSeconds: number;
  };
};

export type PersonCandidate = {
  externalId: string;
  name: string;
  aliases?: string[];
  imageUrl?: string;
  profileUrls?: string[];
  metadata?: Record<string, unknown>;
};

export type PerformerRecord = {
  id: string;
  name: string;
  aliases: string[];
  imageUrl?: string;
  externalRefs: Record<string, string>;
};

export type SourceCandidate = {
  externalId: string;
  label: string;
  profileUrl: string;
  domain: string;
};

export type MediaCandidate = {
  externalId: string;
  identityKey?: string;
  title?: string;
  pageUrl?: string;
  mediaType: "image" | "video" | "archive" | "other";
  publishedAt?: string;
  filename?: string;
  qualityScore?: number;
  expectedBytes?: number;
  metadata?: Record<string, unknown>;
};

export type HttpDownloadRequest = {
  kind?: "http";
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  filename?: string;
};

export type CommandDownloadRequest = {
  kind: "command";
  command: string;
  args: string[];
  filename: string;
  /**
   * How a live capture feeds ffmpeg: `split` opens one input per rendition, `master` opens a
   * single playlist that names both. The downloader writes it next to the capture, because the
   * TS remux must not read container start times as an A/V offset on a single input.
   */
  captureInput?: "split" | "master";
  /** Wrappers that finalize output themselves must exit successfully, even after a stop. */
  requireSuccessfulExit?: boolean;
};

export type DownloadRequest = HttpDownloadRequest | CommandDownloadRequest;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type PluginContext = {
  config: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * How long this plugin may spend on one catalogue/listing sweep, taken from the
   * `liveCrawlBudgetPreset` setting so a single control governs every plugin. Stop at the
   * deadline and return what you already have: the server aborts at this value plus a small
   * margin, and an abort turns a short list into an error page.
   *
   * This is a sweep budget, not a command timeout - `runCommand({ timeoutMs })` is independent.
   */
  budgetMs?: number;
  fetch: typeof globalThis.fetch;
  runCommand: (command: string, args: string[], options?: { timeoutMs?: number; maxOutputBytes?: number }) => Promise<CommandResult>;
  log: (level: "debug" | "info" | "warn" | "error", message: string, details?: unknown) => void;
};

export type MediaSource = {
  id: string;
  externalId: string;
  performerId: string;
  profileUrl: string;
  domain: string;
};

export type CompletedDownload = {
  absolutePath: string;
  relativePath: string;
  mediaType: string;
  checksumSha256: string;
};

export type LibraryDeletion = {
  relativePath: string;
};

export type LiveCamQuery = {
  page: number;
  pageSize: number;
  search?: string;
  gender?: "female" | "male" | "couple" | "trans";
};

export type LiveCam = {
  id: string;
  username: string;
  title?: string;
  pageUrl: string;
  thumbnailUrl?: string;
  profileImageUrl?: string;
  viewers?: number;
  age?: number;
  gender?: string;
  tags?: string[];
  online?: boolean;
  /**
   * The provider's own room status, when it publishes one.
   *
   * Only `"public"` means an openly watchable show that a recorder may capture. Everything else
   * the providers name -- `private`, `groupShow`, `p2p`, `away`, `password`, `hidden`,
   * `notconnected`, `offline` -- describes a room that is on air but has nothing to record, and
   * Stripchat answers `isOnline: true` for all of them (measured: 60 of 60 rooms online, four of
   * them `groupShow`), so the `online` flag alone cannot make that distinction. Providers with no
   * such vocabulary leave this unset, and then `online` remains the only signal.
   */
  status?: string;
  statusUnavailable?: boolean;
};

export type LiveCamPage = {
  cams: LiveCam[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type LiveCamFavoriteSnapshot = {
  cams: Array<LiveCam & { online: boolean }>;
  authoritative: boolean;
  skippedReason?: string;
};

export type LiveCamFavoriteUpdate = {
  synchronized: boolean;
};

export type LiveStream = {
  url: string;
  audioUrl?: string;
  headers?: Record<string, string>;
  contentType?: string;
  /**
   * Anti-leech playlists. Some CDNs (Tencent `MC_VCLOUD_LIVE`, which fronts the doppiocdn hosts
   * behind Stripchat and its white labels) write a decoy address on every segment URI line and
   * carry the real, encrypted address on a sibling `#EXT-X-MOUFLON:URI:` hint. Setting this to
   * the key the CDN's own player uses makes the server's live proxy decrypt those addresses
   * while it rewrites the playlist, which is what lets ffmpeg and hls.js follow it at all.
   * See `packages/hls-mouflon.ts`.
   */
  playlistDecodeKey?: string;
  /**
   * Ask for the playlist to be rewritten without claiming to know the CDN's key.
   *
   * MOUFLON's two layers are separable: the URI substitution (a decoy on the URI line, the real
   * address on a `#EXT-X-MOUFLON:URI:` hint) needs no key at all, while the token encryption
   * inside that address does. Setting this routes the stream through the live proxy so the
   * substitution happens even when the CDN advertises no key we can name -- which is the case on
   * Stripchat, where the `pkey` the room's player echoes back is not one of the keymap entries.
   * Set `playlistDecodeKey` as well when a key *is* known; either one alone is enough to route.
   */
  playlistRewrite?: boolean;
  /**
   * The CDN gates on the client's TLS fingerprint: it answers 403 to ffmpeg's OpenSSL stack for
   * this very URL while a Chrome fingerprint gets 200 (measured on CamSoda's edge, playlist and
   * segments alike). Set it when the stream was resolved through an impersonating client, and
   * the recorder routes the capture through the HLS proxy, which fetches with that fingerprint
   * (see server/tls-fingerprint.ts). Left unset, nothing changes: the capture goes straight to
   * the provider as before.
   */
  requiresTlsFingerprint?: boolean;
};

export interface EasyXPlugin {
  manifest: PluginManifest;
  testConnection?(context: PluginContext): Promise<{ ok: boolean; message: string }>;
  searchPeople?(context: PluginContext, query: string): Promise<PersonCandidate[]>;
  discoverSources?(context: PluginContext, performer: PerformerRecord): Promise<SourceCandidate[]>;
  listMedia?(context: PluginContext, source: MediaSource): Promise<MediaCandidate[]>;
  resolveDownload?(context: PluginContext, item: MediaCandidate): Promise<DownloadRequest>;
  listLiveCams?(context: PluginContext, query: LiveCamQuery): Promise<LiveCamPage>;
  /** Look up one exact room, including its offline status, without catalogue search. */
  getLiveCam?(context: PluginContext, cam: LiveCam): Promise<LiveCam>;
  listFollowedLiveCams?(context: PluginContext): Promise<LiveCamFavoriteSnapshot>;
  setLiveCamFavorite?(context: PluginContext, cam: LiveCam, favorite: boolean): Promise<LiveCamFavoriteUpdate>;
  resolveLiveStream?(context: PluginContext, cam: LiveCam): Promise<LiveStream>;
  afterDownload?(context: PluginContext, download: CompletedDownload): Promise<void>;
  acceptLibraryDeletion?(context: PluginContext, deletion: LibraryDeletion): Promise<LibraryDeletion>;
}

export function definePlugin(plugin: EasyXPlugin): EasyXPlugin {
  return plugin;
}
