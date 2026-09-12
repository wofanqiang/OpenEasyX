# Plugin author guide

Open EasyX plugins add source-specific behavior and optional features. The core never contains a site scraper.

## Trust model

A plugin is trusted server-side JavaScript. It can make network calls and, through the methods EasyX gives it, produce media requests and lifecycle hooks. Administrators must review a plugin before mounting it. The current MVP does not sandbox plugin code.

Plugins must not bypass access controls, DRM, paywalls, authentication, or technical restrictions. They should expose any required credentials as settings, respect rate limits, clearly identify their source, and only return content the configured account is authorized to access.

## Package layout

```text
my-plugin/
└── index.mjs
```

The module default-exports an object that follows `EasyXPlugin` from `@easyx/plugin-sdk`. During development inside this repository, TypeScript plugins may import `definePlugin` directly. External runtime plugins should ship self-contained JavaScript.

## Lifecycle

1. EasyX discovers the directory and validates `manifest`.
2. The administrator explicitly installs the plugin. Required settings are collected first.
3. A successful installation activates it atomically; uninstalling deactivates it.
4. Search-capable plugins participate in unified discovery.
5. Source-capable plugins return profiles for an imported performer.
6. Listing plugins periodically return media candidates.
7. Resolver plugins turn a chosen candidate into an HTTP request or a trusted extractor command.
8. The core streams the response to a partial file, hashes it, deduplicates it, atomically moves it, and calls `afterDownload`.
9. A library-hook plugin may react to downloads or library deletions. Open EasyX itself records a no-redownload tombstone when a tracked file is deleted.

Identity results with the same normalized name are grouped in the UI. The grouped import calls every selected provider, merges its external reference and aliases into one performer, then runs source discovery for each match. A search error is isolated to the failing plugin.

A source-discovery plugin owns the URL's provenance, but it does not automatically become its scraper. Every URL starts as `Reference only`. Installing a plugin never assigns it to any performer. The administrator separately selects an installed plugin with `media-listing` for one URL, then explicitly starts a scan or enables that URL's schedule. A plugin may provide both capabilities, but the core still keeps these two roles separate.

## Manifest

```js
manifest: {
  id: "com.example.feed",
  name: "Example feed",
  version: "1.0.0",
  description: "Reads media from an authorized feed.",
  author: "Example",
  capabilities: ["source-discovery", "media-listing", "download-resolver"],
  sourceUrlPatterns: ["https://example.com/profiles/*"],
  fallback: false,
  polling: {
    mode: "periodic",
    defaultIntervalSeconds: 3600,
    minimumIntervalSeconds: 300
  },
  settings: [
    { key: "token", label: "Access token", type: "password", required: true }
  ]
}
```

IDs must be stable lowercase reverse-domain identifiers. Supported capabilities are:

- `identity-search`
- `source-discovery`
- `media-listing`
- `download-resolver`
- `live-cam`
- `library-hook`

Only declare capabilities the plugin actually implements. `live-cam` exposes direct browser playback inside Open EasyX: implement `resolveLiveStream`, and implement `listLiveCams` when the provider offers a public room directory. Live plugins without a public directory can still contribute configured performer sources.

Providers with an exact room-status endpoint can also implement `getLiveCam(context, cam)`. Return `online: true` for a public broadcast and `online: false` for a confirmed unavailable broadcast; throw on network errors or invalid responses. Open EasyX uses this lookup for local favorites missing from the account snapshot, so creators outside a limited search catalogue are still checked correctly. Failed checks are displayed as status unavailable, separately from confirmed offline rooms.

Library hooks can implement `afterDownload` for outbound notifications, `acceptLibraryDeletion` for inbound deletion notifications, or both. The core owns item state: an accepted relative path is matched to a completed download and recorded as `deleted` without exposing database access to plugin code.

Set `fallback: true` only for a deliberately generic parser such as Web Media. The interface suppresses a fallback when a source-specific plugin exists for that URL, so a generic HTML parser is not presented as equivalent to a working platform extractor.

## URL compatibility and polling

A plugin with `media-listing` should publish `sourceUrlPatterns`. Patterns are full URL globs where `*` matches any sequence. EasyX uses them in both the API and performer UI, so an incompatible plugin is never assigned accidentally. Older plugins without patterns remain compatible with any URL.

`polling.mode` is `periodic` for feeds and pages or `live` for a one-shot live-status check. `defaultIntervalSeconds` is the recommended initial schedule and `minimumIntervalSeconds` is enforced by the core. The minimum cannot be lower than five seconds. Administrators can override the interval per performer URL without going below the plugin minimum.

Live plugins must make `listMedia` a short, idempotent status check and return promptly. They must not keep that call open as a recorder. Continuous stream capture requires a resolver designed for the stream format; polling only controls how often EasyX asks whether new media is available.

## Deduplication and quality

Every media candidate needs a source-stable `externalId`. If several URLs represent the same underlying work, also return the same cross-variant `identityKey` and a numeric `qualityScore`. Return the source publication or creation date as an ISO-compatible `publishedAt` whenever it is available. EasyX retains the candidate with the highest known score while reconciling the oldest reliable date observed across its variants. After download, SHA-256 removes byte-identical duplicates and a conservative perceptual image fingerprint recognizes resized or recompressed copies for the same performer.

Suggested quality scoring:

- images: pixel width × pixel height
- videos: pixel area × frame rate, with a small codec/bitrate adjustment
- original files: add a documented source-specific premium

Do not claim two edits or crops are the same identity unless discarding one is safe.

## Storage contract

Plugins do not choose arbitrary output paths. They may suggest a filename. HTTP resolvers return a URL and optional headers. Trusted extractor resolvers may instead return a command request whose arguments contain the literal `{output}` placeholder; EasyX replaces it with a core-controlled partial path. The core sanitizes the final filename and writes under:

```text
<media root>/<performer name>/<source domain>/<filename>
```

Plugins never receive database handles. Return JSON-compatible metadata only. Download headers can contain credentials and are used for that request only; they are not written into the media directory.

## Errors

Throw an `Error` with an operator-friendly English message. A source sync error is recorded on the source and retried on its next schedule. A download error marks the item as failed and lets the administrator requeue it.

## Community repository layout

A repository can contain plugin directories at its root or below `plugins/`:

```text
open-easyx-community-plugins/
├── README.md
└── plugins/
    └── my-plugin/
        └── index.mjs
```

The administrator pastes the Git remote into **Plugins → Repositories → Install new repository**. GitHub, Gitea, Forgejo, GitLab, and generic HTTP(S), SSH, or Git remotes use the same flow. Open EasyX performs a shallow clone under `/data/plugin-repositories`, validates that it contains loadable plugin directories, and then exposes each plugin for a separate explicit installation. Updating a repository never installs its plugins automatically.

## Local installation

For local development, put the plugin directory in `plugins-external/`, then restart the container or call the plugin reload API. Open **Plugins**, review it, provide any required settings, and click **Install & activate**.

See the complete interface in [`packages/plugin-sdk/index.ts`](../packages/plugin-sdk/index.ts) and the inert example in [`examples/plugins/http-feed/index.mjs`](../examples/plugins/http-feed/index.mjs).
