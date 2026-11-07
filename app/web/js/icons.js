// Inline SVG icon set. Stroke-based, 24x24 viewBox, currentColor.

const P = (inner, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra} aria-hidden="true">${inner}</svg>`;

export const ICONS = {
  note: P('<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  link: P(
    '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.2-2.2a4.5 4.5 0 0 0-6.4-6.4l-1.3 1.3"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.2 2.2a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3"/>'
  ),
  todo: P(
    '<rect x="3.5" y="4" width="5" height="5" rx="1.2"/><path d="M12 6.5h8.5"/><rect x="3.5" y="15" width="5" height="5" rx="1.2"/><path d="M12 17.5h8.5"/>'
  ),
  line: P('<path d="M5 19 19 5"/><path d="M13.5 5H19v5.5"/>'),
  board: P(
    '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.5"/>'
  ),
  column: P(
    '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M5 8.5h14M5 13.5h14M5 18.5h14"/>'
  ),
  comment: P('<path d="M20.5 12a8 8 0 0 1-8 8H5.5l-2 2V12a8 8 0 0 1 8-8h1a8 8 0 0 1 8 8Z"/><path d="M8.5 12h.01M12 12h.01M15.5 12h.01"/>'),
  bell: P('<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10Z"/><path d="M10 18.5a2.2 2.2 0 0 0 4 0"/>'),
  table: P(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M15 9.5v10"/>'
  ),
  sketch: P('<path d="M4 20c3-1 4.5-3 6.5-6S15 6 17.5 4c2.5 2 3 5 1.5 8-1.5 3-4 4.5-7 6-3 1.5-5.5 2-8 2Z"/><path d="M4 20l3-3"/>'),
  color: P(
    '<rect x="3.5" y="3.5" width="11" height="11" rx="2"/><rect x="9.5" y="9.5" width="11" height="11" rx="2"/>'
  ),
  eyedropper: P(
    '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-6.4-6.4a2.1 2.1 0 0 1 0-3l.4-.4Z"/>'
  ),
  document: P(
    '<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>'
  ),
  audio: P('<path d="M4 9.5v5M8 6.5v11M12 3.5v17M16 7.5v9M20 10.5v3"/>'),
  globe: P('<circle cx="12" cy="12" r="8.5"/><path d="M3.8 12h16.4"/><path d="M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5S9.4 5.9 12 3.5Z"/>'),
  database: P('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>'),
  shield: P('<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>'),
  play: P('<path d="M8.5 6.2v11.6L18 12z" fill="currentColor" stroke="none"/>'),
  pause: P('<rect x="8" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="6" width="3" height="12" rx="1" fill="currentColor" stroke="none"/>'),
  volume: P('<path d="M4 10v4h3l4 3.2V6.8L7 10H4z"/><path d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7 7 0 0 1 0 10.4"/>'),
  volumeOff: P('<path d="M4 10v4h3l4 3.2V6.8L7 10H4z"/><path d="M15 10.2l4 3.6M19 10.2l-4 3.6"/>'),
  map: P('<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>'),
  video: P('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M10.5 9.5l5 2.5-5 2.5z"/>'),
  heading: P('<path d="M6 5v14M18 5v14M6 12h12"/>'),
  image: P(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5 9.5 13l4 3.5 3-2.5 3.5 3"/>'
  ),
  upload: P('<path d="M12 16V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/>'),
  download: P('<path d="M12 4v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 19.5h14"/>'),
  pointer: P('<path d="M6.8 4.2 19.4 12l-5.6 1.8 2 5.4-2.4 1-2.1-5.4-4.5 4z" stroke-width="2.1"/>'),
  eraser: P('<path d="M8.5 19H20"/><path d="M5.7 15.4 14.1 7a2.2 2.2 0 0 1 3.1 0l2.8 2.8a2.2 2.2 0 0 1 0 3.1L12.5 20H8.3l-2.6-2.6a1.4 1.4 0 0 1 0-2Z"/>'),
  draw: P('<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/><path d="M14.5 6.5l3 3"/>'),
  trash: P('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>'),
  archive: P('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>'),
  edit: P('<path d="M4 20h4L18 10l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>'),
  copy: P('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  menu: P('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  undo: P('<path d="M4 9h10a5 5 0 0 1 0 10H9"/><path d="M8 5 4 9l4 4"/>'),
  redo: P('<path d="M20 9H10a5 5 0 0 0 0 10h5"/><path d="M16 5l4 4-4 4"/>'),
  help: P('<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17.2h.01"/>'),
  search: P('<circle cx="11" cy="11" r="6.5"/><path d="m16.2 16.2 4 4"/>'),
  settings: P('<circle cx="12" cy="12" r="3"/><path d="M19.1 13.5a7.6 7.6 0 0 0 0-3l1.9-1.3-1.9-3.3-2.2.9a7.4 7.4 0 0 0-2.6-1.5L14 2.9h-4l-.3 2.4a7.4 7.4 0 0 0-2.6 1.5l-2.2-.9L3 9.2l1.9 1.3a7.6 7.6 0 0 0 0 3L3 14.8l1.9 3.3 2.2-.9a7.4 7.4 0 0 0 2.6 1.5l.3 2.4h4l.3-2.4a7.4 7.4 0 0 0 2.6-1.5l2.2.9 1.9-3.3-1.9-1.3Z"/>'),
  grid: P('<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9h17M9 3.5v17"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  minus: P('<path d="M5 12h14"/>'),
  expand: P('<path d="M8.5 9 12 5.5 15.5 9"/><path d="M8.5 15 12 18.5 15.5 15"/>'),
  close: P('<path d="M6 6l12 12M18 6 6 18"/>'),
  dot: P('<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'),
  sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>'),
  moon: P('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>'),
  arrow: P('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  check: P('<path d="M5 12.5 10 17.5 19 7"/>'),
  more: P('<circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none"/>'),
  boardSmall: P('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17"/>'),
  kanban: P('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/><path d="M4.8 8h2M10.8 8h2M16.8 8h2"/>'),
  grip: P('<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>'),
  alignLeft: P('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
  alignCenter: P('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
  alignRight: P('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
  indent: P('<path d="M10 6h10M10 10h10M10 14h10M10 18h10"/><path d="M4 8l3 4-3 4"/>'),
  outdent: P('<path d="M10 6h10M10 10h10M10 14h10M10 18h10"/><path d="M7 8l-3 4 3 4"/>'),
  listBullet: P('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  listOrdered: P('<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 5h1v5M4 10h2M4 16h2v3H4"/>'),
  code: P('<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/>'),
  share: P('<circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.2 10.9 15.8 7.1M8.2 13.1l7.6 3.8"/>'),
  clip: P('<path d="M20 11.5 12.3 19.2a4.6 4.6 0 0 1-6.5-6.5l8.2-8.2a3 3 0 0 1 4.2 4.2l-8.1 8.1a1.5 1.5 0 0 1-2.1-2.1l7.4-7.4"/>'),
  lock: P('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5"/>'),
};

export function icon(name, size = 20) {
  const svg = ICONS[name] || ICONS.note;
  return svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
}
