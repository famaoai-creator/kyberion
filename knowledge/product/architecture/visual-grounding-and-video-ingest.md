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
  then auto subtitles (rolling caption lines are deduplicated), then a
  speech-to-text bridge that declares segment timestamps.
- Remote hosts must be in `knowledge/product/governance/video-ingest-policy.json`
  `allowed_hosts`, and the URL is also checked against the egress policy.
  `require_approval_for_remote` (default true) sends every uncached remote
  fetch through the risky-op approval gate (`vision:fetch_video`). If the
  caller passes no `approval` context, or approval is still pending, the op
  returns `status: approval_required` instead of failing. Other failures throw
  `[VIDEO_<CODE>]`. For example, `[VIDEO_EXTRACTOR_OUTDATED]` includes a
  remediation to bump and reinstall yt-dlp. The actuator never updates yt-dlp
  itself.
- Cache: content key = sha256(normalized URL + format) or sha256(file bytes).
  The cache goes to the mission when `mission_id` is given, else the tenant's
  volatile area when `tenant_slug` is given, else
  `active/shared/cache/video-ingest/` (public). A local file is never cached in
  a lower tier than its input (`TIER_DOWNGRADE`). A cache hit runs no external
  command.
- External binaries (`yt-dlp`, `ffmpeg`, `ffprobe`) resolve through
  `libs/core/tool-binary-resolvers.ts` (`KYBERION_YTDLP_BIN`,
  `KYBERION_FFMPEG_BIN`, `KYBERION_FFPROBE_BIN`, then the managed binary, then
  the registry, then PATH).

### yt-dlp pinning

`knowledge/product/governance/tool-runtimes/yt_dlp.json` pins a managed
`yt-dlp` binary for each platform. **The sha256 values are placeholders (all
zeros)**, so a managed install fails closed: `scripts/tool_runtime_setup.ts`
refuses an all-zero checksum before any download. To enable managed installs,
copy the real digests from the release's `SHA2-256SUMS` into the registry. Until
then, use `KYBERION_YTDLP_BIN`, the brew/winget backends, or a system `yt-dlp`.
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
