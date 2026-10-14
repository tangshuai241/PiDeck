# T3 theme palettes

Source: T3 Code, commit `7f6325848e57cfb7d29bf3154496657127def8f2`.

- `t3-palettes.json` retains the original values from `packages/shared/src/themePalettes.ts` for the roles used by PiDeck. It contains six themes, each with light and dark variants.
- `t3Themes.ts` adapts the orb artwork from `packages/shared/src/themePreview.ts` and `apps/web/src/components/settings/ThemePreviewCircles.tsx`. The T3 Code artwork intentionally uses different accent values from its controls.
- `scripts/generate-t3-theme-css.mjs` maps source roles to existing PiDeck tokens. Run it after changing the palette data. The generated CSS contains tokens only. Status colors keep their existing PiDeck meanings.
- The slow pigment rotation is a PiDeck addition. This source revision renders static orbs. The surrounding page does not animate.
- Legacy themes and saved IDs remain available. Selecting a T3 theme does not change the application layout.

Copyright (c) 2026 T3 Tools Inc. See [MIT license](T3-LICENSE.txt).
