---
name: layout-architect
description: Converts visual designs (images/screenshots) into implementation code (CSS, Python-pptx, HTML). Use when recreating slide layouts or UI designs from images.
---

# Layout Architect

This skill specializes in **Visual Reverse Engineering**. It analyzes input images (screenshots of slides, websites, or app UIs) and generates the precise code required to reproduce that design.

## Capabilities

1.  **Slide Reproduction**:
    - **Image to Marp CSS**: Creates custom themes for Markdown-to-slide conversion.
    - **Image to Editable PPTX**: Generates `python-pptx` scripts to build native PowerPoint slides with editable text and shapes.
2.  **UI Reproduction**:
    - **Image to Code**: Converts UI screenshots into HTML/Tailwind, React, or pure CSS.

## Workflow

### 1. Asset Extraction (If input is PPTX)
If the user provides a `.pptx` file instead of an image, first extract the media assets to "see" the design.
```bash
node layout-architect/scripts/extract_images.cjs <path_to_pptx> <output_dir>
```
Then, read the extracted images (e.g., `Slide1.png`, `image1.png`) to analyze the design.

### 2. Visual Analysis
Before writing code, analyze the image and define the **Design System**.
- **Color Palette**: Identify primary, secondary, and accent colors. Estimate HEX codes (e.g., `#2E65D1`).
- **Typography**: Serif vs Sans-serif, font sizes, weights, and hierarchy.
- **Layout**: Grid structure, margins, padding, and alignment.
- **Decorations**: Borders, shadows, gradients, rounded corners.

### 3. Code Generation

Choose the appropriate output format based on user request.

#### Mode A: Editable PowerPoint (`python-pptx`)
**Goal**: Create a native `.pptx` file where text and shapes are fully editable.
- **Do NOT** just place the screenshot as a background.
- **DO** use `shapes.add_shape()` and `shapes.add_textbox()` to reconstruct the layout.
- **Script Structure**:
  1.  Imports (`pptx`, `RGBColor`, `Inches`, `Pt`).
  2.  **Constants**: Define colors (`PRIMARY_BLUE = RGBColor(...)`) and dimensions.
  3.  **Functions**: Create helper functions like `create_header_slide()` or `add_footer()`.
  4.  **Content**: Define text content in a dictionary/list to separate data from layout.
  5.  **Execution**: Generate the file.

#### Mode B: Marp Theme (CSS)
**Goal**: Create a Markdown-driven slide deck with custom styling.
- Use `section { ... }` to define global slide styles (background, padding).
- Use `header`, `footer`, and `::after` pseudo-elements for logos and page numbers.
- Use `linear-gradient` to reproduce geometric background shapes.

#### Mode C: Web UI (HTML/Tailwind)
**Goal**: Create a responsive web component.
- Use semantic HTML.
- Use Tailwind utility classes for rapid styling reproduction.

## Best Practices

- **Accuracy**: Strive for pixel-perfect layout reproduction. Use specific units (px, Inches) rather than vague positioning.
- **Maintainability**: Use variables/constants for colors and sizes.
- **Assets**: If logos or icons are present in the image, ask the user if they have the assets or use placeholders/extracted files.