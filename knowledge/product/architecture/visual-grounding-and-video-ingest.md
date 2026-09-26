---
title: Visual Grounding and Video Ingest
category: Architecture
tags: [vision, video, set-of-marks, screen, ocr, redaction, tier, approval, yt-dlp]
importance: 6
last_updated: 2026-09-26
---

# Visual Grounding and Video Ingest

How the vision-actuator turns screenshots and videos into grounded, tier-safe
inputs for agents. Four ops were added in vision-actuator 1.5.0; the
implementations live in `libs/core` and the actuator only validates params and
dispatches.

| Op                             | Kind      | Core module                           | Output                                                           |
| ------------------------------ | --------- | ------------------------------------- | ---------------------------------------------------------------- |
| `vision:fetch_video`           | capture   | `libs/core/video-ingest`              | `VideoBrief` for a remote URL (needs approval)                   |
| `vision:build_video_brief`     | transform | `libs/core/video-ingest`              | `VideoBrief` for a URL or a local file                           |
| `vision:mark_elements`         | capture   | `set-of-marks`, `ui-element-detector` | numbered marks, annotated PNG/SVG, `marks_id`, image dHash       |
| `vision:describe_screen_delta` | capture   | `dirty-tile-describer`                | per-tile descriptions; only changed tiles reach the vision model |

## Video ingest

- A `VideoBrief` holds metadata, chapters, a transcript, keyframes, a
  thumbnail and optional audio. The transcript comes from manual subtitles,
  then auto subtitles (rolling caption lines are deduplicated only for auto
  captions; manual subtitles keep genuine repeats), then a
  speech-to-text bridge that declares segment timestamps.
- Remote hosts must be in `knowledge/product/governance/video-ingest-policy.json`
  `allowed_hosts`, and the URL is also checked against the egress policy.
  `require_approval_for_remote` (default true) sends every uncached remote
  fetch through the risky-op approval gate (`vision:fetch_video`). If the
  caller passes no `approval` context, or approval is still pending, the op
  returns `status: approval_required` instead of failing. Only `agent_id` is
  taken from the op params: the correlation id is always
  `video-ingest:<content key>:<payload hash>`, the channel is `system`, and the
  gate's `human_only` request is bound to `vision:fetch_video` and the payload
  hash of `{url, format, max_bytes, max_duration_sec}`, so an approval for one
  URL can never authorize another, and changing the policy limits asks again
  instead of colliding with the earlier request. Every request expires after
  24 h (`VIDEO_FETCH_APPROVAL_TTL_MS`): the gate's renewable-request mode
  (`expiresAt`) stops a lapsed request — pending, rejected or approved — from
  binding the correlation id, so a rejection never locks a URL forever and an
  approval is never a standing grant; the next call opens a fresh request. Live/upcoming streams (`LIVE_STREAM`) and remote
  videos without a known duration (`DURATION_UNKNOWN`) are refused before any
  download. The metadata probe uses the same `-f` selector as the download, so
  the size check matches the actual selection. Other failures throw
  `[VIDEO_<CODE>]`. For example, `[VIDEO_EXTRACTOR_OUTDATED]` includes a
  remediation to bump and reinstall yt-dlp. The actuator never updates yt-dlp
  itself.
- Cache: content key = sha256(normalized URL + format) or sha256(file bytes,
  hashed in fixed-size chunks).
  The cache goes to the mission when `mission_id` is given (it must be a valid
  mission id of an existing mission, else `INVALID_SOURCE`), else the tenant's
  volatile area when `tenant_slug` is given, else
  `active/shared/cache/video-ingest/` (public). A local file is never cached in
  a lower tier than its input (`TIER_DOWNGRADE`), and a local file owned by a
  tenant (`knowledge/confidential/{slug}/`, `active/projects/{tier}/{slug}/`, a
  tenant-scoped mission dir, or a mission whose state records a tenant) is only
  cached under that same tenant (`TENANT_MISMATCH`). Classification uses the
  canonical path (symlinks, including symlinked parent directories, are
  resolved through `safeRealpath`) and compares the repo-relative path
  case-insensitively. It fails closed: a path outside the repository is
  `TIER_UNRESOLVED`, and a confidential/personal partition whose owner is not a
  valid tenant slug or a shared prefix (`common`, `tenant-groups`) — or a
  mission state with an unreadable or invalid tenant — is `TENANT_UNRESOLVED`.
  A cache hit runs no external command.
- Download: yt-dlp writes into the cache entry with `-P <entry> -o
'source.%(ext)s'`, `--ffmpeg-location` from the resolver and
  `--match-filter '!is_live'`. The merged `source.<ext>` is used; if only split
  streams (`source.f<id>.<ext>`) remain the fetch fails.
- Retention: a failed or oversize download removes its partial media from the
  cache entry. After derivation the downloaded source media is deleted (derived
  audio, frames, subtitles and the brief stay) unless `keep_source: true`. A
  local input file is never deleted. Download, derivation and cleanup of one
  cache entry run under a per-entry lock (`lock-utils`), so a concurrent run
  waits and then serves the cached brief instead of deleting media another
  run is still deriving from. Source media kept by an earlier `keep_source`
  run is reused rather than downloaded again (and never deleted by a failed
  re-download).
- External binaries (`yt-dlp`, `ffmpeg`, `ffprobe`) resolve through
  `libs/core/tool-binary-resolvers.ts` (`KYBERION_YTDLP_BIN`,
  `KYBERION_FFMPEG_BIN`, `KYBERION_FFPROBE_BIN`, then the managed binary, then
  the registry, then PATH).

### yt-dlp pinning

`knowledge/product/governance/tool-runtimes/yt_dlp.json` pins a managed
`yt-dlp` binary for each platform (release 2026.08.19). The sha256 values are
the digests from that release's `SHA2-256SUMS` (the macOS binary was downloaded
and re-hashed to confirm on 2026-09-26), and `scripts/tool_runtime_setup.ts`
refuses the download on any mismatch. An all-zero or malformed digest is still
treated as "not pinned": the managed binary is skipped with a warning and the
brew/winget `install_backend` is used instead. When bumping the version, copy
the new digests from the release's `SHA2-256SUMS`.
yt-dlp is Unlicense. The caller is responsible for complying with the source
site's terms of service.

## Set-of-Marks

- `mark_elements` gathers candidates through the `ui-element-detector` seam.
  The providers are `browser_dom` (snapshot element rects) and `ocr_text` (the
  fallback). It then fuses the candidates: an icon absorbs the text it covers,
  overlapping boxes are pruned, and marks are numbered in reading order. Marks
  are drawn on a **redacted** copy of the screenshot.
- Marks are stored in the session's volatile dir for 60 s, together with the
  image dHash. `system-actuator` (`target_mark`, used only when no coordinate
  is given) and `browser-actuator` (`click_ref: "mark:<n>"`) resolve
  `mark:<n>` into a ref or a logical point. An expired, missing or mismatched
  record is rejected with `[MARK_STALE]`: re-mark instead of clicking a stale
  target.
- `system-actuator` always compares the marks' image dHash with a fresh
  full-display capture (unique path under `active/shared/tmp/mark-target-checks/`,
  deleted in `finally`). A caller-supplied `current_dhash` is not accepted:
  `mark_elements` returns `image_dhash`, so echoing it back would defeat the
  check. Consequently, marks made from a window or region capture never match
  a display capture and are always `[MARK_STALE]` for system clicks — mark a
  full-display screenshot for `target_mark`.
- Mark labels never carry typed input: editable DOM elements (`input`,
  `textarea`, `contenteditable`/`editable`, textbox-like roles) get no label,
  whatever their name or text, and absorb no OCR text lying inside them.

## Image description

`vision:describe_image` sends pixels off the machine through the
`reasoning_vision` provider, so the provider only ever receives an OCR-redacted
copy (`createRedactedImageCopy`); when redaction fails nothing is sent. The
tier is the strictest of the declared `tier`, the image path and the mission
path, and a non-public image needs `mission_id` (`[VISION_TIER_SCOPE]`) so the
redaction copy is made inside the mission (`<mission>/tmp/vision-describe/`).
When both `mission_id` and `tenant_slug` are given (here and in
`describe_screen_delta`), the tenant must be the mission's own tenant (from its
state or its tenant directory); a mismatch, a tenant-less mission or an
unresolvable owner is refused with `[VISION_TIER_SCOPE]`.

Screen streams and recordings redact each frame through a scratch copy; under
a mission (`MISSION_ID`) that copy is made in `<mission>/tmp/screen-redaction/`,
otherwise in the shared tmp floor.

## OCR bounding-box units

`OcrResult.boundingBoxUnits` states the units of `lines[].boundingBox`:
`pixel` (tesseract, and the meaning when the field is absent) or `normalized`
(apple_vision, 0..1 with a top-left origin, emitted by `native-ocr.swift` as
`boundingBox: {x, y, width, height}`). Every consumer converts by the declared
units:

- `frame-redaction.ts` scales normalized boxes by the frame size before filling
  them. For any other unit value, or a box that is not finite, the frame is
  withheld (fails closed). Without the scaling, a normalized box would black
  out about one pixel and still report the frame as redacted.
- `set-of-marks.ts` converts normalized boxes into image pixels.
- `media-pdf-helpers.ts` uses the declared units and falls back to its
  provider/range heuristic only when the units are not declared.

## Dirty-tile screen description

`describe_screen_delta` splits a screenshot into a grid (4x4 by default) and
computes a dHash for each tile. Only tiles that moved more than 5 bits since
their last description are described again. A per-call budget
(`max_describe_per_call`) marks the remaining tiles stale, and they are
described first on the next call. The stats report `describe_calls_saved` and
`approx_tokens_saved`.

Tier safety: the tier is the strictest of the declared `tier`, the screenshot's
path and the mission's path. The vision channel judges crops by their location
(`[VISION_TIER_MISMATCH]`), so non-public crops are written under the mission
(`<mission>/tmp/vision-tiles/`). A non-public screen without `mission_id` is
refused with `[VISION_TIER_SCOPE]`. Every image is redacted before any crop
reaches the model.
