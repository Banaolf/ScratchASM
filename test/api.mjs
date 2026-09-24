// Starts the real server on a temp data dir and exercises accounts, saved projects and the run/assemble rules.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLES } from '../public/samples.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'sa-data-'));
const PORT = 3400 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${PORT}`;
const child = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: 'pipe' });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

let failed = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ${extra}`}`); if (!ok) failed++; };

// tiny cookie-aware client
function client() {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  };
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/status`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`server did not start:\n${log}`);
}

try {
  await waitUp();
  const a = client();
  const hello = SAMPLES[0].build();

  // --- run rules
  let r = await a('POST', '/api/run', { project: hello });
  check(r.status === 200 && r.data.ok && r.data.stdout === 'Hello Assembly!\n', 'blocks project runs', JSON.stringify(r.data));
  r = await a('POST', '/api/run', { asm: 'global _start\n_start: mov eax,60\n xor edi,edi\n syscall' });
  check(r.status === 400 && !r.data.ok, 'raw assembly (code mode) is refused by /api/run', JSON.stringify(r.data));
  r = await a('POST', '/api/check', { asm: 'global _start\n_start: mov eax,60\n xor edi,edi\n syscall\nsection .note.GNU-stack noalloc noexec nowrite progbits' });
  check(r.data.ok === true, 'code-mode text can be assembled + linked (not run)', JSON.stringify(r.data));
  r = await a('POST', '/api/check', { asm: 'bits 64\nbogus rax\n' });
  check(r.data.ok === false && /program\.asm:2: error/.test(r.data.log), 'assembler errors carry line numbers', JSON.stringify(r.data));
  for (const evil of ['%include "/etc/passwd"', 'db 1\nincbin "/etc/passwd"', '%define x inc\n%define y bin\n%define z x%+y', '%! HOME']) {
    r = await a('POST', '/api/check', { asm: evil });
    check(r.data.ok === false && /not allowed/.test(r.data.log), `file-reading directive refused: ${evil.split('\n').pop()}`, JSON.stringify(r.data));
  }

  // --- accounts
  r = await a('GET', '/api/projects');
  check(r.status === 401, 'projects need a login');
  r = await a('POST', '/api/auth/register', { username: 'ab', password: 'longenough' });
  check(r.status === 400, 'short username rejected');
  r = await a('POST', '/api/auth/register', { username: 'alice', password: 'short' });
  check(r.status === 400, 'short password rejected');
  r = await a('POST', '/api/auth/register', { username: 'Alice', password: 'correct horse' });
  check(r.status === 200 && r.data.user.username === 'Alice', 'register');
  check(/HttpOnly/.test(r.headers.get('set-cookie')) && /SameSite=Strict/.test(r.headers.get('set-cookie')), 'session cookie is HttpOnly + SameSite=Strict');
  r = await client()('POST', '/api/auth/register', { username: 'ALICE', password: 'another one' });
  check(r.status === 409, 'usernames are unique case-insensitively');
  r = await a('GET', '/api/auth/me');
  check(r.data.user?.username === 'Alice', 'me returns the user');

  // --- projects
  r = await a('POST', '/api/projects', { name: 'Hello blocks', mode: 'blocks', data: { ...hello, stdin: 'x' } });
  check(r.status === 200 && /^[a-f0-9]{12}$/.test(r.data.project.id), 'save a blocks project', JSON.stringify(r.data));
  const blocksId = r.data.project.id;
  r = await a('POST', '/api/projects', { name: 'Raw', mode: 'code', data: { code: '; hi\n' } });
  check(r.status === 200, 'save a code project');
  const codeId = r.data.project.id;
  r = await a('POST', '/api/projects', { name: 'Bad', mode: 'code', data: { code: 5 } });
  check(r.status === 400, 'bad payload rejected');
  r = await a('POST', '/api/projects', { name: '', mode: 'code', data: { code: '' } });
  check(r.status === 400, 'empty name rejected');
  r = await a('GET', '/api/projects');
  check(r.data.projects.length === 2 && r.data.projects.every((p) => !('data' in p)), 'list has metadata only', JSON.stringify(r.data));
  r = await a('PUT', `/api/projects/${codeId}`, { mode: 'code', data: { code: '; changed\n' }, name: 'Raw v2' });
  check(r.status === 200 && r.data.project.name === 'Raw v2', 'update a project');
  r = await a('GET', `/api/projects/${codeId}`);
  check(r.data.project.data.code === '; changed\n' && r.data.project.mode === 'code', 'read a project back');
  r = await a('GET', `/api/projects/${blocksId}`);
  check(r.data.project.data.scripts.length === hello.scripts.length && r.data.project.data.stdin === 'x', 'blocks project round-trips');

  // --- isolation between users
  const b = client();
  await b('POST', '/api/auth/register', { username: 'bob', password: 'bobs password' });
  r = await b('GET', `/api/projects/${codeId}`);
  check(r.status === 404, "another user can't read your project");
  r = await b('DELETE', `/api/projects/${codeId}`);
  check(r.status === 404, "another user can't delete your project");
  r = await b('GET', '/api/projects');
  check(r.data.projects.length === 0, 'other users see an empty list');

  // --- login / logout
  r = await client()('POST', '/api/auth/login', { username: 'alice', password: 'wrong password' });
  check(r.status === 401 && r.data.error === 'Wrong username or password.', 'wrong password rejected');
  r = await client()('POST', '/api/auth/login', { username: 'nobody', password: 'wrong password' });
  check(r.status === 401 && r.data.error === 'Wrong username or password.', 'unknown user gives the same message');
  const c = client();
  r = await c('POST', '/api/auth/login', { username: 'alice', password: 'correct horse' });
  check(r.status === 200, 'log in (case-insensitive username)');
  r = await c('GET', '/api/projects');
  check(r.data.projects.length === 2, 'projects persist across sessions');
  await c('POST', '/api/auth/logout');
  r = await c('GET', '/api/projects');
  check(r.status === 401, 'logout ends the session');

  // --- brute force throttle
  const t = client();
  let last;
  for (let i = 0; i < 10; i++) last = await t('POST', '/api/auth/login', { username: 'alice', password: `nope${i}` });
  check(last.status === 429, 'repeated bad logins are throttled');

  // --- cross-origin / host protection
  r = await a('POST', '/api/check', { asm: 'nop' }, { Origin: 'https://evil.example' });
  check(r.status === 403, 'cross-origin POST is refused');
  r = await a('POST', '/api/check', { asm: 'nop' }, { Origin: base });
  check(r.status === 200, 'same-origin POST is allowed');
  const rebind = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  check(rebind === 403, 'DNS-rebinding style Host header is refused', String(rebind));

} catch (e) {
  console.log('FAIL  test crashed:', e.message);
  failed++;
} finally {
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
