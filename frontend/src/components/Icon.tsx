/** Small stroke icon set (24-unit grid, 1.75 stroke) — inherits currentColor. */
const PATHS: Record<string, string> = {
  first: 'M17 18l-6-6 6-6M7 6v12',
  prev: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  last: 'M7 18l6-6-6-6M17 6v12',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  fit: 'M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  palette:
    'M12 3a9 9 0 100 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 005-5c0-4-4-7.4-9-7.4zM7.5 12.5h.01M9.5 8h.01M14.5 8h.01',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  translate: 'M4 5h8M8 3v2M6 5c0 4 2.5 7 5.5 8.5M10 5c-.5 3.5-2.8 6.6-6 8.5M13 20l4-9 4 9M14.5 17h5',
  chevronDown: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  focus: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  home: 'M4 11l8-7 8 7M6 10v9h4v-5h4v5h4v-9',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16.5 4.5l3.8 1 -3.6 14.5-3.8-1z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  check: 'M5 12.5l4.5 4.5L19 7',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  page: 'M6 3h9l4 4v14H6zM14 3v5h5',
  rows: 'M4 6h16M4 12h16M4 18h10',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  chat: 'M4 5h16v11H9l-5 4V5zM8 9h8M8 12h5',
  note: 'M5 3h10l4 4v14H5zM9 10h6M9 14h6M9 18h3',
  book: 'M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4zM20 4h-6a3 3 0 00-3 3v13a2 2 0 012-2h7z',
  panelOpen: 'M4 4h16v16H4zM14 4v16M10 9l-3 3 3 3',
  panelClose: 'M4 4h16v16H4zM14 4v16M7 9l3 3-3 3',
  send: 'M4 12l16-8-6 16-2-7-8-1z',
  stop: 'M7 7h10v10H7z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  marker: 'M15 4l5 5-9 9H6v-5zM4 21h7',
  lookup: 'M4 5h7a3 3 0 013 3v12a2 2 0 00-2-2H4zM20 5h-4M20 9h-4M20 13h-4',
  help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9.5a2.5 2.5 0 114 2c-.8.6-1.5 1.1-1.5 2.2M12 17h.01',
  sigma: 'M18 5H6l6 7-6 7h12',
  addTerm: 'M4 6h10M4 12h7M4 18h6M17 13v8M13 17h8',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  coin: 'M12 21a9 9 0 100-18 9 9 0 000 18zM14.5 9a2.5 2 0 00-2.5-1.5c-1.4 0-2.5.7-2.5 1.8 0 2.7 5 1.5 5 4.2 0 1.1-1.1 2-2.5 2A2.6 2.6 0 019.5 14M12 6v1.5M12 16.5V18',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName | string; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
