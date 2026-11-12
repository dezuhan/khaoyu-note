# Shared theme source

This directory is the single source of truth for the Khaoyu visual language. Everything the main
app and the self-hosted service pages display comes from here:

| File | Purpose | Generated copies |
| --- | --- | --- |
| `ky.css` | token vocabulary and component styles (`--ky-*` semantic tokens, `--ky-palette-*` skins) | `app/web/vendor/ky.css`, `service/public/ky.css` |
| `ky.js` | vendored component runtime (selects, toggles) | `app/web/vendor/ky.js` |
| `fonts.css`, `fonts/` | Plus Jakarta Sans, Space Mono and the editor display fonts | `app/web/css/fonts.css`, `app/web/fonts/`, `service/public/fonts.css`, `service/public/fonts/` |
| `icons.js` | inline SVG icon set used by both UIs | `app/web/js/icons.js`, `service/public/icons.js` |
| `theme.js` | shared runtime: read/apply/store/init theme | `app/web/js/theme.js`, `service/public/theme.js` |
| `theme-init.js` | applies the saved theme on service pages without a toggle | `service/public/theme-init.js` |
| `khaoyu-note.svg` | brand mark | `app/web/assets/khaoyu-note.svg`, `service/public/khaoyu-note.svg` |
| `favicon-32.png`, `favicon-180.png` | browser tab and touch icons rendered from the brand mark | `app/web/assets/`, `service/public/` |

## Rules

1. Edit files in `shared/theme/`, never the generated copies.
2. Run `npm run theme:sync` after a change; commit both the source and the generated copies.
3. CI runs `npm run theme:check`; it fails when a generated copy drifts from the source.
4. Colour and geometry use the token vocabulary: `--ky-*` for semantic tokens and
   `--ky-palette-*` for raw palette entries. Do not introduce literal colours in app or service CSS.
5. Adding a skin means adding a `[data-ky-theme="name"] { --ky-palette-* ... }` block in `ky.css`
   and adding the name to `SKINS` in `theme.js`; components must not change.
