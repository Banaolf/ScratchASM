// ScratchASM backend: assembles NASM source with `nasm`, links with `ld`,
// then (optionally) runs the resulting x86-64 ELF with a timeout.
import express from 'express';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile } from './public/compiler.js';
import { sanitizeProject } from './public/project.js';
import { Store } from './store.js';
import { createAccounts } from './accounts.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';            // localhost only, on purpose
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 5000;
const MAX_OUTPUT_BYTES = 1024 * 1024;                     // 1 MiB of stdout+stderr
const MAX_ASM_BYTES = 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== '0';
const DISABLE_RUN = process.env.DISABLE_RUN === '1';                 // assemble/download only
const RUN_REQUIRES_LOGIN = process.env.RUN_REQUIRES_LOGIN === '1';

const app = express();
app.disable('x-powered-by');

// --- Safety: this server can run machine code you send it. -----------------
// Only accept requests addressed to localhost, and refuse cross-site Origins,
// so a random web page in your browser can't drive it (CSRF / DNS rebinding).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const forbid = (res, why) => res.status(403).send(`Forbidden: ${why}`);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  const host = String(req.headers.host || '').toLowerCase();
  if (process.env.ALLOW_ANY_HOST !== '1' && !LOCAL_HOSTS.has(host.replace(/:\d+$/, ''))) return forbid(res, 'unexpected Host header');
  const origin = req.headers.origin;
  if (origin) {
    let same = false;
    try { same = new URL(origin).host.toLowerCase() === host; } catch { /* bad origin */ }
    if (!same) return forbid(res, 'cross-origin request');
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const store = new Store(DATA_DIR);
await store.load();
setInterval(() => { store.purgeSessions(); store.save(); }, 3600 * 1000).unref();
const accounts = createAccounts(store, { allowRegistration: ALLOW_REGISTRATION });
app.use('/api', accounts.router);

// --- Helpers ---------------------------------------------------------------
async function toolVersion(cmd, args) {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 4000 });
    return stdout.split('\n')[0].trim() || 'unknown';
  } catch {
    return null;
  }
}

const tidy = (text, dir) => String(text || '').split(dir + path.sep).join('').replaceAll('prog.asm', 'program.asm').trim();

/** Assemble + link. Returns { ok, dir, exe, log } or { ok:false, phase, log }. */
async function build(asm) {
  const dir = await mkdtemp(path.join(tmpdir(), 'scratchasm-'));
  const src = path.join(dir, 'prog.asm');
  const obj = path.join(dir, 'prog.o');
  const exe = path.join(dir, 'prog');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  let log = '';
  try {
    await writeFile(src, asm);
    try {
      const r = await execFileP('nasm', ['-f', 'elf64', '-g', '-F', 'dwarf', src, '-o', obj],
        { timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES, cwd: dir });
      log += tidy(r.stderr, dir);
    } catch (e) {
      await cleanup();
      return { ok: false, phase: e.code === 'ENOENT' ? 'tool' : 'assemble',
               log: e.code === 'ENOENT' ? 'nasm was not found on this machine. Install it (e.g. sudo apt install nasm).'
                                        : tidy(e.stderr || e.message, dir) };
    }
    try {
      const r = await execFileP('ld', ['-o', exe, obj], { timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES, cwd: dir });
      log += (log ? '\n' : '') + tidy(r.stderr, dir);
    } catch (e) {
      await cleanup();
      return { ok: false, phase: e.code === 'ENOENT' ? 'tool' : 'link',
               log: e.code === 'ENOENT' ? 'ld was not found on this machine. Install binutils (e.g. sudo apt install binutils).'
                                        : tidy(e.stderr || e.message, dir) };
    }
    const { size } = await stat(exe);
    return { ok: true, dir, exe, size, log: log.trim(), cleanup };
  } catch (e) {
    await cleanup();
    return { ok: false, phase: 'internal', log: String(e.message || e) };
  }
}

/** Run an ELF with stdin, a timeout and an output cap. */
function execute(exe, cwd, stdin, hooks) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(exe, [], { cwd, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    hooks.child = child;
    const out = [];
    const err = [];
    let bytes = 0, truncated = false, timedOut = false, spawnError = null;

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
    const collect = (bucket) => (chunk) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const room = MAX_OUTPUT_BYTES - bytes;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      bytes += piece.length;
      bucket.push(piece);
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.stdin.on('error', () => {});           // program may exit without reading stdin
    child.stdin.end(typeof stdin === 'string' ? stdin : '');
    child.on('error', (e) => { spawnError = e.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode, signal, timedOut, truncated, spawnError,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Number((process.hrtime.bigint() - started) / 1000000n),
      });
    });
  });
}

function validAsm(body) {
  return body && typeof body.asm === 'string' && body.asm.length > 0 && Buffer.byteLength(body.asm) <= MAX_ASM_BYTES;
}

// NASM can read arbitrary files from the machine it runs on (%include, incbin, %!) and
// can be talked into building those directives out of pieces (%+, %deftok, ...). Refuse
// them, so error messages and output can't be used to read the server's files.
const FORBIDDEN_SOURCE = /incbin|%\s*(?:include|pathsearch|depend)\b|%\s*[!+\[]|%\s*(?:deftok|defstr|strcat|substr)\b/i;
function forbiddenDirective(asm) {
  const m = FORBIDDEN_SOURCE.exec(asm.replace(/\\\r?\n/g, ''));
  return m ? `"${m[0].trim()}" is not allowed here because it can read files from the server.` : null;
}

// --- API -------------------------------------------------------------------
app.get('/api/status', async (_req, res) => {
  const [nasm, ld] = await Promise.all([toolVersion('nasm', ['-v']), toolVersion('ld', ['-v'])]);
  res.json({
    nasm, ld,
    platform: process.platform,
    arch: process.arch,
    canRun: process.platform === 'linux' && (process.arch === 'x64' || process.env.ALLOW_EMULATED === '1'),
    runDisabled: DISABLE_RUN,
    timeoutMs: RUN_TIMEOUT_MS,
  });
});

// Run accepts a BLOCK PROJECT, not assembly text: the server compiles it itself. That is what
// keeps code-mode (hand-written NASM) files from ever being executed on this machine.
app.post('/api/run', async (req, res) => {
  const refuse = (status, phase, log) => res.status(status).json({ ok: false, phase, log });
  if (DISABLE_RUN) return refuse(403, 'run', 'Running programs is turned off on this server. You can still assemble and download.');
  if (RUN_REQUIRES_LOGIN && !accounts.userFromReq(req)) return refuse(401, 'run', 'Sign in to run programs on this server.');
  if (!req.body || typeof req.body.project !== 'object' || req.body.project === null) {
    return refuse(400, 'request', 'Only block projects can be run on the website. Code-mode files can be assembled and downloaded, not run.');
  }
  let asm, errors;
  try {
    ({ asm, errors } = compile(sanitizeProject(req.body.project)));
  } catch {
    return refuse(400, 'request', 'The project could not be read.');
  }
  if (errors.length) return res.json({ ok: false, phase: 'compile', log: errors.join('\n') });
  const bad = forbiddenDirective(asm);
  if (bad) return res.json({ ok: false, phase: 'assemble', log: bad });
  if (Buffer.byteLength(asm) > MAX_ASM_BYTES) return refuse(400, 'request', 'The generated program is too large.');

  const stdin = typeof req.body.stdin === 'string' ? req.body.stdin.slice(0, 100000) : '';
  const hooks = { child: null };
  let finished = false;
  res.on('close', () => { if (!finished && hooks.child) hooks.child.kill('SIGKILL'); });   // Stop button
  const b = await build(asm);
  if (!b.ok) { finished = true; return res.json(b); }
  try {
    console.log(`  data : ${DATA_DIR}  (accounts ${ALLOW_REGISTRATION ? 'open' : 'closed'}${DISABLE_RUN ? ', running disabled' : ''}${RUN_REQUIRES_LOGIN ? ', run needs login' : ''})`);
  if (process.platform !== 'linux') {
      return res.json({ ok: false, phase: 'run', log: `This server runs on ${process.platform}, which cannot execute Linux ELF files. Use Linux, WSL2 or the Docker setup from the README.` });
    }
    const r = await execute(b.exe, b.dir, stdin, hooks);
    if (r.spawnError) return res.json({ ok: false, phase: 'run', log: r.spawnError });
    res.json({ ok: true, log: b.log, elfSize: b.size, ...r });
  } finally {
    finished = true;
    b.cleanup();
  }
});

// Assemble + link without running anything (used by the Assemble button, both modes).
app.post('/api/check', async (req, res) => {
  if (!validAsm(req.body)) return res.status(400).json({ ok: false, phase: 'request', log: 'Missing or oversized "asm".' });
  const bad = forbiddenDirective(req.body.asm);
  if (bad) return res.json({ ok: false, phase: 'assemble', log: bad });
  const b = await build(req.body.asm);
  if (!b.ok) return res.json(b);
  b.cleanup();
  res.json({ ok: true, log: b.log, elfSize: b.size });
});

app.post('/api/download', async (req, res) => {
  if (!validAsm(req.body)) return res.status(400).json({ ok: false, phase: 'request', log: 'Missing or oversized "asm".' });
  const bad = forbiddenDirective(req.body.asm);
  if (bad) return res.status(422).json({ ok: false, phase: 'assemble', log: bad });
  const b = await build(req.body.asm);
  if (!b.ok) return res.status(422).json(b);
  try {
    const buf = await readFile(b.exe);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="program.elf"' });
    res.send(buf);
  } finally {
    b.cleanup();
  }
});

app.use('/api', (_req, res) => res.status(404).json({ ok: false, log: 'Unknown API route' }));

app.use((err, req, res, next) => {
  if (!req.path.startsWith('/api')) return next(err);
  const tooBig = err.type === 'entity.too.large';
  res.status(tooBig ? 413 : 400).json({ ok: false, error: tooBig ? 'That request is too large.' : 'Malformed request.', log: tooBig ? 'That request is too large.' : 'Malformed request.' });
});

const server = app.listen(PORT, HOST, async () => {
  const [nasm, ld] = await Promise.all([toolVersion('nasm', ['-v']), toolVersion('ld', ['-v'])]);
  console.log(`\n  ScratchASM running at  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  console.log(`  nasm : ${nasm ?? 'NOT FOUND  (sudo apt install nasm)'}`);
  console.log(`  ld   : ${ld ?? 'NOT FOUND  (sudo apt install binutils)'}`);
  console.log(`  data : ${DATA_DIR}  (accounts ${ALLOW_REGISTRATION ? 'open' : 'closed'}${DISABLE_RUN ? ', running disabled' : ''}${RUN_REQUIRES_LOGIN ? ', run needs login' : ''})`);
  if (process.platform !== 'linux') console.log(`  note : ${process.platform} cannot run Linux ELF binaries directly; see README (Docker / WSL2).`);
  console.log('');
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Try: PORT=3001 npm start` : e); process.exit(1); });
