// Shared by the browser and the server: project sanitising + the code-mode template.
import { sanitizeBlock, walkBlocks } from './blocks.js';

/** The blank file a new code-mode document starts from. */
export const CODE_TEMPLATE = [
  '; ---------------------------------------------------------------------',
  '; ScratchASM (code mode): x86-64 NASM for Linux',
  '; ---------------------------------------------------------------------',
  '',
  '',
].join('\n');

export const MAX_CODE_CHARS = 256 * 1024;

/** Turns untrusted JSON into a well-formed block project (drops anything unknown). */
export function sanitizeProject(p) {
  const scripts = [];
  for (const s of Array.isArray(p?.scripts) ? p.scripts : []) {
    const blocks = (Array.isArray(s?.blocks) ? s.blocks : []).map(sanitizeBlock).filter(Boolean);
    if (blocks.length) scripts.push({ x: Number(s.x) || 0, y: Number(s.y) || 0, blocks });
  }
  const variables = [];
  const add = (v) => {
    const name = String(v ?? '').trim();
    if (name && !variables.includes(name)) variables.push(name);
  };
  for (const v of Array.isArray(p?.variables) ? p.variables : []) add(v);
  for (const s of scripts) walkBlocks(s.blocks, (b) => add(b.type === 'var' ? b.f.name : b.f.var));
  return { version: 1, variables, scripts };
}
