# Voice Engines

Canonical per-engine registry entries for the voice engine catalog.

Each file must contain exactly one `engines` entry and must match the file name:

- `local_say.json`
- `espeak_ng.json`
- `open_voice_clone.json`
- `mlx_audio_qwen3.json`
- `kokoro.json`
- `pocket_tts.json`

`voice-engine-registry.json` remains the compatibility snapshot until all consumers are migrated.

## Languages

Every engine declares `languages`: the BCP-47 primary subtags it speaks through
Kyberion's runtime path, or `["*"]` when the host's installed voices decide
(`local_say`). The reason for each list is kept in `language_notes`. Lists are
deliberately conservative: the TypeScript runtime passes only `ja`/`en` as
`lang_code` to the Python bridges, so bridge engines declare at most those two
even when the upstream model covers more.

| engine             | languages  | basis                                                                     |
| ------------------ | ---------- | ------------------------------------------------------------------------- |
| `local_say`        | `*`        | OS voices (macOS `say`, Linux `espeak`, Windows SAPI); voice per language |
| `espeak_ng`        | `en`, `ja` | bridge receives only `ja`/`en`                                            |
| `kokoro`           | `ja`, `en` | bridge maps `ja` → `j` pipeline, everything else → American English       |
| `mlx_audio_qwen3`  | `ja`, `en` | bridge receives only `ja`/`en` (upstream Qwen3-TTS covers more)           |
| `pocket_tts`       | `en`       | bridge rejects `ja`; no language-pack selection for fr/de/pt/it/es        |
| `gemini_tts`       | `en`, `ja` | only en/ja exercised here (upstream auto-detects more)                    |
| `open_voice_clone` | `en`       | shadow placeholder, coverage unknown                                      |

Engines behind `tts_adapter_id: external_provider` (`gemini_tts`,
`open_voice_clone`) have no Kyberion TTS runtime adapter yet, so governed
selection never picks them (`no runtime adapter`).

## Engine selection (voice-tts-engine seam)

Policy: `../seam-provider-selection/voice-tts-engine.json` (purposes
`naturalness`, `latency`, `privacy`; fallback purpose `privacy`).

- A named engine (`speak_local` `engine_id`, `generate_voice`
  `engine.engine_id` other than `auto`) always wins; a language it does not
  declare only adds a `warnings` entry.
- Otherwise selection runs only when a `purpose` is given, an operator rule
  matches the request (`kyberion seam select rules set --seam voice-tts-engine
--context language=ja ...`), or the engine the op would use today cannot run
  the request (language, format, local-only, identity) — then the policy's
  fallback purpose ranks what can. The request language is the explicit
  `language` / `rendering.language`, else a script-based guess (kana → ja,
  Hangul → ko, Han only → zh, else en).
- Identity guard: a personal voice (`enforce_clone_engine_for_personal_tier`
  or `require_personal_voice`) is never switched for preference; only when its
  clone engine cannot speak the request may another clone engine (same
  reference samples) take over, else `generate_voice` returns `blocked`. A
  profile with reference samples and a stock engine never becomes a clone.
- Intended change: a default engine that cannot speak the text (e.g.
  `pocket_tts` asked for Japanese) is no longer tried and silently walked down
  the fallback chain; the choice is made up front, audited, and reported as
  `engine_selection`.

Calibrate by listening: put `{"text": "...", "language": "ja"}` in a JSON file
and run `pnpm kyberion seam select calibrate --seam voice-tts-engine --input
<file>`; the report lists each engine's `artifact_path`. Engines that leave the
machine run only when listed in `--providers`.
