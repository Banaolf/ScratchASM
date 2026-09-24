import { Editor } from './editor.js';
import { CodeEditor } from './codeeditor.js';
import { compile } from './compiler.js';
import { SAMPLES, CODE_SAMPLES } from './samples.js';
import { highlight, esc } from './highlight.js';
import { CODE_TEMPLATE } from './project.js';
import { $, toast, confirmDialog, promptDialog, openMenu, initTheme } from './ui.js';
import { account, api, refreshAccount, onAccountChange, signInDialog, signOut, projectsDialog } from './account.js';

// ------------------------------------------------------------------ state
const KEYS = {
  blocks: 'scratchasm.project.v1',
  stdin: 'scratchasm.stdin.v1',
  code: 'scratchasm.code.v1',
  mode: 'scratchasm.mode.v1',
  docs: 'scratchasm.docs.v1',
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } },
};

let mode = 'blocks';
// Each mode has its own open document, so switching modes never loses or mixes work.
const docs = {
  blocks: { id: null, name: 'Untitled', dirty: false },
  code: { id: null, name: 'Untitled', dirty: false },
};
const doc = () => docs[mode];

let last = { asm: '', errors: [], warnings: [] };
let timer = 0;
let saveTimer = 0;
let controller = null;
let busy = false;
let serverRunDisabled = false;
let suppress = 0;                       // >0 while loading, so loading doesn't mark the document as edited

const withoutDirty = (fn) => { suppress++; try { fn(); } finally { suppress--; } };
const persistDocs = () => store.set(KEYS.docs, JSON.stringify(docs));

// ------------------------------------------------------------------ editors
const editor = new Editor({
  catsEl: $('#cats'),
  paletteEl: $('#palette'),
  workspaceEl: $('#workspace'),
  canvasEl: $('#canvas'),
  dragLayer: $('#drag-layer'),
  ctxMenu: $('#ctx-menu'),
  onChange: () => {
    if (!suppress) docs.blocks.dirty = true;
    renderDocTitle();
    clearTimeout(timer);
    timer = setTimeout(update, 120);
  },
});

const codeEditor = new CodeEditor({
  root: $('#codeview'),
  onChange: () => {
    if (!suppress) docs.code.dirty = true;
    renderDocTitle();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { store.set(KEYS.code, codeEditor.getValue()); persistDocs(); }, 200);
  },
});

/** Re-compile the block project and refresh the NASM tab. */
function update() {
  last = compile(editor.getProject());
  $('#asm-view').innerHTML = highlight(last.asm);
  $('#asm-stats').textContent = `${last.asm.split('\n').length} lines`;
  showProblems();
  store.set(KEYS.blocks, JSON.stringify(editor.getProject()));
  persistDocs();
}

function showProblems() {
  const box = $('#problems');
  box.replaceChildren();
  if (mode === 'blocks') {
    for (const [cls, list] of [['err', last.errors], ['warn', last.warnings]]) {
      for (const t of list) {
        const d = document.createElement('div');
        d.className = cls;
        d.textContent = t;
        box.append(d);
      }
    }
  }
  box.hidden = box.childElementCount === 0;
}

const currentAsm = () => (mode === 'code' ? codeEditor.getValue() : last.asm);
const currentData = () => (mode === 'code' ? { code: codeEditor.getValue() } : { ...editor.getProject(), stdin: $('#stdin').value });

// ------------------------------------------------------------------ mode
function setMode(next) {
  mode = next;
  document.body.dataset.mode = next;
  document.querySelectorAll('#mode-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
  store.set(KEYS.mode, next);
  fillExamples();
  showTab('output');
  resetOutput();
  syncButtons();
  if (next === 'code') codeEditor.render();
  else update();
  showProblems();
  renderDocTitle();
}

document.querySelectorAll('#mode-switch button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.mode !== mode) setMode(b.dataset.mode);
}));

function syncButtons() {
  const canRun = mode === 'blocks' && !serverRunDisabled;
  $('#btn-run').disabled = busy || !canRun;
  $('#btn-run').title = mode === 'code'
    ? "Code-mode files can't be run on the website. Use Assemble to check them, or Download ELF and run the program yourself."
    : serverRunDisabled ? 'Running is turned off on this server' : 'Assemble, link and run (Ctrl+Enter)';
  $('#btn-stop').disabled = !busy || !controller;
  $('#btn-check').disabled = busy;
  $('#btn-elf').disabled = busy;
}

function setBusy(v) { busy = v; syncButtons(); }

function renderDocTitle() {
  const t = $('#doc-title');
  const d = doc();
  t.textContent = d.name;
  t.classList.toggle('dirty', d.dirty);
  t.title = d.dirty ? `${d.name} (unsaved changes)` : d.name;
}

// ------------------------------------------------------------------ tabs
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ output panel
const out = $('#output');
const status = $('#status');

function print(cls, text) {
  const s = document.createElement('span');
  if (cls) s.className = cls;
  s.textContent = text;
  out.append(s);
}

function setStatus(kind, text) {
  status.className = kind;
  status.textContent = text;
}

function resetOutput() {
  out.replaceChildren();
  setStatus('', '');
  print('dim', mode === 'code'
    ? "Code mode: write NASM in the editor.\n\nAssemble checks that it builds. Download ELF gives you the program to run on your own machine.\nCode-mode files can't be run on the website."
    : 'Press Run. Only scripts that start with "when program starts" are compiled.');
}

const PHASES = { assemble: 'NASM (assembler)', link: 'ld (linker)', compile: 'Blocks compiler', tool: 'Missing tool', run: 'Run', request: 'Request', internal: 'Server' };

function showBuildFailure(d) {
  showTab('output');
  out.replaceChildren();
  print('err', `${PHASES[d.phase] || 'Build'} failed\n\n`);
  print('err', d.log || 'Unknown error');
  setStatus('bad', 'Build failed');
  if (mode === 'code') {
    const lines = [...String(d.log || '').matchAll(/program\.asm:(\d+):/g)].map((m) => Number(m[1]));
    codeEditor.setMarkers(lines);
  }
}

function serverUnreachable(e) {
  showTab('output');
  out.replaceChildren();
  print('err', `Could not reach the ScratchASM server.\n${e.message}`);
  setStatus('bad', 'Server unreachable');
}

function blockedByErrors() {
  if (mode !== 'blocks') return false;
  update();
  if (!last.errors.length) return false;
  showTab('output');
  out.replaceChildren();
  print('err', 'Fix these problems first:\n');
  for (const e of last.errors) print('err', `  \u2022 ${e}\n`);
  setStatus('bad', 'Not built');
  return true;
}

const post = (url, body, signal) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

// ------------------------------------------------------------------ run / assemble / download
async function run() {
  if (mode !== 'blocks' || busy || serverRunDisabled) return;
  if (blockedByErrors()) return;
  showTab('output');
  out.replaceChildren();
  print('dim', 'Assembling and running...\n');
  setStatus('', '');
  controller = new AbortController();
  setBusy(true);
  try {
    // The server compiles the block project itself; it never runs assembly text sent by the browser.
    const res = await post('/api/run', { project: editor.getProject(), stdin: $('#stdin').value }, controller.signal);
    const d = await res.json();
    out.replaceChildren();
    if (!d.ok) { showBuildFailure(d); return; }
    if (d.log) print('warn', `${d.log}\n\n`);
    if (d.stdout) print('', d.stdout);
    if (d.stderr) print('err', d.stderr);
    if (!d.stdout && !d.stderr) print('dim', '(no output)');
    const parts = [];
    let bad = d.exitCode !== 0;
    if (d.timedOut) { parts.push(`timed out after ${(d.ms / 1000).toFixed(1)}s and was killed`); bad = true; }
    else if (d.signal) { parts.push(`killed by ${d.signal}${d.signal === 'SIGSEGV' ? ' (segmentation fault)' : ''}`); bad = true; }
    else parts.push(`exit code ${d.exitCode}`);
    if (d.truncated) parts.push('output truncated at 1 MiB');
    parts.push(`${d.ms} ms`, `ELF ${(d.elfSize / 1024).toFixed(1)} KiB`);
    setStatus(bad ? 'bad' : 'ok', parts.join('  |  '));
  } catch (e) {
    if (e.name === 'AbortError') { out.replaceChildren(); print('dim', 'Stopped.'); setStatus('', 'Stopped'); }
    else serverUnreachable(e);
  } finally {
    controller = null;
    setBusy(false);
  }
}

async function assemble() {
  if (busy) return;
  if (blockedByErrors()) return;
  const asm = currentAsm();
  showTab('output');
  out.replaceChildren();
  if (!asm.trim()) { print('dim', 'Nothing to assemble yet.'); return; }
  print('dim', 'Assembling and linking...\n');
  setStatus('', '');
  setBusy(true);
  try {
    const d = await (await post('/api/check', { asm })).json();
    if (!d.ok) { showBuildFailure(d); return; }
    if (mode === 'code') codeEditor.setMarkers([]);
    out.replaceChildren();
    if (d.log) print('warn', `${d.log}\n\n`);
    print('', 'Assembled and linked without errors.');
    setStatus('ok', `ELF ${(d.elfSize / 1024).toFixed(1)} KiB  |  ready: use Download ELF`);
  } catch (e) {
    serverUnreachable(e);
  } finally {
    setBusy(false);
  }
}

async function downloadElf() {
  if (busy) return;
  if (blockedByErrors()) return;
  const asm = currentAsm();
  if (!asm.trim()) { toast('There is nothing to build yet.', 'error'); return; }
  setBusy(true);
  try {
    const res = await post('/api/download', { asm });
    if (!res.ok) {
      showBuildFailure(await res.json().catch(() => ({ log: `HTTP ${res.status}` })));
      return;
    }
    saveBlob(await res.blob(), 'program.elf');
    showTab('output');
    setStatus('ok', 'Saved program.elf. Run it with: chmod +x program.elf && ./program.elf');
  } catch (e) {
    serverUnreachable(e);
  } finally {
    setBusy(false);
  }
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'scratchasm';

$('#btn-run').addEventListener('click', run);
$('#btn-stop').addEventListener('click', () => controller?.abort());
$('#btn-check').addEventListener('click', assemble);
$('#btn-elf').addEventListener('click', downloadElf);

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); if (mode === 'blocks') run(); else assemble(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); }
});

// ------------------------------------------------------------------ NASM tab
$('#btn-copy-asm').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText(last.asm); e.target.textContent = 'Copied'; }
  catch { e.target.textContent = 'Copy failed'; }
  setTimeout(() => { e.target.textContent = 'Copy'; }, 1200);
});
$('#btn-dl-asm').addEventListener('click', () => saveBlob(new Blob([last.asm], { type: 'text/plain' }), 'program.asm'));
$('#btn-to-code').addEventListener('click', () => copyToCode());

// ------------------------------------------------------------------ loading documents
/** Asks before replacing the document of `target` mode if it has unsaved edits. */
async function confirmDiscard(target = mode) {
  if (!docs[target].dirty) return true;
  return confirmDialog(`Your ${target === 'code' ? 'code file' : 'blocks project'} has unsaved changes. Continue and replace it?`,
    { title: 'Discard changes?', confirmText: 'Discard', danger: true });
}

function loadBlocks(project, stdin = '', meta = {}) {
  withoutDirty(() => {
    editor.setProject(project);
    $('#stdin').value = stdin;
    editor.renderCats();
  });
  store.set(KEYS.stdin, stdin);
  docs.blocks = { id: meta.id ?? null, name: meta.name ?? 'Untitled', dirty: false };
}

function loadCode(text, meta = {}) {
  withoutDirty(() => codeEditor.setValue(text));
  store.set(KEYS.code, text);
  docs.code = { id: meta.id ?? null, name: meta.name ?? 'Untitled', dirty: false };
}

/** After loading into `target`: make it the visible mode and reset the output panel. */
function showLoaded(target) {
  if (target !== mode) setMode(target);
  else { resetOutput(); showTab('output'); if (mode === 'blocks') update(); renderDocTitle(); }
  persistDocs();
}

async function newDocument() {
  if (!(await confirmDiscard())) return;
  if (mode === 'code') loadCode(CODE_TEMPLATE);
  else loadBlocks({ variables: ['x'], scripts: [] });
  showLoaded(mode);
}

/** Copies the generated NASM into the code-mode file, so it can be edited by hand. */
async function copyToCode() {
  update();
  if (!(await confirmDiscard('code'))) return;
  loadCode(last.asm, { name: `${docs.blocks.name} (code)` });
  showLoaded('code');
  codeEditor.focus();
  toast('Copied the generated NASM into Code mode', 'ok');
}

// ------------------------------------------------------------------ examples
const examples = $('#examples');
function fillExamples() {
  examples.replaceChildren(new Option('Examples', ''));
  (mode === 'code' ? CODE_SAMPLES : SAMPLES).forEach((s, i) => examples.append(new Option(s.name, String(i))));
}
examples.addEventListener('change', async () => {
  const s = (mode === 'code' ? CODE_SAMPLES : SAMPLES)[Number(examples.value)];
  examples.value = '';
  if (!s || !(await confirmDiscard())) return;
  if (mode === 'code') loadCode(s.code, { name: s.name });
  else loadBlocks(s.build(), s.stdin ?? '', { name: s.name });
  showLoaded(mode);
});

$('#stdin').addEventListener('input', () => store.set(KEYS.stdin, $('#stdin').value));
$('#btn-clean').addEventListener('click', () => editor.cleanUp());

// ------------------------------------------------------------------ save / open (server) and export / import (file)
async function saveProject({ saveAs = false } = {}) {
  if (!account.user && !(await signInDialog())) return;
  const d = doc();
  let name = d.name;
  if (saveAs || !d.id) {
    name = await promptDialog('Project name', {
      title: saveAs ? 'Save a copy' : 'Save project',
      value: d.name === 'Untitled' ? '' : d.name,
      placeholder: mode === 'code' ? 'My NASM program' : 'My block program',
      confirmText: 'Save',
    });
    if (!name) return;
  }
  const body = { name, mode, data: currentData() };
  try {
    const res = d.id && !saveAs ? await api('PUT', `/api/projects/${d.id}`, body) : await api('POST', '/api/projects', body);
    docs[mode] = { id: res.project.id, name: res.project.name, dirty: false };
    renderDocTitle();
    persistDocs();
    toast(`Saved "${res.project.name}"`, 'ok');
  } catch (e) {
    if (e.status === 404 && d.id) { d.id = null; return saveProject(); }   // deleted elsewhere: save as new
    if (e.status === 401) await refreshAccount();
    toast(e.message, 'error');
  }
}

async function openSaved(p) {
  if (!(await confirmDiscard(p.mode))) return;
  if (p.mode === 'code') loadCode(String(p.data.code ?? ''), { id: p.id, name: p.name });
  else loadBlocks(p.data, typeof p.data.stdin === 'string' ? p.data.stdin : '', { id: p.id, name: p.name });
  showLoaded(p.mode);
}

function exportFile() {
  if (mode === 'code') {
    saveBlob(new Blob([codeEditor.getValue()], { type: 'text/plain' }), `${slug(doc().name)}.asm`);
  } else {
    const data = { mode: 'blocks', ...currentData() };
    saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${slug(doc().name)}.json`);
  }
}

$('#file-open').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 1024 * 1024) { toast('That file is larger than 1 MiB.', 'error'); return; }
  try {
    const text = await file.text();
    const name = file.name.replace(/\.[^.]+$/, '') || 'Untitled';
    let target = 'code';
    let data = null;
    if (/\.json$/i.test(file.name)) {
      data = JSON.parse(text);
      if (Array.isArray(data.scripts)) target = 'blocks';
      else if (data.mode === 'code' && typeof data.code === 'string') target = 'code';
      else throw new Error('this is not a ScratchASM project');
    }
    if (!(await confirmDiscard(target))) return;
    if (target === 'blocks') loadBlocks(data, typeof data.stdin === 'string' ? data.stdin : '', { name });
    else loadCode(data ? data.code : text, { name });
    showLoaded(target);
  } catch (err) {
    toast(`Could not open that file: ${err.message}`, 'error');
  }
});

function openFileMenu() {
  openMenu($('#btn-file'), [
    { label: mode === 'code' ? 'New code file' : 'New blocks project', onClick: newDocument },
    { label: 'My projects...', onClick: openProjects },
    '-',
    { label: 'Save', hint: 'Ctrl+S', onClick: () => saveProject() },
    { label: 'Save a copy...', onClick: () => saveProject({ saveAs: true }) },
    '-',
    { label: mode === 'code' ? 'Export .asm file' : 'Export .json file', onClick: exportFile },
    { label: 'Import file...', onClick: () => $('#file-open').click() },
    ...(mode === 'blocks' ? ['-', { label: 'Edit this program as code', onClick: () => copyToCode() }] : []),
  ]);
}
$('#btn-file').addEventListener('click', openFileMenu);

async function openProjects() {
  if (!account.user && !(await signInDialog())) return;
  projectsDialog({ onOpen: openSaved, currentId: doc().id });
}

// ------------------------------------------------------------------ account button
function renderAccount() {
  const b = $('#btn-account');
  b.textContent = account.user ? account.user.username : 'Sign in';
  b.title = account.user ? 'Account menu' : 'Sign in or create an account to save projects on this server';
}
onAccountChange((user) => {
  if (!user) { docs.blocks.id = null; docs.code.id = null; persistDocs(); }   // saved-project ids belong to the account
  renderAccount();
  renderDocTitle();
});
$('#btn-account').addEventListener('click', () => {
  if (!account.user) { signInDialog(); return; }
  openMenu($('#btn-account'), [
    { label: `Signed in as ${account.user.username}`, disabled: true },
    { label: 'My projects...', onClick: openProjects },
    '-',
    { label: 'Sign out', onClick: async () => { await signOut(); toast('Signed out'); } },
  ]);
});

initTheme($('#btn-theme'));

// ------------------------------------------------------------------ server status banner
async function checkServer() {
  const banner = $('#banner');
  const problems = [];
  try {
    const s = await (await fetch('/api/status')).json();
    serverRunDisabled = !!s.runDisabled;
    if (!s.nasm) problems.push('NASM was not found. Install it with <code>sudo apt install nasm</code>.');
    if (!s.ld) problems.push('The linker <code>ld</code> was not found. Install it with <code>sudo apt install binutils</code>.');
    if (s.runDisabled) problems.push('Running programs is turned off on this server. You can still assemble and download.');
    else if (!s.canRun) problems.push(`This server runs on ${esc(s.platform)}/${esc(s.arch)}, which cannot execute x86-64 Linux ELF files directly. You can still generate NASM; to run programs use Linux, WSL2 or Docker (see the README).`);
  } catch {
    problems.push('Cannot reach the ScratchASM server. Is <code>npm start</code> still running?');
  }
  banner.innerHTML = problems.join('<br>');
  banner.hidden = problems.length === 0;
  syncButtons();
}

// ------------------------------------------------------------------ boot
(function boot() {
  let project = null;
  try { project = JSON.parse(store.get(KEYS.blocks) || 'null'); } catch { /* ignore */ }
  if (project && Array.isArray(project.scripts) && project.scripts.length) loadBlocks(project, store.get(KEYS.stdin) || '');
  else loadBlocks(SAMPLES[0].build(), '', { name: SAMPLES[0].name });

  loadCode(store.get(KEYS.code) ?? CODE_TEMPLATE);

  try {
    const saved = JSON.parse(store.get(KEYS.docs) || 'null');
    for (const m of ['blocks', 'code']) {
      if (saved?.[m]) docs[m] = { id: saved[m].id ?? null, name: String(saved[m].name || 'Untitled'), dirty: !!saved[m].dirty };
    }
  } catch { /* ignore */ }

  renderAccount();
  setMode(store.get(KEYS.mode) === 'code' ? 'code' : 'blocks');
  refreshAccount();
  checkServer();
})();
