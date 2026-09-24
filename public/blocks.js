// Block definitions for ScratchASM (Assembly-Balanced Architecture)
export const CATEGORIES = [
  { id: 'sections',     label: 'Sections & Data', color: '#E67E22' },
  { id: 'registers',    label: 'Registers & Mem', color: '#4C97FF' },
  { id: 'instructions', label: 'Instructions',    color: '#9B59B6' },
  { id: 'control',      label: 'Control & Jumps', color: '#FFAB19' },
  { id: 'variables',    label: 'Variables',       color: '#FF8C1A' },
  { id: 'labels',       label: 'My Labels',       color: '#FF6680' },
  { id: 'output',       label: 'Syscalls & I/O',  color: '#9966FF' },
  { id: 'asm',          label: 'Raw Assembly',    color: '#5CB1D6' },
];

const num = (i, d = 0) => ({ i, k: 'num', d });
const text = (t, d = '') => ({ t, k: 'text', d });
const regSelect = (t = 'reg') => ({ t, k: 'reg' });
const sizeSelect = (t = 'size') => ({ t, k: 'size' });
const variable = (t = 'var') => ({ t, k: 'var' });

export const REGISTERS = [
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rsp', 'rbp',
  'r8',  'r9',  'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
  'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi',
  'ax',  'bx',  'cx',  'dx',  'al',  'bl',  'cl',  'dl'
];

export const DATA_SIZES = [
  { label: 'byte (1b)',   db: 'db', res: 'resb' },
  { label: 'word (2b)',   db: 'dw', res: 'resw' },
  { label: 'dword (4b)',  db: 'dd', res: 'resd' },
  { label: 'qword (8b)',  db: 'dq', res: 'resq' }
];

export const JUMP_CONDITIONS = [
  { label: 'equal (e / z)',           code: 'je'  },
  { label: 'not equal (ne / nz)',     code: 'jne' },
  { label: 'greater (g)',             code: 'jg'  },
  { label: 'greater or equal (ge)',   code: 'jge' },
  { label: 'less (l)',                code: 'jl'  },
  { label: 'less or equal (le)',      code: 'jle' },
  { label: 'above / unsigned > (a)',  code: 'ja'  },
  { label: 'below / unsigned < (b)',  code: 'jb'  },
];

export const MOVE_CONDITIONS = [
  { label: 'equal (e / z)',           code: 'cmove'  },
  { label: 'not equal (ne / nz)',     code: 'cmovne' },
  { label: 'greater (g)',             code: 'cmovg'  },
  { label: 'greater or equal (ge)',   code: 'cmovge' },
  { label: 'less (l)',                code: 'cmovl'  },
  { label: 'less or equal (le)',      code: 'cmovle' },
];

const condSelect = (t = 'cond', opts = JUMP_CONDITIONS) => ({ t, k: 'cond', opts });

export const BLOCKS = {
  // --- Events & Start
  start: { cat: 'control', shape: 'stack', spec: ['when program starts'] },

  // --- Sections & Memory Allocations
  section_data:   { cat: 'sections', shape: 'hat', spec: ['section .data'] },
  section_rodata: { cat: 'sections', shape: 'hat', spec: ['section .rodata'] },
  section_bss:    { cat: 'sections', shape: 'hat', spec: ['section .bss'] },
  section_text:   { cat: 'sections', shape: 'hat', spec: ['section .text'] },

  define_data: {
    cat: 'sections', shape: 'stack',
    spec: [text('label', 'msg'), ':', sizeSelect('size'), text('value', '"Hello", 10, 0')]
  },
  reserve_bss: {
    cat: 'sections', shape: 'stack',
    spec: [text('label', 'buffer'), ':', 'reserve', num('count', 1), sizeSelect('size')]
  },

  // --- Registers & Memory Addressing
  reg_val:  { cat: 'registers', shape: 'reporter', spec: [regSelect('reg')] },
  mem_ref:  { cat: 'registers', shape: 'reporter', spec: ['[', text('expr', 'rsi + rax*4'), ']'] },
  imm_val:  { cat: 'registers', shape: 'reporter', spec: [num('val', 0)] },

  // --- Assembly Instructions
  mov:  { cat: 'instructions', shape: 'stack', spec: ['move', num('dest'), ',', num('src')] },
  lea:  { cat: 'instructions', shape: 'stack', spec: ['lea', regSelect('dest'), ',', num('src')] },
  add:  { cat: 'instructions', shape: 'stack', spec: ['add', num('dest'), ',', num('src')] },
  sub:  { cat: 'instructions', shape: 'stack', spec: ['subtract', num('dest'), ',', num('src')] },
  xor:  { cat: 'instructions', shape: 'stack', spec: ['XOR', num('dest'), ',', num('src')] },
  and:  { cat: 'instructions', shape: 'stack', spec: ['AND', num('dest'), ',', num('src')] },
  or:   { cat: 'instructions', shape: 'stack', spec: ['OR',  num('dest'), ',', num('src')] },
  cmp:  { cat: 'instructions', shape: 'stack', spec: ['compare', num('a'),    ',', num('b')] },
  push: { cat: 'instructions', shape: 'stack', spec: ['push', num('val')] },
  pop:  { cat: 'instructions', shape: 'stack', spec: ['pop', regSelect('reg')] },
  nop:  { cat: 'instructions', shape: 'stack', spec: ['no operation']},

  // --- Control Flow & Jumps
  jmp: { cat: 'control', shape: 'stack', spec: ['jump to', { t: 'label', k: 'label'}]},
  jcc: { cat: 'control', shape: 'stack', spec: ['jump if', condSelect('cond', JUMP_CONDITIONS), 'to', { t: 'label', k: 'label'}]},
  cmov:{ cat: 'control', shape: 'stack', spec: ['move if', condSelect('cond', MOVE_CONDITIONS), 'from', num('src'), 'to', regSelect('dest')]},
  call:{ cat: 'control', shape: 'stack', spec: ['call', { t: 'label', k: 'label' }] },
  ret: { cat: 'control', shape: 'stack', cap: true, spec: ['ret'] },

  // --- Variables
  set:    { cat: 'variables', shape: 'stack', spec: ['mov [', variable(), '],', num('v', 0)] },
  var:    { cat: 'variables', shape: 'reporter', spec: [{ t: 'name', k: 'varname' }] },

  // --- My Labels (Custom Procedures)
  label_def: { cat: 'labels', shape: 'hat', spec: ['define label', { t: 'name', k: 'labelname', d: 'my_label' }] },

  // --- Syscalls & Output
  syscall: { cat: 'output',  shape: 'stack', spec: ['syscall'] },
  sys_exit:{ cat: 'output',  shape: 'stack', cap: true, spec: ['exit with code', num('code', 0)] },

  // --- Raw Assembly Insertion
  asm:     { cat: 'asm', shape: 'stack', spec: ['asm', { t: 'code', k: 'code', d: 'nop' }] },
  comment: { cat: 'asm', shape: 'stack', spec: [';', text('text', 'comment')] },
};

export function newBlock(type, over = {}) {
  const def = BLOCKS[type];
  if (!def) throw new Error(`Unknown block type: ${type}`);
  const b = { type, f: {}, i: {}, b: [], e: [] };
  for (const tok of def.spec) {
    if (typeof tok !== 'object') continue;
    if (tok.t) b.f[tok.t] = tok.d ?? '';
    else if (tok.i && tok.k === 'num') b.f[tok.i] = tok.d ?? 0;
  }
  Object.assign(b.f, over);
  return b;
}

export function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const target = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  const mix = (c) => Math.round(c + (target - c) * p);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

export function sanitizeBlock(raw) {
  if (!raw || typeof raw !== 'object' || !Object.hasOwn(BLOCKS, raw.type)) return null;
  const b = newBlock(raw.type);
  if (raw.f && typeof raw.f === 'object') {
    for (const k of Object.keys(b.f)) if (k in raw.f && raw.f[k] != null) b.f[k] = String(raw.f[k]);
  }
  if (raw.i && typeof raw.i === 'object') {
    for (const [k, v] of Object.entries(raw.i)) {
      const s = sanitizeBlock(v);
      if (s) b.i[k] = s;
    }
  }
  b.b = (Array.isArray(raw.b) ? raw.b.map(sanitizeBlock).filter(Boolean) : []);
  b.e = (Array.isArray(raw.e) ? raw.e.map(sanitizeBlock).filter(Boolean) : []);
  return b;
}

export function walkBlocks(blocks, fn) {
  for (const b of blocks) {
    fn(b);
    walkBlocks(Object.values(b.i), fn);
    walkBlocks(b.b, fn);
    walkBlocks(b.e, fn);
  }
}