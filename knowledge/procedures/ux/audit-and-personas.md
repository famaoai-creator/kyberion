# Procedure: UI/UX Audit & Persona Generation

## 1. Goal
Audit user interfaces for accessibility/UX issues and generate synthetic user personas to guide design decisions.

## 2. Dependencies
- **Actuator**: `File-Actuator` (Code Parsing)
- **Actuator**: `Wisdom-Actuator` (Persona Synthesis)

## 3. Step-by-Step Instructions
1.  **UX Audit**:
    - Use `File-Actuator` (search) to scan `.html`, `.jsx`, `.tsx` files for missing `alt` tags, hardcoded styles, or missing ARIA labels.
    - Generate an accessibility report.
2.  **Persona Synthesis**:
    - Based on the target product description, generate synthetic personas.
    - Use `Wisdom-Actuator` to format these personas into structured ADF data.
    - Save the personas to `knowledge/design/personas/` using `File-Actuator`.

## 4. Expected Output
A comprehensive UX audit report and structured synthetic user personas.
