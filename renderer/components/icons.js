/**
 * icons.js — SVG Icon Library
 * 
 * All icons are inline SVGs with consistent sizing and stroke.
 * Uses currentColor so they inherit text color from CSS.
 * No emojis anywhere — professional SVG icons only.
 */

const Icons = {
  // ─── Status ──────────────────────────────────────────────────────
  check: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 10 8 14 16 6"/></svg>`,

  checkCircle: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><polyline points="6.5 10 9 12.5 13.5 7.5"/></svg>`,

  xCircle: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><line x1="7" y1="7" x2="13" y2="13"/><line x1="13" y1="7" x2="7" y2="13"/></svg>`,

  warning: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2L1.5 17h17L10 2z"/><line x1="10" y1="7" x2="10" y2="11"/><circle cx="10" cy="14" r="0.5" fill="currentColor"/></svg>`,

  info: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.5" r="0.5" fill="currentColor"/></svg>`,

  spinner: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10 1.5a8.5 8.5 0 0 1 8.5 8.5" class="spin-path"/></svg>`,

  // ─── VM Controls ─────────────────────────────────────────────────
  play: `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" stroke="none"><polygon points="5,3 17,10 5,17"/></svg>`,

  stop: `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" stroke="none"><rect x="4" y="4" width="12" height="12" rx="1"/></svg>`,

  pause: `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" stroke="none"><rect x="4" y="3" width="4" height="14" rx="1"/><rect x="12" y="3" width="4" height="14" rx="1"/></svg>`,

  restart: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10a7 7 0 0 1 13.6-2.3"/><path d="M17 10a7 7 0 0 1-13.6 2.3"/><polyline points="17 3 17 8 12 8"/><polyline points="3 17 3 12 8 12"/></svg>`,

  power: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="10" y1="2" x2="10" y2="10"/><path d="M5.5 4.5a7.5 7.5 0 1 0 9 0"/></svg>`,

  // ─── Navigation / Actions ────────────────────────────────────────
  plus: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>`,

  trash: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 5 5 17 15 17 16 5"/><line x1="2" y1="5" x2="18" y2="5"/><path d="M7 5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><line x1="8" y1="8" x2="8" y2="14"/><line x1="12" y1="8" x2="12" y2="14"/></svg>`,

  edit: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 2.5l4 4L6 18H2v-4L13.5 2.5z"/></svg>`,

  settings: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3"/><path d="M10 1v2M10 17v2M18.3 5.5L16.6 6.5M3.4 13.5L1.7 14.5M18.3 14.5L16.6 13.5M3.4 6.5L1.7 5.5M1 10h2M17 10h2"/></svg>`,

  folder: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z"/></svg>`,

  download: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v12"/><polyline points="6 10 10 14 14 10"/><path d="M2 17h16"/></svg>`,

  arrowLeft: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><polyline points="8 5 3 10 8 15"/></svg>`,

  arrowRight: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="10" x2="17" y2="10"/><polyline points="12 5 17 10 12 15"/></svg>`,

  externalLink: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 11v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/><polyline points="12 3 17 3 17 8"/><line x1="8" y1="12" x2="17" y2="3"/></svg>`,

  // ─── System ──────────────────────────────────────────────────────
  shield: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 1.5L2 5v5c0 4.5 3.5 8 8 9.5 4.5-1.5 8-5 8-9.5V5L10 1.5z"/></svg>`,

  shieldCheck: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 1.5L2 5v5c0 4.5 3.5 8 8 9.5 4.5-1.5 8-5 8-9.5V5L10 1.5z"/><polyline points="6.5 10 9 12.5 13.5 7.5"/></svg>`,

  cpu: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="10" height="10" rx="1"/><rect x="7" y="7" width="6" height="6" rx="0.5"/><line x1="10" y1="1" x2="10" y2="5"/><line x1="10" y1="15" x2="10" y2="19"/><line x1="1" y1="10" x2="5" y2="10"/><line x1="15" y1="10" x2="19" y2="10"/></svg>`,

  memory: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="16" height="9" rx="1"/><line x1="5" y1="6" x2="5" y2="3"/><line x1="9" y1="6" x2="9" y2="3"/><line x1="13" y1="6" x2="13" y2="3"/><line x1="6" y1="9" x2="6" y2="12"/><line x1="10" y1="9" x2="10" y2="12"/><line x1="14" y1="9" x2="14" y2="12"/></svg>`,

  hardDrive: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><circle cx="10" cy="10" r="2"/><line x1="12" y1="10" x2="18" y2="10"/></svg>`,

  monitor: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="16" height="12" rx="1"/><line x1="7" y1="18" x2="13" y2="18"/><line x1="10" y1="14" x2="10" y2="18"/></svg>`,

  network: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="4" r="2.5"/><circle cx="4" cy="16" r="2.5"/><circle cx="16" cy="16" r="2.5"/><line x1="10" y1="6.5" x2="4" y2="13.5"/><line x1="10" y1="6.5" x2="16" y2="13.5"/></svg>`,

  globe: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="8.5"/><ellipse cx="10" cy="10" rx="4" ry="8.5"/><line x1="1.5" y1="10" x2="18.5" y2="10"/></svg>`,

  server: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="16" height="5" rx="1"/><rect x="2" y="9" width="16" height="5" rx="1"/><circle cx="5" cy="4.5" r="0.5" fill="currentColor"/><circle cx="5" cy="11.5" r="0.5" fill="currentColor"/><line x1="10" y1="17" x2="10" y2="14"/><line x1="6" y1="17" x2="14" y2="17"/></svg>`,

  terminal: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="16" height="14" rx="2"/><polyline points="6 8 9 11 6 14"/><line x1="11" y1="14" x2="14" y2="14"/></svg>`,

  clipboard: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="12" height="15" rx="1"/><path d="M7 3V2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/></svg>`,

  // ─── Special ─────────────────────────────────────────────────────
  vm: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="17" height="12" rx="1.5"/><polyline points="6 18 14 18"/><line x1="10" y1="14" x2="10" y2="18"/><rect x="4" y="4.5" width="12" height="7" rx="0.5" opacity="0.3"/></svg>`,

  ubuntu: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="8.5"/><circle cx="10" cy="4" r="1.5"/><circle cx="4.8" cy="13" r="1.5"/><circle cx="15.2" cy="13" r="1.5"/><path d="M10 5.5v3M5.8 12l2.5-1.5M13.7 12l-2.5-1.5" stroke-width="1"/></svg>`,

  refresh: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2v5h5"/><path d="M3.5 7A7.5 7.5 0 0 1 17.5 10"/><path d="M16.5 18v-5h-5"/><path d="M16.5 13A7.5 7.5 0 0 1 2.5 10"/></svg>`,

  wrench: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 6a4 4 0 0 1-5.4 3.7L6.5 14.8a1.5 1.5 0 1 1-2.1-2.1l5.1-5.1A4 4 0 1 1 17 6z"/></svg>`,

  user: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="6" r="3.5"/><path d="M3 17c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5"/></svg>`,

  chevronDown: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 7 10 13 15 7"/></svg>`,

  moreVertical: `<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" stroke="none"><circle cx="10" cy="4" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="16" r="1.5"/></svg>`,

  copy: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>`,

  search: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><line x1="13" y1="13" x2="18" y2="18"/></svg>`,

  lock: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="9" rx="1"/><path d="M6 9V6a4 4 0 0 1 8 0v3"/></svg>`,

  unlock: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="9" rx="1"/><path d="M6 9V6a4 4 0 0 1 8 0"/></svg>`,

  // Helper to wrap icon with custom size
  sized(icon, size = 20) {
    return icon.replace(/width="\d+"/, `width="${size}"`).replace(/height="\d+"/, `height="${size}"`);
  },

  // Helper to wrap icon in a span with class
  wrap(icon, className = '') {
    return `<span class="icon ${className}">${icon}</span>`;
  }
};
