---
name: design-tokens
description: Create, extend, migrate, or audit DTCG token files using the primitive-to-semantic-to-component architecture. Use when tokens themselves are the deliverable or source of truth. Do not use for a complete brand identity (brandkit), visual direction only (apply-aesthetic), or UI implementation (design-code).
invocation: model
---

# Skill: Design Tokens

Produce and maintain DTCG (`$type`/`$value`) tokens following the project's 3-tier system.

## Steps
1. Read `.claude/rules/tokens-and-color.md` → "Token System" + "Color Guidelines" and `.claude/rules/typography-and-spacing.md` for the rules (4px base, Major Third scale, OKLCH palette generation, dark-mode-at-semantic-layer).
2. Read the relevant existing files in `tokens/` to match structure: `colors.json`, `typography.json`, `spacing.json`, `shadows.json`, `borders.json`, `breakpoints.json`, `motion.json`, `gradients.json`, `opacity.json`, `blur.json`, `sizing.json`, `states.json`, `theming.json`.
3. Generate/extend tokens:
   - Primitives = raw values (never used directly). Semantic = purpose aliases. Component = component-scoped.
   - New palettes: generate 11 OKLCH shades; verify 500 ≥ 4.5:1 on white (text), 600 ≥ 3:1 (UI) using the `a11y-audit` skill / `scripts/contrast.py`.
   - Multi-brand/density → `theming.json`.
4. **Validate**: run `python3 scripts/validate_tokens.py` (JSON validity + alias resolution).

## Output
DTCG JSON. Preserve `$description` on every token. Reference, never hardcode.
