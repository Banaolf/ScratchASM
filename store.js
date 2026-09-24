// Tiny JSON-file store for accounts, sessions and saved projects.
// Everything lives in memory and is written atomically to <dataDir>/db.json.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.users = new Map();      // lowercase username -> user
    this.userById = new Map();   // id -> user
    this.projects = new Map();   // user id -> project[]
    this.sessions = new Map();   // sha256(token) -> { h, userId, exp }
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    let raw = {};
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      // A corrupt file must stop the server rather than be silently overwritten.
      if (e.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${e.message}`);
    }
    for (const u of raw.users ?? []) this.addUser(u);
    for (const [uid, list] of Object.entries(raw.projects ?? {})) this.projects.set(uid, list);
    for (const s of raw.sessions ?? []) if (s.exp > Date.now()) this.sessions.set(s.h, s);
  }

  addUser(u) {
    this.users.set(u.username.toLowerCase(), u);
    this.userById.set(u.id, u);
  }

  projectsOf(userId) {
    if (!this.projects.has(userId)) this.projects.set(userId, []);
    return this.projects.get(userId);
  }

  purgeSessions() {
    const now = Date.now();
    for (const [h, s] of this.sessions) if (s.exp < now) this.sessions.delete(h);
  }

  /** Serialised, atomic write. Resolves when the data is on disk. */
  save() {
    const snapshot = JSON.stringify({
      users: [...this.users.values()],
      projects: Object.fromEntries(this.projects),
      sessions: [...this.sessions.values()],
    });
    this.queue = this.queue
      .then(async () => {
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot, { mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((e) => console.error('Could not save the database:', e.message));
    return this.queue;
  }
}
