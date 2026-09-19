# Food and meal images

Date: 2026-09-18
Status: approved, not implemented

Adds an optional image to any food or meal. Images can be searched automatically from
free no-key providers, adopted from a barcode scan, or taken/chosen by the user. The
bytes live on the server in a content-addressed store; only small metadata rows sync.

This is the first of two specs. The second, `2026-09-18-meal-notifications-design.md`,
adds "Ready for <window>?" local notifications and attaches the image chosen here. This
spec must not depend on anything in that one, but it must leave the image bytes reachable
as a real local file on iOS, because notification attachments require one.

## Why

Two reasons, in order of weight:

1. A plan slot or a search result is currently a wall of similar text. A thumbnail makes
   "which soup was that" answerable at a glance.
2. The notification spec needs an image to attach, and the only honest source of one is a
   deliberate choice the user already made on the food or meal.

## Scope

In scope:

- One image per `food` and per `meal`, nullable, removable.
- Automatic image search across free, no-API-key providers, returning candidates the user
  picks from. Never auto-assigned without a tap.
- Open Food Facts product photos offered during a barcode scan.
- Upload of the user's own photo (camera or library).
- Thumbnails in the food/meal editor, search results, meal components, and plan rows.
- Offline display on every client after first fetch.

Out of scope:

- Multiple images per food, cropping, rotation, or any editing.
- Images on `log_entry` / `log_item` / `plan_item` rows. Items reference a food or meal and
  inherit its image; there is no per-item override.
- Any use of images in dose math. Images are decoration and identification only.
- OCR or nutrition extraction from a photo.

## Data model

### New synced table: `image`

Metadata only. No bytes. Added by `server/migrations/006_images.sql` and registered in
`SYNC_TABLES` and `TABLE_SPECS` (`server/src/sync/tables.ts:14,170`).

| column | type | rule |
| --- | --- | --- |
| `id` | text | the bytes' SHA-256, lowercase hex, 64 chars. Content-addressed, so identical images dedup across foods. |
| `mime` | text | `image/jpeg` only in this version. Validated against an allowlist so widening it later is a one-line change. |
| `width` | integer | > 0, pixels after recompression. |
| `height` | integer | > 0, pixels after recompression. |
| `source` | text | enum `off` \| `openverse` \| `wikimedia` \| `themealdb` \| `upload`. |
| `source_url` | text, nullable | where it came from; null for `upload`. |
| `license` | text, nullable | SPDX-ish string as reported by the provider, e.g. `CC-BY-4.0`. |
| `attribution` | text, nullable | ready-to-display credit line, <= 300 chars. |

Plus the standard sync envelope (`updated_at`, `updated_by`, `deleted`, `server_seq`) and
an `image_server_seq` index, per `server/migrations/001_init.sql:133`.

Rows sync because attribution and license must travel with the image to every client that
displays it; a CC-BY image shown without its credit line is a licence violation. The rows
are tiny (a few hundred bytes), so this costs nothing measurable in sync traffic.

`image` rows are never hard-deleted by the app. Setting `deleted = 1` is allowed, but see
"Orphans and cleanup".

### Changed tables: `food`, `meal`

Both gain `image_id text` (nullable). Field spec: text, <= 64 chars, nullable. It is **not**
a foreign key, matching the existing convention that sync rows may arrive out of order
(`server/src/sync/tables.ts:129-135`). A dangling `image_id` renders as no image, never as
an error.

### Client registration

Adding a synced table touches five places; all are required:

1. `server/migrations/006_images.sql` plus `SYNC_TABLES` / `TABLE_SPECS`.
2. `packages/core/src/types.ts` — `ImageData` interface, and `image_id` on `FoodData` and
   `MealData`.
3. `web/src/db/db.ts:19` — `SYNC_TABLES`, the `SyncRecords` map, and a new Dexie
   `this.version(N).stores({...})`.
4. `ios/CarbBookKit/Sources/CarbBookKit/Schema.swift` — CREATE TABLE plus a schema version
   bump, and the column list in `TableCodec.swift:17-26`.
5. `ios/CarbBookCore/Sources/CarbBookCore/Sync.swift:33-36` — `SyncTables.all`.

While in that last file, fix the pre-existing drift: `SyncTables.all` lists eight tables
and omits `plan_entry` and `plan_item`, which the iOS store does write
(`ios/CarbBookKit/Sources/CarbBookKit/PlanEditing.swift:81-247`). It appears to be used only
as a test guard (`SyncEngineTests.swift:88`), but it is wrong either way and this spec is
already editing the list. Confirm nothing else reads it before changing it.

## Byte store

Path: `/data/images/<first two hex chars of hash>/<hash>.jpg`, under the existing `/data`
volume alongside `USDA_DIR=/data/usda`. New config key `IMAGE_DIR`, default `/data/images`,
following `server/src/config.ts`.

Every image, whatever its origin, is normalised on the way in:

- Re-encoded to JPEG quality 80.
- Longest edge capped at 800px; smaller images are not upscaled.
- EXIF stripped, which also drops any GPS tag from a phone photo.
- Result must be <= 400KB after encoding, or the request fails with a clear message. At
  800px/q80 this is generous; the cap exists to bound the store, not to be hit.

`sharp` does the work. It is the only new native dependency; prebuilt linux-arm64 binaries
exist, so the Pi build (`Dockerfile:3`, `node:22-bookworm-slim`) needs no toolchain. If the
prebuilt binary turns out not to resolve on the Pi, stop and re-decide rather than adding a
build toolchain to the image — falling back to storing unresized bytes is an acceptable
alternative and should be raised as such.

Hash is computed over the **normalised** bytes, so the same source image adopted twice
dedups to one file and one row.

### Serving

`GET /api/images/:hash` streams the file. Modelled directly on
`server/src/routes/usda.ts:26-35`: `createReadStream`, hash validated against
`/^[0-9a-f]{64}$/` before touching the filesystem, `cache-control: private, max-age=31536000,
immutable` (safe, because the URL is the content hash). 404 when absent. Requires auth like
every other `/api` route.

## Search providers

Each provider is a module in `server/src/images/providers/` exporting a single function:

```ts
search(query: string, limit: number): Promise<ImageCandidate[]>
```

```ts
type ImageCandidate = {
  provider: 'off' | 'openverse' | 'wikimedia' | 'themealdb';
  thumb_url: string;     // small, for the picker grid
  full_url: string;      // what gets adopted
  width: number | null;
  height: number | null;
  license: string | null;
  attribution: string | null;
  title: string | null;
};
```

Providers are injected through `defaultDeps` (`server/src/app.ts:27-43`) exactly like the OFF
and BG clients, so tests stub them the way `server/test/off.test.ts` already does. Each
reuses the `AbortSignal.timeout(config.httpTimeoutMs)` pattern from
`server/src/off/client.ts:34-56`.

| provider | key needed | good for | notes |
| --- | --- | --- | --- |
| `openverse` | none | general dish and ingredient terms | ~700M CC images; quality varies, so candidates only. Anonymous requests are rate-limited; treat 429 as unavailable. Adopt `thumbnail` **with `?full_size=true`** — measured, the plain proxy serves 600x399, under the 800px cap, while `full_size=true` returns the original (1024x681 for the same image) and stays on the allowlisted host. |
| `wikimedia` | none | ingredients, recognisable named dishes | Commons API. Attribution and licence are reliable here. |
| `themealdb` | none (public test key `1`) | prepared dishes and recipes | Small catalogue, high relevance when it hits. |
| `off` | none | packaged products, by barcode | Not a text search; see below. |

### OFF is a special case

OFF is queried by barcode, not free text, and the barcode path already exists. Extend
`OFF_FIELDS` (`server/src/off/client.ts:2`) with `image_front_url,image_front_small_url` and
carry them on `OffProduct` and through `normalizeOffProduct`
(`server/src/off/normalize.ts:32-57`) as a candidate attached to the returned draft. The
barcode route (`server/src/routes/barcode.ts:41-51`) then returns an optional candidate
alongside a `draft`, and the scan-confirm screen offers "use this photo". OFF images are
ODbL/CC-BY-SA; attribution is `Open Food Facts` plus the product URL.

### Aggregation

`GET /api/images/search?q=<text>&limit=<n>` fans out to the three text providers in
parallel, with a per-provider cap so one chatty provider cannot crowd out the others, and
interleaves results. Dedup is by `full_url`. A provider that times out, errors, or
rate-limits is simply absent from the results; the route returns 200 with whatever arrived
and a `providers_failed: string[]` field so the UI can say "Wikimedia didn't respond"
instead of silently showing less. All providers failing is still 200 with an empty list —
this is a convenience feature and must never block saving a food.

`q` is required, trimmed, 1-200 chars. `limit` defaults to 24, max 48.

Nothing is downloaded during search. The picker grid loads `thumb_url` directly from the
provider, which is the one place a client talks to a third-party host. That is a deliberate
trade: proxying thumbnails would double the bytes through the Pi for images the user will
mostly discard. It is noted here because it does leak "user is browsing image candidates"
to those hosts at search time. No CarbBook data, food names included, is sent to any
provider except the query string the user typed or the food's own name.

## Adopting an image

`POST /api/images/adopt`

```json
{ "url": "<full_url>", "source": "openverse", "source_url": "...",
  "license": "CC-BY-4.0", "attribution": "..." }
```

Server-side: fetch the URL (same timeout pattern), verify the response is an image by
sniffing magic bytes rather than trusting `content-type`, cap the download at 10MB before
normalisation, normalise, hash, store, upsert the `image` row, return it.

`url` must be `https:` and its host must be on a per-provider allowlist. This is an
SSRF boundary: the server fetches a URL supplied by a client, so it must not be reachable
for `http:`, non-standard ports, credentials in the URL, redirects to other hosts, or any
address that resolves to a private, loopback, link-local, or metadata range. Redirects are
followed at most twice, re-validated each hop.

Returning the row rather than writing the food is deliberate: the client then sets
`food.image_id` through its normal sync push, so the change participates in
last-write-wins and offline queueing like every other edit. The server never writes a
`food` row from this route.

If the hash already exists, the route is a no-op that returns the existing row. Adopting
the same image for a second food costs one row reference and zero bytes.

## Uploading the user's own photo

`POST /api/images/upload`

```json
{ "data_base64": "<...>", "mime": "image/jpeg" }
```

Base64 JSON, not multipart, for two reasons: it avoids adding `@fastify/multipart`, and it
stays inside the CSRF rule at `server/src/csrf.ts:29-38`, which requires
`content-type: application/json` on any cookie-authenticated mutating request. A multipart
upload from the web client would be rejected by that check.

The global 5MB body limit (`server/src/app.ts:57`) bounds this; base64 inflates by 4/3, so
the practical ceiling is ~3.7MB of image, well above a normalised phone photo. The client
downscales before encoding so a 12MP photo never hits the limit: web via `canvas`, iOS via
`UIGraphicsImageRenderer`. Server-side normalisation still runs regardless — the client
downscale is an optimisation, not a trust boundary.

`source` is recorded as `upload`, with null `source_url`, `license`, and `attribution`.

## Clients

### Fetch and cache

Both clients fetch `GET /api/images/:hash` once and cache by hash. Because the hash is the
content, a cached file never needs revalidation.

- Web: a `Cache` entry via the existing Workbox service worker (`web/vite.config.ts:8-35`),
  with a runtime caching rule for `/api/images/`. Note `navigateFallbackDenylist` already
  excludes `/api/`, so this does not collide with the SPA fallback.
- iOS: `ImageCache` in CarbBookKit writing to the Caches directory, keyed by hash. Files in
  Caches can be evicted by the OS, so every read must handle a miss by refetching. The
  notification spec depends on this cache producing a real file path.

### UI

- **Food and meal editor**: a thumbnail slot. Empty state offers "Find image" and "Take
  photo". "Find image" opens the candidate grid, prefilled with the food or meal name as the
  query and editable. Tapping a candidate adopts it and sets `image_id`. A chosen image can
  be replaced or removed; removing sets `image_id` to null and leaves the `image` row alone.
- **Attribution** shows under the image in the editor whenever `attribution` is non-null.
  Thumbnails in lists do not repeat it.
- **Barcode confirm**: when the OFF draft carries a candidate, show it with "use this photo",
  preselected off. The user opting in is what makes it an adopt.
- **Lists**: food search results, meal component rows, and plan rows show a small thumbnail
  where one exists, and nothing where one does not. No placeholder silhouettes — an empty
  slot is quieter than a fake image.

Images never change a carb number, and no image state can block a save. If the image
service is entirely down, every existing screen still works.

## Orphans and cleanup

A row whose `image_id` is set to null leaves the `image` row and its bytes in place. This is
intentional for v1: images are small, deletion is irreversible, and a hash may be referenced
by another food on another device that has not synced yet. Deleting bytes that a
not-yet-synced device still references would surface as a permanently broken thumbnail.

A `carbbook images gc` CLI subcommand (alongside the existing `user add` and `import-usda` in
`server/src/cli.ts:20-22`) reports unreferenced hashes and deletes them only with
`--delete`, and only those older than 30 days. Manual, never automatic, never on a timer.

## Testing

- **Core**: `ImageData` validation and the `image_id` field spec, via the existing shared
  JSON vectors in `testdata/` so the TS and Swift cores agree.
- **Server, providers**: each provider against a recorded response fixture, plus the failure
  paths — timeout, 429, malformed JSON, empty result. Stubbed through `deps`, no network in
  tests.
- **Server, aggregation**: one provider failing yields 200 with `providers_failed`; all
  failing yields 200 and an empty list.
- **Server, adopt**: the SSRF allowlist is the priority case — `http:`, a private-range
  host, a redirect that leaves the allowlist, credentials in the URL, a non-image body with
  an `image/jpeg` content-type, and an oversized download must each be rejected. Plus the
  happy path, and the dedup no-op.
- **Server, store**: normalisation output is deterministic enough to hash stably; EXIF is
  gone; the 400KB cap and the hash-format guard on the serving route hold.
- **Web**: adopt-then-sync sets `image_id`; a dangling `image_id` renders as no image; the
  picker shows a failed-provider notice. Playwright covers editor → search → adopt → thumbnail
  visible.
- **iOS**: `ImageCache` hit, miss, and eviction-then-refetch. Swift tests run via
  `ios/scripts/swift-test.sh`.
- **On device**: a real adopt from the phone, a real photo upload, and thumbnails visible
  offline after killing the network. Per the project's own rule, nothing here is "done"
  before that happens.

## Risks

1. **`sharp` on arm64.** If the prebuilt binary does not resolve on the Pi, do not add a
   build toolchain to the image. Raise it and re-decide.
2. **SSRF via `adopt`.** This spec introduces the first route where a client hands the server
   a URL to fetch. The allowlist plus redirect and address-range checks are the mitigation,
   and they are the most important tests in the suite.

   Two findings from implementation, recorded here because they outlived the tasks that found them:

   - The first version of `isPublicAddress` judged IPv6 by string prefix and only recognised
     IPv4-mapped addresses in dotted form, so hex spellings of private addresses passed as public
     (`::ffff:7f00:1`, `::ffff:a00:1`) along with NAT64 `64:ff9b::/96`, 6to4 `2002::/16` and
     Teredo `2001:0::/32` embedding private v4. The last three are not merely latent: no resolver
     prints those in dotted form, and this deployment already hits NAT64 synthesis on cellular.
     Fixed by parsing to 16 bytes and judging numerically (`15e7dc6`). Lesson worth keeping:
     normalise addresses, never pattern-match their spellings.
   - **TOCTOU / DNS rebinding between guard and fetch is an accepted risk.** `assertAdoptableUrl`
     resolves the hostname, then `fetch` resolves it again independently, so a short-TTL record
     could answer public to the guard and private to the fetch. Closing it properly means pinning
     the validated address onto a custom undici agent. Not built, because exploiting it requires an
     authenticated user on this server who *also* controls DNS for `api.openverse.org`,
     `upload.wikimedia.org`, `www.themealdb.com` or `images.openfoodfacts.org`. Revisit if this app
     ever serves untrusted users. The redirect rule below is the related mitigation that *is* built.

   Adoption rejects redirects outright (`redirect: 'manual'`) rather than following them: a 302
   from an allowlisted host would otherwise defeat both gates, and all four allowlisted hosts serve
   final URLs for the URLs we adopt.
3. **Provider churn.** Free no-key APIs change or disappear. The provider interface is
   deliberately one function so losing one is a deletion, not a refactor.
4. **Licence display.** CC-BY requires credit. Attribution is stored and shown in the editor;
   if images later appear anywhere shareable, that surface needs the credit line too.
5. **Thumbnail requests reach third-party hosts** from the client during search, as noted
   above. Acceptable for a single-user homelab app; worth revisiting if that ever changes.

## Sequencing

1. Migration, `image` table registration across all five places, iOS `SyncTables.all` fix.
2. Byte store, normalisation, and the serving route.
3. Providers and the aggregating search route.
4. `adopt` and `upload`, with the SSRF tests written before the route.
5. Web picker, editor slot, and list thumbnails.
6. iOS picker, cache, and list thumbnails.
7. OFF barcode candidate.
8. `images gc` CLI.
9. On-device verification, then release.
