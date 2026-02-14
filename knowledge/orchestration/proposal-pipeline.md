# Professional Proposal Pipeline (Orchestration Pattern)

This workflow defines the autonomous sequence for generating high-impact, brand-aligned business proposals.

## Workflow Steps:

1. **Research Phase**:
   - Tool: `google_web_search`
   - Goal: Identify client's core business, brand visual identity (colors, logos), and current technological challenges.
2. **Strategy Phase**:
   - Tool: `stakeholder-communicator`
   - Reference: `knowledge/strategy/winning-proposal-standards.md`
   - Goal: Draft a narrative focused on ROI, competitive benchmarks, and "Pain & Gain" storytelling.
3. **Visual Design Phase**:
   - Tool: `layout-architect`
   - Reference: `knowledge/templates/themes/theme_design_guide.md`
   - Goal: Generate a custom Marp CSS theme in `knowledge/templates/themes/` reflecting the client's brand.
4. **Graphic Generation Phase**:
   - Tool: `diagram-renderer`
   - Goal: Create high-resolution SVG diagrams (funnels, architecture, comparisons) to support the strategy.
5. **Final Production Phase**:
   - Tool: `ppt-artisan`
   - Goal: Compile all assets into a final, visual-first PowerPoint file using absolute paths and the custom theme.
