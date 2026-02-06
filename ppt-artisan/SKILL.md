---
name: ppt-artisan
description: Create and convert PowerPoint presentations from Markdown using Marp. Use when the user wants to generate slides, manage themes, or convert MD to PPTX/PDF.
---

# PowerPoint Artisan (ppt-artisan)

This skill helps users create professional presentations using Markdown and Marp. It provides templates, manages custom themes, and handles the conversion process to PowerPoint (.pptx) or PDF.

## Workflow

1.  **Select a Template**: Choose a template based on the presentation type.
2.  **Edit Content**: Write the presentation in Markdown.
3.  **Convert**: Transform the Markdown file into a PPTX or PDF file.

## Available Resources

### Templates

Use these templates to start a new presentation.

-   **Business**: `assets/templates/business.md` (Theme: `business`) - Clean, blue/corporate style.

### Themes

Custom themes are located in `assets/themes/`.

-   `business.css`: Standard corporate theme.

### Reference

-   **Cheatsheet**: See `references/marp-cheatsheet.md` for syntax and layout guides.

## Commands

### 1. Create a New Presentation

Copy a template to the user's working directory.

```bash
# Example: Create a business presentation
cp <path-to-skill>/assets/templates/business.md ./my-presentation.md
```

### 2. Convert Presentation

Use the helper script to convert Markdown to PPTX (default) or PDF. The script automatically loads custom themes from the skill's `assets/themes` directory.

```bash
# Convert to PPTX
node <path-to-skill>/scripts/convert.cjs ./my-presentation.md pptx

# Convert to PDF
node <path-to-skill>/scripts/convert.cjs ./my-presentation.md pdf
```

## Tips

-   **Images**: Place images in the same directory as the Markdown file or a subdirectory (e.g., `./images/`).
-   **Preview**: There is no live preview in the CLI. Users should convert to PDF for a quick check if they don't have PowerPoint installed, or use a Marp extension in their editor if available.