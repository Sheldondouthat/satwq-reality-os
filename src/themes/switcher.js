/**
 * @module switcher
 * @description HUD-mountable theme switcher: a labeled grid of all 14
 * cinematic skins with instant apply. Pure DOM, no dependencies.
 *
 * Usage (see INTEGRATION.md):
 *   import { mountThemeSwitcher } from './themes/switcher.js';
 *   mountThemeSwitcher(document.getElementById('hud-theme-slot'));
 */

import {
  applyTheme,
  getCurrentThemeId,
  getTheme,
  listThemes,
  onThemeChange,
  THEME_CHANGE_EVENT,
} from './engine.js';

const SWITCHER_CLASS = 'satwq-theme-switcher';

/**
 * Build the switcher element. Each tile shows a palette swatch + name;
 * clicking applies the theme instantly.
 */
export function createThemeSwitcher({ label = 'HUD SKIN' } = {}) {
  const root = document.createElement('section');
  root.className = SWITCHER_CLASS;
  root.setAttribute('aria-label', 'Theme switcher');

  const heading = document.createElement('h2');
  heading.className = `${SWITCHER_CLASS}__label`;
  heading.textContent = label;
  root.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = `${SWITCHER_CLASS}__grid`;
  grid.setAttribute('role', 'listbox');
  grid.setAttribute('aria-label', 'Available HUD skins');
  root.appendChild(grid);

  const tiles = new Map();
  for (const { id, name, tagline } of listThemes()) {
    const manifest = getTheme(id);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = `${SWITCHER_CLASS}__tile`;
    tile.setAttribute('role', 'option');
    tile.dataset.themeId = id;
    tile.title = tagline || name;

    const swatch = document.createElement('span');
    swatch.className = `${SWITCHER_CLASS}__swatch`;
    swatch.setAttribute('aria-hidden', 'true');
    const v = manifest?.vars || {};
    swatch.style.background = `linear-gradient(135deg, ${v.bg || '#000'} 0%, ${v.panel || '#111'} 55%, ${v.accent || '#888'} 130%)`;
    swatch.style.borderColor = v.accent || '#888';
    tile.appendChild(swatch);

    const nameEl = document.createElement('span');
    nameEl.className = `${SWITCHER_CLASS}__name`;
    nameEl.textContent = name;
    tile.appendChild(nameEl);

    tile.addEventListener('click', () => applyTheme(id));
    tiles.set(id, tile);
    grid.appendChild(tile);
  }

  const markActive = (id) => {
    for (const [tileId, tile] of tiles) {
      const active = tileId === id;
      tile.classList.toggle('is-active', active);
      tile.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  };

  markActive(getCurrentThemeId());
  const unsubscribe = onThemeChange((id) => markActive(id));
  root.addEventListener('DOMNodeRemoved', unsubscribe, { once: true });

  // Minimal built-in styling so the switcher works unstyled out of the box;
  // the host app may override via .satwq-theme-switcher selectors.
  const style = document.createElement('style');
  style.textContent = `
.${SWITCHER_CLASS}{font-family:var(--theme-font-ui,system-ui,sans-serif);color:var(--theme-text,#fff)}
.${SWITCHER_CLASS}__label{font-size:11px;letter-spacing:.18em;opacity:.75;margin:0 0 8px}
.${SWITCHER_CLASS}__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
.${SWITCHER_CLASS}__tile{display:flex;flex-direction:column;gap:6px;align-items:stretch;background:var(--theme-panel,rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px;cursor:pointer;color:inherit}
.${SWITCHER_CLASS}__tile:hover{border-color:var(--theme-accent,#888)}
.${SWITCHER_CLASS}__tile.is-active{border-color:var(--theme-accent,#888);box-shadow:0 0 0 1px var(--theme-accent,#888)}
.${SWITCHER_CLASS}__swatch{display:block;height:26px;border-radius:5px;border:1px solid}
.${SWITCHER_CLASS}__name{font-size:11px;text-align:left;line-height:1.25}
`;
  root.appendChild(style);

  return root;
}

/**
 * Mount the switcher into a container element (or selector string).
 * Returns the created element, or null if the container is missing.
 */
export function mountThemeSwitcher(container, opts) {
  const host =
    typeof container === 'string'
      ? document.querySelector(container)
      : container;
  if (!host || typeof host.appendChild !== 'function') return null;
  const el = createThemeSwitcher(opts);
  host.appendChild(el);
  return el;
}

export { THEME_CHANGE_EVENT };
