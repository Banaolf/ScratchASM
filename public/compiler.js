// Compiler: Converts scratch assembly blocks into NASM x86-64 code.
import { DATA_SIZES } from './blocks.js';

const ident = (name) => String(name).replace(/[^A-Za-z0-9_]/g, '_') || '_';
const oneLine = (s, max = 80) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, max);

const COND_MAP = {
  'equal (e / z)': 'je',
  'not equal (ne / nz)': 'jne',
  'greater (g)': 'jg',
  'greater or equal (ge)': 'jge',
  'less (l)': 'jl',
  'less or equal (le)': 'jle',
  'above / unsigned > (a)': 'ja',
  'below / unsigned < (b)': 'jb',

  'cmove': 'cmove',
  'cmovne': 'cmovne',
  'cmovg': 'cmovg',
  'cmovge': 'cmovge',
  'cmovl': 'cmovl',
  'cmovle': 'cmovle',
};

export function compile(project) {
  const errors = [];
  const warnings = [];
  const scripts = project.scripts || [];

  const rodataLines = [];
  const dataLines = [];
  const bssLines = [];
  const textLines = [];

  let currentSection = 'text';

  // --- Track Variables ---
  const varLabels = new Map();
  function varLabel(name) {
    const key = String(name ?? '').trim();
    if (!key) return 'v_unnamed';
    if (!varLabels.has(key)) {
      varLabels.set(key, 'v_' + ident(key));
    }
    return varLabels.get(key);
  }
  for (const v of project.variables || []) if (String(v).trim()) varLabel(v);

  function getOperand(b, key) {
    if (b.i[key]) {
      const sub = b.i[key];
      if (sub.type === 'reg_val') return sub.f.reg || 'rax';
      if (sub.type === 'mem_ref') return `[${sub.f.expr || 'rax'}]`;
      if (sub.type === 'imm_val') return String(sub.f.val ?? '0');
      if (sub.type === 'var') return `[${varLabel(sub.f.name)}]`;
    }
    return String(b.f[key] ?? '0');
  }

  function emit(code) {
    const line = '    ' + code;
    if (currentSection === 'rodata') rodataLines.push(line);
    else if (currentSection === 'data') dataLines.push(line);
    else if (currentSection === 'bss') bssLines.push(line);
    else textLines.push(line);
  }

  function putLabel(label) {
    const line = `${ident(label)}:`;
    if (currentSection === 'rodata') rodataLines.push(line);
    else if (currentSection === 'data') dataLines.push(line);
    else if (currentSection === 'bss') bssLines.push(line);
    else textLines.push(line);
  }

  function processBlock(b) {
    switch (b.type) {
      case 'section_rodata': currentSection = 'rodata'; return;
      case 'section_data':   currentSection = 'data'; return;
      case 'section_bss':    currentSection = 'bss'; return;
      case 'section_text':   currentSection = 'text'; return;

      case 'label_def':
        putLabel(b.f.name || 'label');
        return;

      case 'define_data': {
        const lbl = b.f.label ? `${b.f.label}: ` : '    ';
        const sizeObj = DATA_SIZES.find(s => s.label === b.f.size) || DATA_SIZES[0];
        const line = `${lbl}${sizeObj.db} ${b.f.value || '0'}`;
        if (currentSection === 'rodata') rodataLines.push(line);
        else dataLines.push(line);
        return;
      }

      case 'reserve_bss': {
        const lbl = b.f.label ? `${b.f.label}: ` : '    ';
        const sizeObj = DATA_SIZES.find(s => s.label === b.f.size) || DATA_SIZES[0];
        bssLines.push(`${lbl}${sizeObj.res} ${b.f.count || 1}`);
        return;
      }

      case 'mov':  emit(`mov ${getOperand(b, 'dest')}, ${getOperand(b, 'src')}`); return;
      case 'lea':  emit(`lea ${b.f.dest || 'rax'}, ${getOperand(b, 'src')}`); return;
      case 'add':  emit(`add ${getOperand(b, 'dest')}, ${getOperand(b, 'src')}`); return;
      case 'sub':  emit(`sub ${getOperand(b, 'dest')}, ${getOperand(b, 'src')}`); return;
      case 'xor':  emit(`xor ${getOperand(b, 'dest')}, ${getOperand(b, 'src')}`); return;
      case 'and':  emit(`and ${getOperand(b, 'dest')}, ${getOperand(b, 'src')}`); return;
      case 'or':   emit(`or ${getOperand(b, 'dest')}, ${getOperand(b, 'src')}`); return;
      case 'cmp':  emit(`cmp ${getOperand(b, 'a')}, ${getOperand(b, 'b')}`); return;
      case 'push': emit(`push ${getOperand(b, 'val')}`); return;
      case 'pop':  emit(`pop ${b.f.reg || 'rax'}`); return;
      case 'nop': emit(`nop`); return;

      case 'set':  emit(`mov qword [${varLabel(b.f.var)}], ${getOperand(b, 'v')}`); return;

      case 'jmp':  emit(`jmp ${ident(b.f.label || '0')}`); return;
      case 'jcc': {
        const cond = b.f.cond || JUMP_CONDITIONS[0].label;
        const mnemonic = COND_MAP[cond] || JUMP_CONDITIONS.find(c => c.label === cond)?.code || 'je';
        emit(`${mnemonic} ${ident(b.f.label || '0')}`);
        return;
      }

      case 'cmov': {
        const cond = b.f.cond || MOVE_CONDITIONS[0].label;
        const mnemonic = COND_MAP[cond] || MOVE_CONDITIONS.find(c => c.label === cond)?.code || 'cmove';
        const dest = b.f.dest || 'rax';
        const src = getOperand(b, 'src');
        emit(`${mnemonic} ${dest}, ${src}`);
        return;
      }
      case 'call': emit(`call ${ident(b.f.label || '0')}`); return;
      case 'ret':  emit('ret'); return;

      case 'syscall': emit('syscall'); return;
      case 'sys_exit':
        emit(`mov rdi, ${getOperand(b, 'code')}`);
        emit('mov eax, 60');
        emit('syscall');
        return;

      case 'asm':
        if (b.f.code) {
          const line = String(b.f.code).trim();
          if (/^[A-Za-z_.$][\w.$]*:/.test(line)) putLabel(line.replace(':', ''));
          else emit(line);
        }
        return;

      case 'comment':
        emit(`; ${oneLine(b.f.text)}`);
        return;

      case 'start':
        return;

      default:
        warnings.push(`Unhandled block type: ${b.type}`);
    }
  }

  const sortedScripts = [...scripts].sort((a, b) => a.y - b.y || a.x - b.x);

  for (const s of sortedScripts) {
    const firstBlock = s.blocks[0];
    if (!firstBlock) continue;

    // Set default section or detect section header from the hat block
    if (firstBlock.type === 'section_data') currentSection = 'data';
    else if (firstBlock.type === 'section_rodata') currentSection = 'rodata';
    else if (firstBlock.type === 'section_bss') currentSection = 'bss';
    else if (firstBlock.type === 'section_text') currentSection = 'text';
    else currentSection = 'text'; // Default for _start, labels, or unsectioned blocks

    for (const b of s.blocks) {
      if (b.type === 'start') {
        textLines.push('');
        textLines.push('_start:');
      } else {
        processBlock(b);
      }
    }
  }

  // --- Add Global Variables to .bss ---
  for (const l of varLabels.values()) {
    bssLines.push(`${l}: resq 1`);
  }

  const asm = [];
  asm.push('; ---------------------------------------------------------------------');
  asm.push('; Generated by ScratchASM (Assembly Edition) - x86-64 Linux');
  asm.push('; ---------------------------------------------------------------------');
  asm.push('bits 64');
  asm.push('default rel');
  asm.push('');

  if (rodataLines.length) {
    asm.push('section .rodata');
    asm.push(...rodataLines);
    asm.push('');
  }

  if (dataLines.length) {
    asm.push('section .data');
    asm.push(...dataLines);
    asm.push('');
  }

  if (bssLines.length) {
    asm.push('section .bss');
    asm.push('alignb 8');
    asm.push(...bssLines);
    asm.push('');
  }

  asm.push('section .text');
  asm.push('global _start');
  asm.push(...textLines);
  asm.push('');
  asm.push('section .note.GNU-stack noalloc noexec nowrite progbits');

  return { asm: asm.join('\n'), errors, warnings };
}