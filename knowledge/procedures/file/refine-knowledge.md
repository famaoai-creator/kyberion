# Procedure: Knowledge Refinement & Sanitization

## 1. Goal
Improve the clarity, consistency, and ethical compliance of knowledge files (Markdown, JSON).

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  **Selection**: Use `File-Actuator` with `list` or `search` to identify files needing refinement (e.g., outdated content, missing headers).
2.  **Ethics Audit**: 
    - Search for potential ethical violations or biased language using `File-Actuator`.
    - Pattern match against `knowledge/ethics/review_checklist.md`.
3.  **Refinement**: 
    - Read the file content using `File-Actuator`.
    - Apply AI-driven improvements (fixing typos, structural reorganization).
    - Write back the polished content using `File-Actuator`.
4.  **Sync Check**: Verify the file is correctly indexed in `knowledge/_index.md`.

## 4. Expected Output
A high-fidelity, compliant, and well-structured knowledge asset.
