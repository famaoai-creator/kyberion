---
name: ppt-artisan
description: Create and convert PowerPoint presentations from Markdown using Marp. Use when the user wants to generate slides, manage themes, or convert MD to PPTX/PDF.
---

# PowerPoint Artisan (ppt-artisan)

This skill creates high-impact, boardroom-ready presentations. It goes beyond simple Markdown conversion by integrating with custom brand themes and high-resolution visual assets.

## Capabilities

### 1. Visual-First Presentation Generation
- **Theme Awareness**: Automatically checks `knowledge/templates/themes/` for client-specific CSS before falling back to default themes.
- **High-Impact Layouts**: Leverages the `theme_design_guide.md` to structure information using cards, multi-column grids, and "Lead" slides.
- **Asset Integration**: Mandates the use of absolute paths for images and prefers SVG diagrams (from `diagram-renderer`) for scalability.

### 2. Multi-Format Conversion
- **PPTX**: Default format for editable presentations.
- **PDF/HTML**: Formats for quick preview and digital distribution.

## Workflow (Integrated)

1.  **Context Check**: Look for existing brand assets or themes in `knowledge/templates/themes/`.
2.  **Visual Layout**: Draft Markdown using `class: lead`, `class: default`, and `.columns` / `.card` containers.
3.  **Conversion**: Execute `node scripts/convert.cjs <input.md> pptx --theme <brand_name>`.

## Usage Examples

- "Generate a PowerPoint for the [Client] proposal using the appropriate theme and SVG assets."
- "Convert this Markdown to PDF, ensuring all local images are embedded correctly."

## Commands

```bash
# Convert to PPTX with custom theme lookup
node ppt-artisan/scripts/convert.cjs ./my-presentation.md pptx --theme custom-brand

# Convert to EDITABLE PPTX (Native shapes and text)
node ppt-artisan/scripts/convert.cjs ./my-presentation.md pptx --editable-pptx
```

## Best Practices
- **1-Slide-1-Message**: Avoid wordy slides; use visual metaphors suggested by `stakeholder-communicator`.
- **High Fidelity**: Always use `--allow-local-files` (handled by the script) to ensure images render.
## Knowledge Protocol
- This skill adheres to the `knowledge/orchestration/knowledge-protocol.md`. It automatically integrates Public, Confidential (Company/Client), and Personal knowledge tiers, prioritizing the most specific secrets while ensuring no leaks to public outputs.
