// NASM syntax highlighting (returns HTML; every piece of source text is escaped).
export const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DIRECTIVES = new Set(['section', 'segment', 'global', 'bits', 'default', 'db', 'dw', 'dd', 'dq', 'resb', 'resw', 'resd', 'resq', 'equ', 'times', 'alignb', 'align', 'extern', 'absolute']);
const TOKEN = /"[^"]*"|'[^']*'|\b(?:r(?:ax|bx|cx|dx|si|di|bp|sp|8|9|1[0-5])[dwb]?|e(?:ax|bx|cx|dx|si|di|bp|sp)|[abcd][lx]|[sd]il|[sb]pl)\b|(?<![\w.])-?(?:0x[0-9a-f]+|\d+)\b/gi;

function highlightRest(rest) {
  let out = '', at = 0;
  for (const m of rest.matchAll(TOKEN)) {
    out += esc(rest.slice(at, m.index));
    const cls = /^["']/.test(m[0]) ? 't-str' : /^[a-z]/i.test(m[0]) ? 't-reg' : 't-num';
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    at = m.index + m[0].length;
  }
  return out + esc(rest.slice(at));
}

/** Index of the ';' that starts a comment, ignoring semicolons inside quotes. */
function commentStart(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ';') return i;
  }
  return -1;
}

export function highlight(src) {
  return src.split('\n').map((line) => {
    const semi = commentStart(line);
    const code = semi >= 0 ? line.slice(0, semi) : line;
    const comment = semi >= 0 ? `<span class="t-c">${esc(line.slice(semi))}</span>` : '';
    const m = /^(\s*)([A-Za-z_.$][\w.$]*:)?(\s*)(%?[A-Za-z]\w*)?(.*)$/.exec(code);
    if (!m) return esc(code) + comment;
    const [, ind, lab = '', gap, word = '', rest] = m;
    const isDir = word.startsWith('%') || DIRECTIVES.has(word.toLowerCase());
    const wordHtml = word ? `<span class="${isDir ? 't-dir' : 't-ins'}">${esc(word)}</span>` : '';
    return esc(ind) + (lab ? `<span class="t-lab">${esc(lab)}</span>` : '') + esc(gap) + wordHtml + highlightRest(rest) + comment;
  }).join('\n');
}
