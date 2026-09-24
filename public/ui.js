// Shared UI pieces: dialogs, menus, toasts and the theme switch.
// Everything in the app uses these instead of alert/confirm/prompt, so it all looks and behaves alike.

export const $ = (selector, root = document) => root.querySelector(selector);

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ------------------------------------------------------------------ toasts
let toastHost = null;
export function toast(message, kind = 'info') {
  if (!toastHost) {
    toastHost = el('div');
    toastHost.id = 'toasts';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.append(toastHost);
  }
  const t = el('div', `toast ${kind}`, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3200);
}

// ------------------------------------------------------------------ dialogs
/**
 * Generic modal. `build(body, api)` fills the body; each button is
 * { label, value, kind, onClick(api) }. onClick may return false to keep the dialog open.
 * Resolves with the value of the button that closed it (null when dismissed).
 */
export function modal({ title, build, buttons = [], wide = false }) {
  return new Promise((resolve) => {
    const d = el('dialog', `modal${wide ? ' wide' : ''}`);
    const body = el('div', 'modal-body');
    const foot = el('div', 'modal-actions');
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const h = el('h2', 'modal-title', title);
    h.id = titleId;
    d.setAttribute('aria-labelledby', titleId);
    d.append(h, body, foot);

    let result = null;
    const btns = [];
    const api = { body, dialog: d, buttons: btns, close(v) { result = v ?? null; d.close(); } };
    for (const b of buttons) {
      const btn = el('button', `btn ${b.kind || ''}`.trim(), b.label);
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          const r = await b.onClick(api);
          if (r === false) return;
          api.close(r ?? b.value);
        } else api.close(b.value);
      });
      btns.push(btn);
      foot.append(btn);
    }
    build?.(body, api);
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        foot.querySelector('.btn.primary, .btn.danger')?.click();
      }
    });
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    document.body.append(d);
    d.showModal();
    body.querySelector('input, select, textarea')?.focus();
  });
}

export async function confirmDialog(message, { title = 'Are you sure?', confirmText = 'Continue', danger = false } = {}) {
  const r = await modal({
    title,
    build: (body) => body.append(el('p', '', message)),
    buttons: [
      { label: 'Cancel', value: false },
      { label: confirmText, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return r === true;
}

export function promptDialog(message, { title = 'Name it', value = '', placeholder = '', confirmText = 'OK', maxLength = 60 } = {}) {
  let input;
  return modal({
    title,
    build: (body) => {
      const label = el('label', 'field-label', message);
      input = el('input', 'input');
      input.type = 'text';
      input.value = value;
      input.placeholder = placeholder;
      input.maxLength = maxLength;
      input.spellcheck = false;
      label.append(input);
      body.append(label);
    },
    buttons: [
      { label: 'Cancel', value: null },
      { label: confirmText, kind: 'primary', onClick: () => { const v = input.value.trim(); if (!v) { input.focus(); return false; } return v; } },
    ],
  });
}

// ------------------------------------------------------------------ menus
let openMenuState = null;

export function closeMenu(refocus = false) {
  if (!openMenuState) return;
  const { menu, anchor, off } = openMenuState;
  openMenuState = null;
  off();
  menu.remove();
  if (refocus) anchor.focus();
}

/** items: '-' for a divider, or { label, hint, disabled, onClick }. */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { menu.append(el('hr')); continue; }
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.disabled = !!it.disabled;
    b.append(el('span', '', it.label));
    if (it.hint) b.append(el('kbd', '', it.hint));
    b.addEventListener('click', () => { closeMenu(); it.onClick?.(); });
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;

  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeMenu(); };
  const onKey = (e) => {
    const items = [...menu.querySelectorAll('.menu-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') closeMenu();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  openMenuState = { menu, anchor, off: () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); } };
  menu.querySelector('.menu-item:not(:disabled)')?.focus();
}

// ------------------------------------------------------------------ theme
const THEME_KEY = 'scratchasm.theme';
const SVG = (inner, fill = 'none') => `<svg viewBox="0 0 24 24" width="16" height="16" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const THEMES = {
  auto:  { label: 'Auto',  icon: SVG('<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor"/>') },
  light: { label: 'Light', icon: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>') },
  dark:  { label: 'Dark',  icon: SVG('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>') },
};
const ORDER = ['auto', 'light', 'dark'];

export function initTheme(button) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let pref = 'auto';
  try { pref = localStorage.getItem(THEME_KEY) || 'auto'; } catch { /* ignore */ }
  if (!THEMES[pref]) pref = 'auto';

  const apply = () => {
    const dark = pref === 'dark' || (pref === 'auto' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const next = THEMES[ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]].label;
    button.innerHTML = THEMES[pref].icon;
    button.title = `Theme: ${THEMES[pref].label}. Click for ${next}.`;
    button.setAttribute('aria-label', button.title);
  };
  button.addEventListener('click', () => {
    pref = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];
    try { localStorage.setItem(THEME_KEY, pref); } catch { /* ignore */ }
    apply();
  });
  media.addEventListener('change', () => { if (pref === 'auto') apply(); });
  apply();
}
