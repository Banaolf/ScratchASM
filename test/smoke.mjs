// Compiles every block sample and assembles + runs it; assembles every code-mode sample.
import { compile } from '../public/compiler.js';
import { SAMPLES, CODE_SAMPLES } from '../public/samples.js';
import { CODE_TEMPLATE, sanitizeProject } from '../public/project.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const expected = {
  'Syscall Write ("Hello Assembly")': (o) => o === 'Hello Assembly!\n',
  'Loop using "My Label" & Jump': (o) => o === '',
  'Hello, NASM': (o) => o === 'Hello from hand-written NASM!\n',
  'Count to five': (o) => o === '1\n2\n3\n4\n5\n',
};

function buildAndRun(name, asm, stdin = '') {
  const dir = mkdtempSync(path.join(tmpdir(), 'sa-'));
  try {
    writeFileSync(path.join(dir, 'p.asm'), asm);
    execFileSync('nasm', ['-f', 'elf64', path.join(dir, 'p.asm'), '-o', path.join(dir, 'p.o')], { stdio: 'pipe' });
    const ld = spawnSync('ld', ['-o', path.join(dir, 'p'), path.join(dir, 'p.o')], { encoding: 'utf8' });
    if (ld.status !== 0 || ld.stderr) throw new Error(`ld: ${ld.stderr}`);
    const r = spawnSync(path.join(dir, 'p'), [], { input: stdin, timeout: 5000 });
    const out = r.stdout.toString();
    return { ok: r.status === 0 && expected[name](out), r, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failed = 0;
const report = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra}`); if (!ok) failed++; };

for (const s of SAMPLES) {
  try {
    const { asm, errors, warnings } = compile(sanitizeProject(s.build()));
    if (errors.length) throw new Error(`compile errors: ${errors.join('; ')}`);
    const { ok, r, out } = buildAndRun(s.name, asm, s.stdin ?? '');
    report(ok, `blocks  ${s.name}`, warnings.length ? `  (warnings: ${warnings.join('; ')})` : '');
    if (!ok) console.log('   exit', r.status, r.signal, JSON.stringify(out));
  } catch (e) { report(false, `blocks  ${s.name}`, `\n   ${(e.stderr || e.message).toString().trim()}`); }
}

for (const s of CODE_SAMPLES) {
  try {
    const { ok, r, out } = buildAndRun(s.name, s.code);
    report(ok, `code    ${s.name}`);
    if (!ok) console.log('   exit', r.status, r.signal, JSON.stringify(out));
  } catch (e) { report(false, `code    ${s.name}`, `\n   ${(e.stderr || e.message).toString().trim()}`); }
}

// The blank code-mode file is only a watermark, and still assembles once it has a body.
report(CODE_TEMPLATE.split('\n').filter((l) => l.trim() && !l.startsWith(';')).length === 0, 'code    blank template is comments only');

// Untrusted project JSON is reduced to known block types.
const dirty = sanitizeProject({ scripts: [{ x: 'a', y: 5, blocks: [{ type: 'start' }, { type: '__proto__' }, { type: 'nope' }] }], variables: [' k ', 3] });
report(dirty.scripts[0].blocks.length === 1 && dirty.variables.join() === 'k,3', 'project sanitiser drops unknown blocks');

process.exit(failed ? 1 : 0);
