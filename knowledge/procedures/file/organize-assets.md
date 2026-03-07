# Procedure: Physical File Organization & Curation

## 1. Goal
Organize, rename, and manage the physical placement of project assets, datasets, and evidence files.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  **Inventory**: List all files in the source directory using `File-Actuator`.
2.  **Curation**: Identify redundant or temporary files (`.tmp`, `.log`) for deletion.
3.  **Relocation**:
    - Use `File-Actuator` with `read` and `write` (simulated move) to relocate assets to standardized directories (e.g., `vault/`, `evidence/`).
4.  **Metadata Update**: Update any pointers or index files using `File-Actuator` to reflect the new file locations.

## 4. Expected Output
A lean, organized, and standardized filesystem state.
