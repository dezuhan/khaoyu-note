# Design system audit

Date: 2026-11-06. Scope: Khaoyu Note web UI against the vendored Khaoyu CSS.

## Method

- Enumerated every rendered button, input, textarea, select and contenteditable element.
- Read the Khaoyu component and token rules for `.ky-button`, `.ky-input`, `.ky-select`, `.ky-check` and focus rings.
- Checked app CSS for hover, focus, active and disabled rules.
- Verified representative computed styles in Chromium with Playwright.
- Scripts: `tools/audit-design-system.mjs` and `tools/audit-interaction-states.mjs`.

## Token usage

The app consistently uses the Khaoyu token layer for color, surfaces, radii, control height, typography, focus glow and animation timing.

Used tokens include:

- `--ky-bg`, `--ky-surface`, `--ky-text`, `--ky-muted`, `--ky-soft`
- `--ky-control`, `--ky-control-hover`, `--ky-control-active`, `--ky-raise`
- `--ky-hairline`, `--ky-stroke`, `--ky-accent`, `--ky-accent-bright`
- `--ky-radius-control`, `--ky-radius-card`, `--ky-control-height`
- `--ky-glow-input-focus`, `--ky-shadow-popup`
- `--ky-font`, `--ky-mono`, `--ky-text-base`, `--ky-button`
- `--ky-duration-popover`, `--ky-ease-standard`

Some app-specific geometry remains hardcoded, for example 20 to 26 px compact buttons and 5 to 6 px custom radii. These are intentional card-level sizes, not a color or state violation.

## State matrix

| Component group | Hover | Focus visible | Active | Disabled | Result |
| --- | --- | --- | --- | --- | --- |
| `.mn-btn`, primary, quiet, danger | yes | accent ring | yes | opacity | matches `.ky-button` behavior |
| `.mn-icon-btn` | yes | accent ring | yes | opacity | complete |
| `.mn-menubar-btn` | yes | accent ring | yes | n/a | complete |
| `.mn-topbar-search` | yes | accent ring | yes | n/a | complete |
| `.mn-primary-soft` | yes | accent ring | yes | n/a | complete |
| `.mn-ghost-btn` | yes | accent ring | yes | n/a | complete |
| `.mn-tool` | yes | accent ring | yes | n/a | complete |
| `.mn-field-input` and card inputs | no custom hover | Khaoyu input glow | native | native | complete for focus |
| `.ky-input` (document, home, settings) | no custom hover | Khaoyu input glow | native | opacity for disabled | design system behavior |
| `.ky-select` | trigger hover | trigger and select focus ring | open state | disabled style | complete |
| Checkboxes | parent hover | checkbox focus ring | native checked | native | complete |
| Compact add/remove controls | parent hover or own hover | accent ring | pressed background | n/a | complete |

## Changes made from this audit

- Menu bar now sits above the header; logo and menus, centered command search, and icon actions share a fixed three-column grid.
- Global keyboard focus ring follows Khaoyu: 2 px accent outline for buttons, links and summaries; input glow for inputs, textareas, selects and contenteditable.
- Added pressed states for `.mn-btn` and `.mn-icon-btn`.
- Added pressed states for compact tool, zoom, kanban, table, logo, template, trash, link and color controls.
- Added hover, pressed and focus states to the menubar and header search.

## Remaining gaps

- The app uses custom `.mn-*` button and field classes instead of applying `.ky-button` and `.ky-input` everywhere. State behavior now matches, but class duplication makes future theme changes harder.
- Board cards and some card internals are pointer-operated and are not keyboard focusable. Keyboard and screen-reader navigation still needs a dedicated accessibility pass.
- Some compact controls intentionally appear only on parent hover, which is not discoverable by touch or keyboard. The most important ones also appear on focus, but not all.
- The vendored Khaoyu CSS does not cover `.mn-*` components directly; the app layer owns the state rules.
- No forced-colors or high-contrast audit has been done.

## Verification

- UI suite: 213/213.
- Representative hover test: menubar background changes from transparent to `rgba(0, 0, 0, 0.055)`.
- Keyboard focus: menubar button receives the Khaoyu 2 px accent outline.
- No runtime errors in the audit run.
