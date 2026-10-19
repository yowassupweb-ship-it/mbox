---
name: apply-aesthetic
description: Choose and apply a visual direction to an existing design foundation by resolving an archetype or named design system into tokens. Use when the request is primarily about look, vibe, or art direction. Do not use for a full brand system (brandkit), a broad existing-product overhaul (redesign), or implementation-only work (design-code).
invocation: model
---

# Skill: Apply Aesthetic

Choose and apply a design direction without breaking accessibility.

## Steps
1. **Brief Inference first (mandatory)** — before any tokens, name it: industry/domain, audience & tone, the one mood adjective the result must earn, motion depth, and the layout-family sequence (`taste/design-taste.md` → Brief Inference + Variance Mandate). Generating before deciding = slop.
2. Pick a direction in `taste/aesthetic-systems.md`:
   - An **archetype** (recipe mapped to our tokens), or
   - A **named library system** — browse with `python3 scripts/design_systems.py list` (or `search <term>` / `show <name>`); specs live in `design-systems/library/<name>/DESIGN.md`.
3. Apply the **Library Contract** (in `aesthetic-systems.md`): re-point `semantic.*` tokens to the chosen system's color roles; map typography/spacing/radius/shadow/motion to `tokens/*.json`.
4. **Verify contrast** of every mapped color pair (`scripts/contrast.py` / `a11y-audit`). A brand value that fails must be adjusted — taste never overrides POUR.
5. Add motion per `taste/motion-choreography.md`; run the pre-flight aesthetic check in `design-taste.md`.

## Output
Updated/overridden semantic tokens + notes on type/space/motion, then render via `design-code`. Confirm the result passes both the aesthetic check and accessibility.
