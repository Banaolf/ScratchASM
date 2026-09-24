// Accounts (username + password), cookie sessions and per-user saved projects.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { sanitizeProject, MAX_CODE_CHARS } from './public/project.js';

const scrypt = promisify(crypto.scrypt);
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const PROJECT_ID_RE = /^[a-f0-9]{12}$/;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MAX_PROJECTS = 200;
const MAX_PROJECT_BYTES = 1024 * 1024;
const DUMMY_SALT = crypto.randomBytes(16);   // makes unknown-user logins take as long as real ones

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fail = (res, status, error) => res.status(status).json({ ok: false, error });

function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function createLimiter() {
  const hits = new Map();
  return {
    tooMany(key, max, windowMs) {
      const e = hits.get(key);
      if (!e) return false;
      if (Date.now() - e.first > windowMs) { hits.delete(key); return false; }
      return e.count >= max;
    },
    hit(key) {
      const e = hits.get(key);
      if (e) e.count++;
      else {
        if (hits.size > 5000) hits.delete(hits.keys().next().value);
        hits.set(key, { count: 1, first: Date.now() });
      }
    },
    clear(key) { hits.delete(key); },
  };
}

function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
}

/** Validates + normalises the payload of a saved project. */
function cleanData(mode, data) {
  let out;
  if (mode === 'blocks') {
    if (!data || typeof data !== 'object') return { error: 'Project data is missing.' };
    try { out = { ...sanitizeProject(data), stdin: typeof data.stdin === 'string' ? data.stdin.slice(0, 20000) : '' }; }
    catch { return { error: 'Project data is malformed.' }; }
  } else if (mode === 'code') {
    if (typeof data?.code !== 'string') return { error: 'Code is missing.' };
    if (data.code.length > MAX_CODE_CHARS) return { error: 'That file is too large to save (256 KiB max).' };
    out = { code: data.code };
  } else {
    return { error: 'Unknown mode.' };
  }
  if (JSON.stringify(out).length > MAX_PROJECT_BYTES) return { error: 'That project is too large to save.' };
  return { data: out };
}

const meta = (p) => ({ id: p.id, name: p.name, mode: p.mode, createdAt: p.createdAt, updatedAt: p.updatedAt });

export function createAccounts(store, { allowRegistration = true } = {}) {
  const router = Router();
  const limiter = createLimiter();
  const MIN = 60 * 1000;

  function userFromReq(req) {
    const token = parseCookies(req.headers.cookie).sid;
    if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
    const s = store.sessions.get(sha256(token));
    if (!s || s.exp < Date.now()) return null;
    return store.userById.get(s.userId) ?? null;
  }

  const cookie = (req, value, maxAge) =>
    `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;

  async function startSession(req, res, user) {
    const token = crypto.randomBytes(32).toString('hex');
    const h = sha256(token);
    store.sessions.set(h, { h, userId: user.id, exp: Date.now() + SESSION_MS });
    await store.save();
    res.setHeader('Set-Cookie', cookie(req, token, SESSION_MS / 1000));
  }

  function readCredentials(body) {
    const { username, password } = body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') return null;
    return { username: username.trim(), password };
  }

  router.get('/auth/me', (req, res) => {
    const u = userFromReq(req);
    res.json({ ok: true, user: u ? { username: u.username } : null, registration: allowRegistration });
  });

  router.post('/auth/register', async (req, res) => {
    if (!allowRegistration) return fail(res, 403, 'Creating accounts is turned off on this server.');
    const ip = req.socket.remoteAddress ?? '?';
    if (limiter.tooMany(`reg|${ip}`, 10, 60 * MIN)) return fail(res, 429, 'Too many new accounts from this address. Try again later.');
    const c = readCredentials(req.body);
    if (!c) return fail(res, 400, 'Enter a username and a password.');
    if (!USERNAME_RE.test(c.username)) return fail(res, 400, 'Usernames are 3-24 characters: letters, numbers, dot, dash or underscore.');
    if (c.password.length < 8 || c.password.length > 128) return fail(res, 400, 'Passwords must be 8-128 characters.');
    if (store.users.has(c.username.toLowerCase())) return fail(res, 409, 'That username is taken.');
    limiter.hit(`reg|${ip}`);
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(c.password, salt, 64);
    if (store.users.has(c.username.toLowerCase())) return fail(res, 409, 'That username is taken.');   // lost a race
    const user = { id: crypto.randomBytes(8).toString('hex'), username: c.username, salt: salt.toString('hex'), hash: hash.toString('hex'), createdAt: Date.now() };
    store.addUser(user);
    await startSession(req, res, user);
    res.json({ ok: true, user: { username: user.username } });
  });

  router.post('/auth/login', async (req, res) => {
    const ip = req.socket.remoteAddress ?? '?';
    const c = readCredentials(req.body);
    if (!c) return fail(res, 400, 'Enter a username and a password.');
    const perUser = `login|${ip}|${c.username.toLowerCase()}`;
    const perIp = `login|${ip}`;
    if (limiter.tooMany(perUser, 8, 15 * MIN) || limiter.tooMany(perIp, 40, 15 * MIN)) {
      return fail(res, 429, 'Too many attempts. Wait a few minutes and try again.');
    }
    const user = store.users.get(c.username.toLowerCase());
    const derived = await scrypt(c.password, user ? Buffer.from(user.salt, 'hex') : DUMMY_SALT, 64);
    const ok = user && crypto.timingSafeEqual(derived, Buffer.from(user.hash, 'hex'));
    if (!ok) {
      limiter.hit(perUser); limiter.hit(perIp);
      return fail(res, 401, 'Wrong username or password.');
    }
    limiter.clear(perUser);
    await startSession(req, res, user);
    res.json({ ok: true, user: { username: user.username } });
  });

  router.post('/auth/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie).sid;
    if (token) { store.sessions.delete(sha256(token)); await store.save(); }
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true });
  });

  // ---- saved projects (everything below needs a signed-in user) ----------
  const requireUser = (req, res, next) => {
    const user = userFromReq(req);
    if (!user) return fail(res, 401, 'Sign in to use saved projects.');
    req.user = user;
    next();
  };

  function findProject(req, res) {
    if (!PROJECT_ID_RE.test(req.params.id)) { fail(res, 404, 'Project not found.'); return null; }
    const p = store.projectsOf(req.user.id).find((x) => x.id === req.params.id);
    if (!p) fail(res, 404, 'Project not found.');
    return p ?? null;
  }

  router.get('/projects', requireUser, (req, res) => {
    const list = store.projectsOf(req.user.id).map(meta).sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ ok: true, projects: list });
  });

  router.get('/projects/:id', requireUser, (req, res) => {
    const p = findProject(req, res);
    if (p) res.json({ ok: true, project: { ...meta(p), data: p.data } });
  });

  router.post('/projects', requireUser, async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return fail(res, 400, 'Give the project a name (1-60 characters).');
    const parsed = cleanData(req.body?.mode, req.body?.data);
    if (parsed.error) return fail(res, 400, parsed.error);
    const list = store.projectsOf(req.user.id);
    if (list.length >= MAX_PROJECTS) return fail(res, 400, `You can keep up to ${MAX_PROJECTS} projects. Delete some first.`);
    const now = Date.now();
    const p = { id: crypto.randomBytes(6).toString('hex'), name, mode: req.body.mode, data: parsed.data, createdAt: now, updatedAt: now };
    list.push(p);
    await store.save();
    res.json({ ok: true, project: meta(p) });
  });

  router.put('/projects/:id', requireUser, async (req, res) => {
    const p = findProject(req, res);
    if (!p) return;
    if (req.body?.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) return fail(res, 400, 'Give the project a name (1-60 characters).');
      p.name = name;
    }
    if (req.body?.data !== undefined) {
      const mode = req.body.mode ?? p.mode;
      const parsed = cleanData(mode, req.body.data);
      if (parsed.error) return fail(res, 400, parsed.error);
      p.mode = mode;
      p.data = parsed.data;
    }
    p.updatedAt = Date.now();
    await store.save();
    res.json({ ok: true, project: meta(p) });
  });

  router.delete('/projects/:id', requireUser, async (req, res) => {
    const p = findProject(req, res);
    if (!p) return;
    const list = store.projectsOf(req.user.id);
    list.splice(list.indexOf(p), 1);
    await store.save();
    res.json({ ok: true });
  });

  return { router, userFromReq };
}
