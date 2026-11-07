# Design system

Khaoyu Note uses one token vocabulary across the desktop app and the optional service pages.

## Core tokens

| Token | Dark default | Use |
| --- | --- | --- |
| `--ky-bg` | `#111111` (`--ph-chrome`) | Window and page background |
| `--ky-surface` | `#151515` (`--ph-window`) | Cards, dialogs, settings panes |
| `--ky-control` | `rgba(255, 255, 255, 0.055)` | Icon wells, inactive controls |
| `--ky-control-hover` | `rgba(255, 255, 255, 0.1)` | Hovered controls |
| `--ky-control-active` | `rgba(255, 255, 255, 0.14)` | Pressed controls |
| `--ky-text` | `#f7f7f7` | Primary text |
| `--ky-soft` | `#6b6b6b` | Secondary text |
| `--ky-muted` | `#a4a4a4` | Captions and hints |
| `--ky-stroke` | `rgba(255, 255, 255, 0.07)` | Normal borders and dividers |
| `--ky-line-strong` | `rgba(255, 255, 255, 0.12)` | Input and focus borders |
| `--ky-accent` | `#ecebe7` | Links, active states, status |
| `--ky-accent-bright` | `#ffffff` | Hover accent |
| `--ky-danger` | `#f5566f` | Destructive actions |
| `--ky-raise` | vertical highlight gradient | Raised rows |
| `--ky-radius-card` | `12px` | Panels and dialogs |
| `--ky-radius-control` | `7px` | Inputs and buttons |
| `--ky-control-height` | `24px` | Control height |
| `--ky-font` | Inter stack, overridden to Plus Jakarta Sans by `app.css` | UI text |
| `--ky-mono` | monospace stack, overridden to Space Mono by `app.css` | Code and IDs |

`--ky-*` values are aliases into the per-skin `--ph-*` palette, so restyling a skin restyles every
component. The table above resolves the dark fallback skin. There is no `--ky-surface-raised`,
`--ky-accent-strong` or `--ky-font-code`; use `--ky-raise`, `--ky-accent-bright` and `--ky-mono`.

The desktop app also exposes theme variants (`light`, `softLight`, `softDark`, `dark`) through its
`ky.css` token layer. New UI must reference tokens, not literal colors.

## Components

- Buttons: primary, secondary, quiet, danger.
- Inputs and selects: 7px radius (`--ky-radius-control`), strong border, accent focus ring.
- Panels and dialogs: surface background, 12px radius (`--ky-radius-card`), hairline stroke, popup
  shadow.
- Overlay behind dialogs: dimmed background with `backdrop-filter: blur(10px)` for popups and
  notifications that use opacity.
- Settings navigation: 13px labels, active accent background, 1px divider after the account group
  (Account and Backup) and before MCP.

## Service pages

`service/public/ky.css` is the same framework stylesheet used by the desktop app
(`app/web/vendor/ky.css`). Every service page loads it first, then `service/public/ui.css`, a small
layout layer for the auth panel. Pages use the real `.ky-scope`, `.ky-panel`, `.ky-title`,
`.ky-label`, `.ky-input` and `.ky-button` components, so buttons, inputs, typography, focus rings and
surfaces match the app rather than a hand-written token copy.

When the vendored framework changes, copy it to `service/public/ky.css` and re-run the account,
passkey, sharing and share viewer suites. The service CSP allows `style-src 'self' 'unsafe-inline'`
for the stylesheet links and any page-level inline attributes.

## Settings structure

```
Account        (service connection, account, passkeys, sharing pages)
Backup         (back up now, export ZIP, open folder)
---
General        (language + general preferences)
Appearance     (theme, fonts, motion, canvas)
Tools          (two-column icon grid)
Performance
---
MCP
About
```

Account is the first pane. Backup is the second pane and owns the local backup controls that used to
sit inside Account. Language lives inside General and Canvas lives inside Appearance; both were
removed as separate panes. Tools is a two-column grid with the tool icon on the left and the name on
the right, and clicking a card toggles tool visibility.

## Rules

1. Use tokens for every color, radius, font and shadow.
2. Do not introduce a new literal hex value in app or service UI.
3. Keep one visual language for desktop and service pages.
4. Any popup with a translucent backdrop must also blur the content behind it.
5. Update this document and the in-app Help > Documentation page when a system interface changes.
