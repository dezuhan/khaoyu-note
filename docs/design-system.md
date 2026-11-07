# Design system

Khaoyu Note uses one token vocabulary across the desktop app and the optional service pages.

## Core tokens

| Token | Dark default | Use |
| --- | --- | --- |
| `--ky-bg` | `#111111` | Window and page background |
| `--ky-surface` | `#1b1b1b` | Cards, dialogs, settings panes |
| `--ky-surface-raised` | `#202020` | Rows and raised cards |
| `--ky-control` | `#242424` | Icon wells, inactive controls |
| `--ky-control-hover` | `#2c2c2c` | Hovered controls |
| `--ky-text` | `#eeeeee` | Primary text |
| `--ky-soft` | `#b3b3b3` | Secondary text |
| `--ky-muted` | `#8a8a8a` | Captions and hints |
| `--ky-stroke` | `#333333` | Normal borders and dividers |
| `--ky-stroke-strong` | `#4a4a4a` | Input and focus borders |
| `--ky-accent` | `#9ad4ff` | Links, active states, status |
| `--ky-accent-strong` | `#c4e6ff` | Hover accent |
| `--ky-danger` | `#ff8b8b` | Destructive actions |
| `--ky-radius` | `10px` | Panels and dialogs |
| `--ky-radius-control` | `6px` | Inputs and buttons |
| `--ky-font` | Plus Jakarta Sans stack | UI text |
| `--ky-font-code` | JetBrains Mono stack | Code and IDs |

The desktop app also exposes theme variants (`light`, `softLight`, `softDark`, `dark`) through its
`ky.css` token layer. New UI must reference tokens, not literal colors.

## Components

- Buttons: primary, secondary, quiet, danger.
- Inputs and selects: 6px radius, strong border, accent focus ring.
- Panels and dialogs: surface background, 10px radius, hairline stroke, popup shadow.
- Overlay behind dialogs: dimmed background with `backdrop-filter: blur(10px)` for popups and
  notifications that use opacity.
- Settings navigation: 13px labels, active accent background, 1px divider after the account group
  and before MCP.

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
Account
---
General        (language + general preferences)
Appearance     (theme, fonts, motion, canvas)
Tools          (two-column icon grid)
Performance
---
MCP
About
```

Account is the first pane. Language lives inside General and Canvas lives inside Appearance; both
were removed as separate panes. Tools is a two-column grid with the tool icon on the left and the
name on the right, and clicking a card toggles tool visibility.

## Rules

1. Use tokens for every color, radius, font and shadow.
2. Do not introduce a new literal hex value in app or service UI.
3. Keep one visual language for desktop and service pages.
4. Any popup with a translucent backdrop must also blur the content behind it.
5. Update this document and the in-app Help > Documentation page when a system interface changes.
