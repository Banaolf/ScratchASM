import { BLOCKS, CATEGORIES, REGISTERS, DATA_SIZES, newBlock, shade } from './blocks.js';
import { sanitizeProject } from './project.js';
import { promptDialog } from './ui.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const SNAP = 24;

export class Editor {
  constructor(opts) {
    Object.assign(this, opts);
    this.ws = { variables: ['x'], scripts: [] };
    this.cat = 'sections';
    this.pending = null;
    this.drag = null;
    this.marker = el('div', 'insert-marker');
    this.marker.hidden = true;
    this.paletteSig = '';
    this.bind();
    this.renderCats();
    this.renderAll();
  }

  getProject() { 
    return { version: 1, variables: [...this.ws.variables], scripts: clone(this.ws.scripts) }; 
  }

  setProject(p) {
    const { variables, scripts } = sanitizeProject(p);
    this.ws = { variables, scripts };
    this.paletteSig = '';
    this.renderAll();
    this.changed();
  }

  /** Stack every script in one tidy column, top to bottom in their current order. */
  cleanUp() {
    const nodes = [...this.canvasEl.querySelectorAll(':scope > .script')]
      .sort((a, b) => a._script.y - b._script.y || a._script.x - b._script.x);
    let y = 24;
    for (const n of nodes) {
      n._script.x = 24;
      n._script.y = y;
      y += n.offsetHeight + 24;
    }
    this.renderAll();
    this.changed();
  }

  labelNames() {
    const names = this.ws.scripts.map((s) => s.blocks[0]).filter((b) => b?.type === 'label_def')
      .map((b) => String(b.f.name ?? '').trim()).filter(Boolean);
    return [...new Set(names)];
  }

  changed() { this.onChange?.(); }

  bind() {
    this.workspaceEl.addEventListener('pointerdown', (e) => this.onDown(e, false));
    this.paletteEl.addEventListener('pointerdown', (e) => this.onDown(e, true));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onUp(e));
    this.workspaceEl.addEventListener('contextmenu', (e) => this.onContext(e));
    window.addEventListener('pointerdown', (e) => { if (!this.ctxMenu.contains(e.target)) this.ctxMenu.hidden = true; }, true);
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.ctxMenu.hidden = true; });
  }

  onDown(e, fromPalette) {
    if (e.button !== 0) return;
    const blockEl = e.target.closest('.block');
    if (!blockEl || e.target.closest('input, select, textarea')) return;
    e.preventDefault();
    const r = blockEl.getBoundingClientRect();
    this.pending = { blockEl, fromPalette, sx: e.clientX, sy: e.clientY, off: { x: e.clientX - r.left, y: e.clientY - r.top } };
  }

  onMove(e) {
    if (this.pending && !this.drag) {
      if (Math.hypot(e.clientX - this.pending.sx, e.clientY - this.pending.sy) < 4) return;
      this.startDrag(this.pending);
      this.pending = null;
    }
    if (this.drag) {
      const { wrap, off } = this.drag;
      wrap.style.left = `${e.clientX - off.x}px`;
      wrap.style.top = `${e.clientY - off.y}px`;
      this.updateTarget(e.clientX, e.clientY);
    }
  }

  onUp(e) {
    this.pending = null;
    if (this.drag) this.finishDrag(e);
  }

  startDrag(p) {
    const node = p.blockEl;
    let blocks;
    if (p.fromPalette) {
      blocks = [node._factory()];
    } else if (node._loc) {
      const { list, index } = node._loc;
      blocks = list.splice(index);
      if (list.length === 0) this.ws.scripts = this.ws.scripts.filter(s => s.blocks !== list);
    } else if (node._slotRef) {
      const { owner, name } = node._slotRef;
      blocks = [owner.i[name]];
      delete owner.i[name];
    } else return;

    if (!p.fromPalette) this.renderAll();
    const wrap = el('div', 'script dragging');
    wrap.append(this.renderList(blocks));
    this.dragLayer.append(wrap);
    this.drag = { blocks, wrap, off: p.off, target: null };
  }

  clearTarget() {
    this.drag.target = null;
    this.marker.hidden = true;
  }

  updateTarget(px, py) {
    const d = this.drag;
    this.clearTarget();
    const ws = this.workspaceEl.getBoundingClientRect();
    const overPalette = px < ws.left;
    this.paletteEl.classList.toggle('delete-zone', overPalette);
    if (overPalette || px > ws.right || py < ws.top || py > ws.bottom) return;

    const r = d.wrap.getBoundingClientRect();
    const first = BLOCKS[d.blocks[0].type];

    if (first.shape === 'reporter') {
      const probe = [r.left + 6, r.top + r.height / 2];
      for (const n of document.elementsFromPoint(probe[0], probe[1])) {
        const slot = n.closest?.('.slot');
        if (slot && this.canvasEl.contains(slot)) {
          d.target = { type: 'slot', slot };
          return;
        }
      }
      return;
    }

    let best = null;
    const consider = (dist, list, index, x, y) => {
      if (dist < SNAP && (!best || dist < best.dist)) best = { dist, list, index, x, y };
    };

    for (const L of this.canvasEl.querySelectorAll('.list')) {
      const list = L._list;
      if (!list) continue;
      const kids = [...L.children].map(k => k.getBoundingClientRect());
      const lr = L.getBoundingClientRect();
      for (let i = 0; i <= kids.length; i++) {
        const x = i === 0 ? lr.left : kids[i - 1].left;
        const y = i === 0 ? lr.top : kids[i - 1].bottom;
        consider(Math.hypot(r.left - x, r.top - y), list, i, x, y);
      }
    }

    if (best) {
      d.target = { type: 'list', list: best.list, index: best.index };
      const c = this.canvasEl.getBoundingClientRect();
      this.marker.style.left = `${best.x - c.left}px`;
      this.marker.style.top = `${best.y - c.top - 3}px`;
      this.marker.hidden = false;
    }
  }

  finishDrag(e) {
    const d = this.drag;
    this.drag = null;
    const r = d.wrap.getBoundingClientRect();
    const ws = this.workspaceEl.getBoundingClientRect();
    const c = this.canvasEl.getBoundingClientRect();
    const t = d.target;
    d.wrap.remove();
    this.marker.hidden = true;
    this.paletteEl.classList.remove('delete-zone');

    if (e.clientX < ws.left) {
      // Dropped on palette -> Delete block
    } else if (t?.type === 'slot') {
      const { owner, name } = t.slot._slot;
      owner.i[name] = d.blocks[0];
    } else if (t?.type === 'list') {
      t.list.splice(t.index, 0, ...d.blocks);
    } else {
      this.ws.scripts.push({
        x: Math.round(Math.max(0, r.left - c.left)),
        y: Math.round(Math.max(0, r.top - c.top)),
        blocks: d.blocks,
      });
    }
    this.renderAll();
    this.changed();
  }

  onContext(e) {
    const node = e.target.closest('.block');
    if (!node) return;
    e.preventDefault();
    const m = this.ctxMenu;
    m.replaceChildren();
    const add = (label, fn) => {
      const b = el('button', '', label);
      b.addEventListener('click', () => { m.hidden = true; fn(); });
      m.append(b);
    };
    add('Duplicate', () => this.duplicate(node));
    add('Delete block', () => this.deleteBlock(node));
    m.style.left = `${e.clientX}px`;
    m.style.top = `${e.clientY}px`;
    m.hidden = false;
  }

  duplicate(node) {
    let blocks;
    if (node._loc) blocks = clone(node._loc.list.slice(node._loc.index));
    else if (node._slotRef) blocks = [clone(node._block)];
    else return;
    const r = node.getBoundingClientRect();
    const c = this.canvasEl.getBoundingClientRect();
    this.ws.scripts.push({ x: Math.round(r.left - c.left + 24), y: Math.round(r.top - c.top + 24), blocks });
    this.renderAll();
    this.changed();
  }

  deleteBlock(node) {
    if (node._loc) {
      const { list, index } = node._loc;
      list.splice(index, 1);
      if (list.length === 0) this.ws.scripts = this.ws.scripts.filter(s => s.blocks !== list);
    } else if (node._slotRef) {
      delete node._slotRef.owner.i[node._slotRef.name];
    }
    this.renderAll();
    this.changed();
  }

  async makeVariable() {
    const name = await promptDialog('Variable name', { title: 'Make a variable', confirmText: 'Make variable', maxLength: 40 });
    if (!name) return;
    if (!this.ws.variables.includes(name)) this.ws.variables.push(name);
    this.renderAll();
    this.changed();
  }

  async makeLabel() {
    let name = await promptDialog('Label name', { title: 'Make a label', value: 'my_label', confirmText: 'Make label', maxLength: 40 });
    if (!name) return;
    const taken = new Set(this.labelNames());
    for (let base = name, k = 2; taken.has(name); k++) name = `${base}_${k}`;
    this.ws.scripts.push({ x: 24, y: 24, blocks: [newBlock('label_def', { name })] });
    this.renderAll();
    this.changed();
  }

  renderCats() {
    this.catsEl.replaceChildren();
    for (const c of CATEGORIES) {
      if (!c) continue; // Safety check
      const b = el('button', `cat${c.id === this.cat ? ' active' : ''}`);
      b.style.setProperty('--c', c.color);
      b.style.setProperty('--cd', shade(c.color, -0.25));
      b.append(el('span', 'dot'), el('span', 'name', c.label));
      b.addEventListener('click', () => {
        this.cat = c.id;
        this.renderCats();
        this.renderPalette(true);
      });
      this.catsEl.append(b);
    }
  }

  renderAll() {
    this.canvasEl.replaceChildren();
    for (const s of this.ws.scripts) {
      const node = el('div', 'script');
      node.style.left = `${s.x}px`;
      node.style.top = `${s.y}px`;
      node._script = s;
      node.append(this.renderList(s.blocks));
      this.canvasEl.append(node);
    }
    this.canvasEl.append(this.marker);
    this.renderPalette();
  }

  renderList(list) {
    const L = el('div', 'list');
    L._list = list;
    list.forEach((b, index) => {
      const n = this.renderBlock(b);
      n._loc = { list, index };
      L.append(n);
    });
    return L;
  }

  renderBlock(b, palette = false) {
    const def = BLOCKS[b.type];
    // Safe lookup fallback:
    const cat = CATEGORIES.find(c => c.id === def?.cat) || CATEGORIES[0] || { color: '#888888', label: 'Other' };
    const node = el('div', `block ${def.shape}`);
    node.style.setProperty('--c', cat.color);
    node.style.setProperty('--cd', shade(cat.color, -0.25));
    node._block = b;
    const row = el('div', 'row');
    for (const tok of def.spec) row.append(this.renderToken(tok, b, palette));
    node.append(row);
    return node;
  }

  renderToken(tok, b, palette) {
    if (typeof tok === 'string') return el('span', 'lbl', tok);
    if (tok.i) return this.renderSlot(tok, b, palette);
    if (tok.k === 'cond') return this.select(b, tok.t, tok.opts.map(o => o.label));
    if (tok.k === 'reg') return this.select(b, tok.t, REGISTERS);
    if (tok.k === 'size') return this.select(b, tok.t, DATA_SIZES.map(s => s.label));
    if (tok.k === 'var') return this.select(b, tok.t, this.ws.variables);
    if (tok.k === 'label') return this.select(b, tok.t, this.labelNames());
    if (tok.k === 'varname') return el('span', 'lbl', b.f[tok.t]);
    if (tok.k === 'labelname') {
      const inp = this.textInput(b, tok.t, 'name');
      inp.addEventListener('change', () => { this.renderAll(); this.changed(); });
      return inp;
    }
    if (tok.k === 'code') return this.textInput(b, tok.t, 'code');
    return this.textInput(b, tok.t, 'text');
  }

  renderSlot(tok, b, palette) {
    const s = el('span', `slot ${tok.k}`);
    s._slot = { owner: b, name: tok.i, kind: tok.k };
    const occupant = b.i[tok.i];
    if (occupant) {
      s.classList.add('filled');
      const n = this.renderBlock(occupant, palette);
      n._slotRef = { owner: b, name: tok.i };
      s.append(n);
    } else if (tok.k === 'num') {
      s.append(this.textInput(b, tok.i, 'num'));
    }
    return s;
  }

  textInput(b, name, kind) {
    const inp = el('input', `field ${kind}`);
    inp.type = 'text';
    inp.spellcheck = false;
    inp.value = b.f[name] ?? '';
    inp.style.width = `${Math.max(2, inp.value.length + 1)}ch`;
    inp.addEventListener('input', () => {
      b.f[name] = inp.value;
      inp.style.width = `${Math.max(2, inp.value.length + 1)}ch`;
      this.changed();
    });
    return inp;
  }

  select(b, name, options) {
    const sel = el('select', 'field sel');
    const current = String(b.f[name] ?? '');
    const list = options.includes(current) || !current ? options : [...options, current];
    if (!list.length) sel.append(new Option('(none)', ''));
    for (const o of list) sel.append(new Option(o, o));
    if (!current && list.length) b.f[name] = list[0];
    sel.value = String(b.f[name] ?? '');
    sel.addEventListener('change', () => { b.f[name] = sel.value; this.changed(); });
    return sel;
  }

  paletteItems() {
    const v0 = this.ws.variables[0] ?? '';
    const of = (...types) => types.map((type) => ({ type }));
    switch (this.cat) {
      case 'sections': return of('section_data', 'define_data', 'section_rodata', 'section_bss', 'reserve_bss', 'section_text');
      case 'registers': return of('reg_val', 'mem_ref', 'imm_val');
      case 'instructions': return of('mov', 'lea', 'add', 'sub', 'xor', 'and', 'or', 'cmp', 'push', 'pop', 'nop');
      case 'control': return of('start', 'jmp', 'jcc', 'cmov', 'call', 'ret');
      case 'variables': return [
        { button: 'Make a Variable', action: () => this.makeVariable() },
        ...this.ws.variables.map((name) => ({ type: 'var', over: { name }, removable: name })),
        { type: 'set', over: { var: v0 } },
      ];
      case 'labels': return [
        { button: 'Make a Label', action: () => this.makeLabel() },
        { type: 'label_def', over: () => ({ name: 'my_label' }) },
        ...this.labelNames().map((name) => ({ type: 'call', over: { label: name } })),
      ];
      case 'output': return of('syscall', 'sys_exit');
      case 'asm': return of('asm', 'comment');
      default: return [];
    }
  }

  renderPalette(force = false) {
    const sig = [this.cat, this.ws.variables.join('\u0001'), this.labelNames().join('\u0001')].join('|');
    if (!force && sig === this.paletteSig) return;
    this.paletteSig = sig;
    this.paletteEl.replaceChildren();

    // Safe lookup fallback:
    const cat = CATEGORIES.find(c => c.id === this.cat) || CATEGORIES[0];
    if (!cat) return;

    const title = el('h3', 'pal-title', cat.label);
    title.style.setProperty('--c', cat.color);
    this.paletteEl.append(title);

    for (const it of this.paletteItems()) {
      if (it.button) {
        const b = el('button', 'pbtn', it.button);
        b.addEventListener('click', it.action);
        this.paletteEl.append(b);
      } else {
        const make = () => newBlock(it.type, typeof it.over === 'function' ? it.over() : it.over);
        const node = this.renderBlock(make(), true);
        node._factory = make;
        const row = el('div', 'pal-item');
        row.append(node);
        if (it.removable) {
          const x = el('button', 'pal-del', '\u00d7');
          x.title = `Delete variable "${it.removable}"`;
          x.addEventListener('click', () => {
            this.ws.variables = this.ws.variables.filter((v) => v !== it.removable);
            this.renderAll();
            this.changed();
          });
          row.append(x);
        }
        this.paletteEl.append(row);
      }
    }
  }
}