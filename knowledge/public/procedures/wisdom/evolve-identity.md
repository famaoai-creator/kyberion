# Procedure: Identity Evolution & Wisdom Distillation

## 1. Goal
Extract latent wisdom from successful missions and manage identity patches to evolve the agent's persona.

## 2. Dependencies
- **Actuator**: `Wisdom-Actuator`
- **Storage**: `knowledge/evolution/latent-wisdom/`

## 3. Step-by-Step Instructions
1.  **Audit**: Use `Wisdom-Actuator` with `mirror` to detect cognitive drift in completed missions.
2.  **Distillation**: Use `Wisdom-Actuator` with `distill` to extract divergent logic from `LEARNINGS.md` into a Persona Patch.
    ```json
    {
      "action": "distill",
      "missionId": "MSN-MOLTBOOK-INDEPENDENCE"
    }
    ```
3.  **Activation**: When a specific operational mode is needed, use `Wisdom-Actuator` with `swap` to load the patch.
4.  **Tier Sync**: Use `Wisdom-Actuator` with `sync` to ensure knowledge is correctly replicated across Public/Confidential tiers.

## 4. Expected Output
A version-controlled, cryptographically signed history of the agent's identity and capabilities.
