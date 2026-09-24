// Code mode: a plain-text NASM editor (textarea on top of a highlighted <pre>).
import { highlight } from './highlight.js';
import { el } from './ui.js';

export class CodeEditor {
  constructor({ root, onChange }) {
    this.onChange = onChange;
    this.markers = new Set();
    this.lineCount = 0;
    this.freeTab = false;     // Esc then Tab leaves the editor (keyboard-trap escape hatch)

    this.gutterInner = el('div', 'ce-gutter-inner');
    this.gutter = el('div', 'ce-gutter');
    this.gutter.setAttribute('aria-hidden', 'true');
    this.gutter.append(this.gutterInner);

    this.hl = el('pre', 'ce-hl');
    this.hl.setAttribute('aria-hidden', 'true');

    this.input = el('textarea', 'ce-input');
    this.input.spellcheck = false;
    this.input.wrap = 'off';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('autocomplete', 'off');
    this.input.setAttribute('autocorrect', 'off');
    this.input.setAttribute('aria-label', 'NASM source code. Press Escape then Tab to leave the editor.');

    const body = el('div', 'ce-body');
    body.append(this.hl, this.input);
    const wrap = el('div', 'ce');
    wrap.append(this.gutter, body);
    root.append(wrap);

    this.input.addEventListener('input', () => { this.markers.clear(); this.render(); this.onChange?.(); });
    this.input.addEventListener('scroll', () => this.syncScroll());
    this.input.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.input.addEventListener('blur', () => { this.freeTab = false; });
  }

  getValue() { return this.input.value; }
  focus() { this.input.focus(); }

  /** Replace the whole document (does not fire onChange). */
  setValue(text) {
    this.input.value = text;
    this.markers.clear();
    this.render();
    this.input.scrollTop = this.input.scrollLeft = 0;
    this.syncScroll();
  }

  /** Mark 1-based line numbers in the gutter (used for assembler errors). */
  setMarkers(lines) {
    this.markers = new Set(lines);
    this.lineCount = -1;          // force gutter rebuild
    this.render();
  }

  render() {
    const v = this.input.value;
    this.hl.innerHTML = highlight(v) + '\n';
    const n = v.split('\n').length;
    if (n !== this.lineCount) {
      this.lineCount = n;
      let html = '';
      for (let i = 1; i <= n; i++) html += `<div class="ln${this.markers.has(i) ? ' err' : ''}">${i}</div>`;
      this.gutterInner.innerHTML = html;
      this.gutter.style.width = `${String(n).length + 4}ch`;
    }
    this.syncScroll();
  }

  syncScroll() {
    this.hl.scrollTop = this.input.scrollTop;
    this.hl.scrollLeft = this.input.scrollLeft;
    this.gutterInner.style.transform = `translateY(${-this.input.scrollTop}px)`;
  }

  insert(text) {
    const t = this.input;
    t.focus();
    if (!document.execCommand('insertText', false, text)) {      // fallback (loses native undo)
      t.setRangeText(text, t.selectionStart, t.selectionEnd, 'end');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  indent(dir) {
    const t = this.input;
    const { value } = t;
    const s = t.selectionStart;
    const e = t.selectionEnd;
    if (s === e && dir > 0) {
      const col = s - (value.lastIndexOf('\n', s - 1) + 1);
      this.insert(' '.repeat(4 - (col % 4)));
      return;
    }
    const start = value.lastIndexOf('\n', s - 1) + 1;
    const lastChar = e > s && value[e - 1] === '\n' ? e - 1 : e;
    const nl = value.indexOf('\n', lastChar);
    const end = nl === -1 ? value.length : nl;
    const lines = value.slice(start, end).split('\n');
    const changed = lines.map((l) => (dir > 0 ? `    ${l}` : l.replace(/^( {1,4}|\t)/, ''))).join('\n');
    t.setSelectionRange(start, end);
    this.insert(changed);
    t.setSelectionRange(start, start + changed.length);
  }

  onKeyDown(e) {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'Escape') { this.freeTab = true; return; }
    if (e.key === 'Tab' && plain) {
      if (this.freeTab) return;
      e.preventDefault();
      this.indent(e.shiftKey ? -1 : 1);
      return;
    }
    this.freeTab = false;
    if (e.key === 'Enter' && plain && !e.shiftKey) {
      e.preventDefault();
      const t = this.input;
      const before = t.value.slice(t.value.lastIndexOf('\n', t.selectionStart - 1) + 1, t.selectionStart);
      this.insert(`\n${/^[ \t]*/.exec(before)[0]}`);
    }
  }
}
