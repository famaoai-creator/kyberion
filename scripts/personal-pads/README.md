# Personal pads (localhost artifact-review ports)

Thin index of the five personal capture pads. Each is a **127.0.0.1-only** twin of meeting-notepad / sketch-input (`artifact-review-port`). Shared helpers live in `scripts/lib/local-artifact-pad.ts`.

| Pad                                            | Port | One-liner                                           |
| ---------------------------------------------- | ---: | --------------------------------------------------- |
| [memory-capture](../memory-capture/)           | 8149 | Brain-dump notes/tags → memory handoff              |
| [screenshot-annotate](../screenshot-annotate/) | 8150 | Screenshot + annotations → vision handoff           |
| [clipboard-inbox](../clipboard-inbox/)         | 8151 | Clipboard snippets → inbox handoff                  |
| [daily-desk](../daily-desk/)                   | 8152 | Journal / TODO / NOW desk → daily-desk handoff      |
| [doc-drop](../doc-drop/)                       | 8153 | File drop (pdf/images/txt/md/docx) → ingest handoff |

## Quick dry-run

```bash
node_modules/.bin/tsx scripts/daily-desk/server.ts --dry-run --json
node_modules/.bin/tsx scripts/doc-drop/server.ts --dry-run --json
```

Related: `scripts/meeting-notepad/` (8148), `scripts/sketch-input/` (8147).
