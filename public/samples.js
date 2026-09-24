import { newBlock } from './blocks.js';

const B = (type, f = {}) => newBlock(type, f);
const script = (x, y, ...blocks) => ({ x, y, blocks });

export const SAMPLES = [
  {
    name: 'Syscall Write ("Hello Assembly")',
    build: () => ({
      variables: ['counter'],
      scripts: [
        script(40, 40,
          B('section_rodata'),
          B('define_data', { label: 'msg', size: 'byte (1b)', value: '"Hello Assembly!", 10' }),
          B('define_data', { label: 'len', size: 'qword (8b)', value: '$ - msg' }),
          B('section_text'),
          B('start'),
          B('mov', { dest: 'rax', src: '1' }),       // sys_write
          B('mov', { dest: 'rdi', src: '1' }),       // stdout
          B('lea', { dest: 'rsi', src: 'msg' }),     // buffer
          B('mov', { dest: 'rdx', src: '[len]' }),    // length (read from the data label)
          B('syscall'),
          B('sys_exit', { code: 0 })
        )
      ]
    })
  },
  {
    name: 'Loop using "My Label" & Jump',
    build: () => ({
      variables: ['counter'],
      scripts: [
        script(40, 40,
          B('start'),
          B('set', { var: 'counter', v: 5 }),
          B('call', { label: 'loop_top' }),
          B('sys_exit', { code: 0 })
        ),
        script(40, 220,
          B('label_def', { name: 'loop_top' }),
          B('mov', { dest: 'rax', src: '1' }),
          B('mov', { dest: 'rdi', src: '1' }),
          B('syscall'),
          B('ret')
        )
      ]
    })
  }
];

// Code-mode examples: plain NASM, starting from the same watermark as a blank file.
const WATERMARK = [
  '; ---------------------------------------------------------------------',
  '; ScratchASM (code mode): x86-64 NASM for Linux',
  '; ---------------------------------------------------------------------',
  '',
].join('\n');

export const CODE_SAMPLES = [
  {
    name: 'Hello, NASM',
    code: WATERMARK + `default rel
global _start

section .rodata
msg:    db "Hello from hand-written NASM!", 10
len:    equ $ - msg

section .text
_start:
    mov eax, 1              ; sys_write
    mov edi, 1              ; fd = stdout
    lea rsi, [msg]
    mov edx, len
    syscall

    mov eax, 60             ; sys_exit
    xor edi, edi            ; status 0
    syscall

section .note.GNU-stack noalloc noexec nowrite progbits
`,
  },
  {
    name: 'Count to five',
    code: WATERMARK + `default rel
global _start

section .bss
digit:  resb 2

section .text
_start:
    mov rbx, 1              ; counter
.next:
    mov al, bl
    add al, '0'             ; number -> ASCII digit
    mov [digit], al
    mov byte [digit + 1], 10

    mov eax, 1              ; sys_write(1, digit, 2)
    mov edi, 1
    lea rsi, [digit]
    mov edx, 2
    syscall

    inc rbx
    cmp rbx, 5
    jle .next

    mov eax, 60
    xor edi, edi
    syscall

section .note.GNU-stack noalloc noexec nowrite progbits
`,
  },
];
