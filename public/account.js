// Client side of accounts + server-saved projects.
import { el, modal, toast, confirmDialog, promptDialog } from './ui.js';

/** JSON fetch for /api/auth and /api/projects. Throws Error(message) with .status on failure. */
export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || data?.ok === false) {
    throw Object.assign(new Error(data?.error || data?.log || `Request failed (HTTP ${res.status})`), { status: res.status });
  }
  return data;
}

export const account = { user: null, registration: true };
const listeners = new Set();
export const onAccountChange = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn(account.user));

export async function refreshAccount() {
  try {
    const d = await api('GET', '/api/auth/me');
    account.user = d.user;
    account.registration = d.registration;
  } catch {
    account.user = null;
  }
  notify();
}

export async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch { /* cookie is cleared best-effort */ }
  account.user = null;
  notify();
}

/** Resolves true when the person ends up signed in. */
export async function signInDialog(startTab = 'login') {
  let tab = startTab === 'register' && account.registration ? 'register' : 'login';
  let username, password, error, hint, tabButtons;

  const render = (m) => {
    tabButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    m.buttons[1].textContent = tab === 'login' ? 'Sign in' : 'Create account';
    password.autocomplete = tab === 'login' ? 'current-password' : 'new-password';
    hint.hidden = tab === 'login';
    error.hidden = true;
  };

  const r = await modal({
    title: 'Your ScratchASM account',
    build(body, m) {
      const seg = el('div', 'segmented');
      tabButtons = [['login', 'Sign in'], ['register', 'Create account']]
        .filter(([id]) => id === 'login' || account.registration)
        .map(([id, label]) => {
          const b = el('button', '', label);
          b.type = 'button';
          b.dataset.tab = id;
          b.addEventListener('click', () => { tab = id; render(m); });
          seg.append(b);
          return b;
        });
      const uLabel = el('label', 'field-label', 'Username');
      username = el('input', 'input');
      username.autocomplete = 'username';
      username.maxLength = 24;
      username.spellcheck = false;
      uLabel.append(username);
      const pLabel = el('label', 'field-label', 'Password');
      password = el('input', 'input');
      password.type = 'password';
      password.maxLength = 128;
      pLabel.append(password);
      hint = el('p', 'hint', 'Usernames: 3-24 letters, numbers, dot, dash or underscore. Passwords: at least 8 characters. There is no password recovery.');
      error = el('p', 'form-error');
      error.setAttribute('role', 'alert');
      body.append(...(account.registration ? [seg] : []), uLabel, pLabel, hint, error);
      m.submit = async () => {
        error.hidden = true;
        try {
          const d = await api('POST', tab === 'login' ? '/api/auth/login' : '/api/auth/register', { username: username.value, password: password.value });
          account.user = d.user;
          notify();
          toast(tab === 'login' ? `Signed in as ${d.user.username}` : `Welcome, ${d.user.username}`, 'ok');
          return true;
        } catch (e) {
          error.textContent = e.message;
          error.hidden = false;
          return false;
        }
      };
      queueMicrotask(() => render(m));   // buttons exist once modal() has finished building
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Sign in', kind: 'primary', onClick: (m) => m.submit() },
    ],
  });
  return r === true;
}

/** Lists the account's saved projects. onOpen(fullProject) is called when one is chosen. */
export function projectsDialog({ onOpen, currentId }) {
  let listEl;
  const fmt = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  async function load(m) {
    listEl.replaceChildren(el('p', 'hint', 'Loading...'));
    try {
      const { projects } = await api('GET', '/api/projects');
      listEl.replaceChildren();
      if (!projects.length) {
        listEl.append(el('p', 'hint', 'Nothing saved yet. Use File > Save to keep the current project on this server.'));
        return;
      }
      for (const p of projects) {
        const row = el('div', `proj${p.id === currentId ? ' current' : ''}`);
        const info = el('div', 'proj-info');
        info.append(el('span', 'proj-name', p.name), el('span', `badge ${p.mode}`, p.mode === 'code' ? 'Code' : 'Blocks'), el('span', 'dim', fmt(p.updatedAt)));
        const acts = el('div', 'proj-actions');
        const open = el('button', 'btn primary', 'Open');
        open.type = 'button';
        open.addEventListener('click', async () => {
          try { onOpen((await api('GET', `/api/projects/${p.id}`)).project); m.close(true); }
          catch (e) { toast(e.message, 'error'); }
        });
        const rename = el('button', 'btn', 'Rename');
        rename.type = 'button';
        rename.addEventListener('click', async () => {
          const name = await promptDialog('New name', { title: 'Rename project', value: p.name, confirmText: 'Rename' });
          if (!name) return;
          try { await api('PUT', `/api/projects/${p.id}`, { name }); load(m); } catch (e) { toast(e.message, 'error'); }
        });
        const del = el('button', 'btn danger-ghost', 'Delete');
        del.type = 'button';
        del.addEventListener('click', async () => {
          if (!(await confirmDialog(`"${p.name}" will be deleted from the server. This can't be undone.`, { title: 'Delete project?', confirmText: 'Delete', danger: true }))) return;
          try { await api('DELETE', `/api/projects/${p.id}`); load(m); } catch (e) { toast(e.message, 'error'); }
        });
        acts.append(open, rename, del);
        row.append(info, acts);
        listEl.append(row);
      }
    } catch (e) {
      listEl.replaceChildren(el('p', 'form-error', e.message));
    }
  }

  return modal({
    title: 'My projects',
    wide: true,
    build(body, m) { listEl = el('div', 'proj-list'); body.append(listEl); load(m); },
    buttons: [{ label: 'Close', value: false }],
  });
}
