# Procedure: Release Documentation & Guided Wizards

## 1. Goal
Generate structured release notes, onboarding guides, and requirements definitions using automated wizards and template injection.

## 2. Dependencies
- **Actuator**: `Media-Actuator` (Document Assembly)
- **Actuator**: `File-Actuator` (Template Management)

## 3. Step-by-Step Instructions
1.  **Change Harvesting**: Use `File-Actuator` to extract recent git commits or mission history from `operations/mission_history.md`.
2.  **Template Selection**: Pick the appropriate template (e.g., `templates/reporting/status_report.md`).
3.  **Assembly**:
    - Use `Media-Actuator` with `assemble` to inject harvested data into the template.
    - Convert to the target format (PDF/DOCX) using `Media-Actuator` (convert).
4.  **Wizard Execution**: For interactive setup, use `System-Actuator` (notify) to prompt the Sovereign for missing parameters.

## 4. Expected Output
Ready-to-publish release notes or a complete onboarding/requirements artifact.
