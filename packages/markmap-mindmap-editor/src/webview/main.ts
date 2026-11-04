import { select, zoomTransform } from 'd3';
import { INode, loadCSS, loadJS } from 'markmap-common';
import { Transformer } from 'markmap-lib';
import { Markmap, deriveOptions, simpleHash } from 'markmap-view';
import {
  DropPosition,
  MDoc,
  MNode,
  addChild,
  addSibling,
  cloneTree,
  findById,
  indent,
  insertNodes,
  insertParent,
  isAncestor,
  moveSibling,
  moveTo,
  outdent,
  parse,
  parseFragment,
  reconcile,
  remove,
  removeKeepChildren,
  serialize,
  subtreeToMarkdown,
  walk,
} from '../model';
import './style.css';

/* ------------------------------------------------------------------------ */
/* Host bridge                                                               */
/* ------------------------------------------------------------------------ */

interface Host {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): Host;

const host: Host =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : {
        // Standalone mode, used for local testing in a browser.
        postMessage(msg: any) {
          (window as any).__mmMessages ||= [];
          (window as any).__mmMessages.push(msg);
          if (msg.type === 'ready') {
            const text = (window as any).__mmInitialText ?? '# Mindmap\n';
            setTimeout(() => onHostMessage({ type: 'update', text }));
          }
        },
      };

/* ------------------------------------------------------------------------ */
/* DOM                                                                       */
/* ------------------------------------------------------------------------ */

const app = document.getElementById('app') || document.body;
app.innerHTML = `
<svg class="mm-svg"></svg>
<div class="mm-toolbar">
  <button data-cmd="addChild" title="Add child (Tab)">＋ Child</button>
  <button data-cmd="addSibling" title="Add sibling (Enter)">＋ Sibling</button>
  <button data-cmd="delete" title="Delete (Delete)">✕</button>
  <span class="mm-sep"></span>
  <button data-cmd="expandAll" title="Expand all (Alt+0)">Expand all</button>
  <button data-cmd="collapseAll" title="Collapse all (Alt+1)">Collapse all</button>
  <button data-cmd="level2" title="Show 2 levels (Alt+2)">L2</button>
  <button data-cmd="level3" title="Show 3 levels (Alt+3)">L3</button>
  <span class="mm-sep"></span>
  <button data-cmd="zoomIn" title="Zoom in (Ctrl+=)">＋</button>
  <button data-cmd="zoomOut" title="Zoom out (Ctrl+-)">－</button>
  <button data-cmd="fit" title="Fit to window (Ctrl+0)">Fit</button>
  <span class="mm-sep"></span>
  <button data-cmd="openText" title="Open the Markdown source beside">Markdown</button>
  <button data-cmd="help" title="Keyboard shortcuts (F1 / ?)">?</button>
</div>
<div class="mm-help" hidden>
  <h3>Keyboard shortcuts</h3>
  <table>
    <tr><td>Enter</td><td>Add sibling after (on root: add child)</td></tr>
    <tr><td>Shift+Enter</td><td>Add sibling before</td></tr>
    <tr><td>Tab / Insert</td><td>Add child</td></tr>
    <tr><td>Ctrl+Enter</td><td>Insert parent</td></tr>
    <tr><td>F2 / Space / double click / just type</td><td>Edit text</td></tr>
    <tr><td>Enter / Esc (while editing)</td><td>Finish / cancel editing</td></tr>
    <tr><td>Tab (while editing)</td><td>Finish and add child</td></tr>
    <tr><td>Delete / Backspace</td><td>Delete node with its children</td></tr>
    <tr><td>Ctrl+Delete</td><td>Delete node, keep its children</td></tr>
    <tr><td>Arrow keys</td><td>Select parent / child / sibling</td></tr>
    <tr><td>Home</td><td>Select root</td></tr>
    <tr><td>Alt+↑ / Alt+↓</td><td>Move up / down</td></tr>
    <tr><td>Alt+→ / Shift+Tab, Alt+←</td><td>Indent / outdent</td></tr>
    <tr><td>Drag a node</td><td>Drop on a node: child; on its top/bottom edge: sibling</td></tr>
    <tr><td>Ctrl+/</td><td>Collapse / expand node</td></tr>
    <tr><td>Ctrl+Shift+/</td><td>Collapse / expand node recursively</td></tr>
    <tr><td>Alt+0</td><td>Expand all</td></tr>
    <tr><td>Alt+1 … Alt+9</td><td>Show N levels</td></tr>
    <tr><td>Ctrl+C / Ctrl+X / Ctrl+V</td><td>Copy / cut / paste (as child) — Markdown list text</td></tr>
    <tr><td>Ctrl+D</td><td>Duplicate</td></tr>
    <tr><td>Ctrl+Z / Ctrl+Y</td><td>Undo / redo (VS Code)</td></tr>
    <tr><td>Ctrl+= / Ctrl+- / Ctrl+0</td><td>Zoom in / out / fit</td></tr>
    <tr><td>Ctrl+click link</td><td>Open link</td></tr>
  </table>
  <p>Click anywhere to close.</p>
</div>
<textarea class="mm-input" spellcheck="false" autocomplete="off"></textarea>
<div class="mm-status"></div>
`;

const svgEl = app.querySelector<SVGSVGElement>('.mm-svg')!;
const input = app.querySelector<HTMLTextAreaElement>('.mm-input')!;
const helpEl = app.querySelector<HTMLDivElement>('.mm-help')!;
const statusEl = app.querySelector<HTMLDivElement>('.mm-status')!;

const transformer = new Transformer();
const mm = Markmap.create(svgEl, { duration: 300 });
const baseOptions = { ...mm.options };

const layer = mm.g.insert('g', ':first-child').attr('class', 'mm-layer');
const selRect = layer
  .append('rect')
  .attr('class', 'mm-selection')
  .attr('rx', 4)
  .style('display', 'none');
const dropRect = layer
  .append('rect')
  .attr('class', 'mm-drop')
  .attr('rx', 4)
  .style('display', 'none');

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

let doc: MDoc = parse('');
let text = '';
let loaded = false;
let firstRender = true;
let selected: MNode | null = null;
/** Model id -> rendered markmap node */
let rendered = new Map<number, INode>();
let rootMid = 0;

interface EditState {
  node: MNode;
  isNew: boolean;
  original: string;
  multiline: boolean;
  /** Node to select when a new node is cancelled. */
  fallback: MNode | null;
}
let editing: EditState | null = null;
let composing = false;

/* ------------------------------------------------------------------------ */
/* Rendering                                                                 */
/* ------------------------------------------------------------------------ */

let renderSeq = 0;

async function render() {
  const seq = ++renderSeq;
  const result = transformer.transform(text);
  const { root, frontmatter, features } = result;

  const { styles, scripts } = transformer.getUsedAssets(features);
  if (styles) loadCSS(styles);
  if (scripts) loadJS(scripts);

  const jsonOptions = (frontmatter as any)?.markmap || {};
  const derived = deriveOptions(jsonOptions);
  const initialExpandLevel = derived.initialExpandLevel ?? -1;

  const byLine = new Map<number, MNode>();
  walk(doc.root, (node) => {
    if (node.line >= 0) byLine.set(node.line, node);
  });

  const nextRendered = new Map<number, INode>();
  let id = 0;
  const init = (
    item: INode,
    parent: INode | null,
    depth: number,
    index: number,
    foldAll: boolean,
  ) => {
    id += 1;
    const lines = item.payload?.lines as string | undefined;
    let m = lines != null ? byLine.get(parseInt(`${lines}`, 10)) : undefined;
    if (!parent && !m) m = doc.root;
    item.state = {
      ...item.state,
      depth,
      id,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      size: [0, 0],
    } as INode['state'];
    const ident = m ? `m${m.id}` : `${parent?.state.key || ''}_u${index}`;
    item.state.key = `${ident}:${simpleHash(item.content)}`;
    item.state.path = parent
      ? `${parent.state.path}.${m ? `m${m.id}` : `u${id}`}`
      : 'r';
    const fold = item.payload?.fold;
    const childFoldAll = foldAll || fold === 2;
    if (m) {
      if (m.fold === undefined) {
        m.fold =
          !!fold ||
          foldAll ||
          (firstRender &&
            initialExpandLevel >= 0 &&
            depth >= initialExpandLevel);
      }
      item.payload = {
        ...item.payload,
        mid: m.id,
        fold: m.fold && item.children?.length ? 1 : 0,
      };
      nextRendered.set(m.id, item);
    }
    item.children?.forEach((child, i) =>
      init(child, item, depth + 1, i, childFoldAll),
    );
  };
  init(root as INode, null, 1, 0, false);
  rendered = nextRendered;
  rootMid = (root as INode).payload?.mid as number;

  mm.options = {
    ...baseOptions,
    ...derived,
    initialExpandLevel: -1,
    autoFit: false,
    duration: derived.duration ?? 300,
  };
  mm.setOptions();
  mm.state.data = root as INode;
  mm.updateStyle();
  await mm.renderData();
  if (seq !== renderSeq) return;
  if (firstRender) {
    firstRender = false;
    await mm.fit();
  }
  if (selected && !findById(doc, selected.id)) selected = null;
  updateSelection();
}

function getINode(node: MNode | null | undefined) {
  return node ? rendered.get(node.id) : undefined;
}

function isShown(node: MNode) {
  if (!rendered.has(node.id)) return false;
  for (let p = node.parent; p && p.id !== rootMid; p = p.parent) {
    if (p.fold) return false;
  }
  return true;
}

function getRootNode() {
  return findById(doc, rootMid) || doc.root;
}

function updateSelection() {
  const inode = getINode(selected);
  if (!inode || !selected || !isShown(selected)) {
    selRect.style('display', 'none');
  } else {
    const { x, y, width, height } = inode.state.rect;
    const pad = 4;
    selRect
      .style('display', null)
      .transition()
      .duration(mm.options.duration)
      .attr('x', x - pad)
      .attr('y', y - pad)
      .attr('width', width + pad * 2)
      .attr('height', height + pad * 2);
  }
  positionInput();
  updateToolbar();
}

function updateToolbar() {
  const has = !!selected;
  app
    .querySelectorAll<HTMLButtonElement>(
      '[data-cmd=addChild],[data-cmd=addSibling],[data-cmd=delete]',
    )
    .forEach((btn) => (btn.disabled = !has));
}

let statusTimer = 0;
function showStatus(message: string) {
  statusEl.textContent = message;
  statusEl.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(
    () => statusEl.classList.remove('show'),
    2000,
  );
}

/* ------------------------------------------------------------------------ */
/* Document updates                                                          */
/* ------------------------------------------------------------------------ */

/** Serialize the model, render it and optionally push it to VS Code. */
async function commit(sync = true) {
  text = serialize(doc);
  if (sync) host.postMessage({ type: 'edit', text });
  await render();
}

function onHostMessage(msg: any) {
  if (msg?.type !== 'update') return;
  if (loaded && msg.text === text) return;
  if (editing) finishEdit(false);
  const newDoc = parse(msg.text);
  if (loaded) reconcile(doc, newDoc);
  doc = newDoc;
  text = msg.text;
  selected = selected ? findById(doc, selected.id) || null : null;
  if (!loaded) {
    loaded = true;
    walk(doc.root, (n) => {
      n.fold = undefined;
    });
  }
  render().then(() => {
    if (!selected) {
      selected = getRootNode();
      updateSelection();
    }
    focusInput();
  });
}

window.addEventListener('message', (e) => onHostMessage(e.data));
transformer.hooks.retransform.tap(() => {
  render();
});

/* ------------------------------------------------------------------------ */
/* Selection & navigation                                                    */
/* ------------------------------------------------------------------------ */

function selectNode(node: MNode | null, reveal = true) {
  selected = node;
  updateSelection();
  const inode = getINode(node);
  if (reveal && inode) {
    mm.ensureVisible(inode, { left: 40, right: 40, top: 60, bottom: 40 });
  }
}

function shownChildren(node: MNode) {
  return node.children.filter((c) => rendered.has(c.id));
}

function centerOf(node: MNode) {
  const r = getINode(node)!.state.rect;
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, r };
}

function navigate(dir: 'up' | 'down' | 'left' | 'right') {
  if (!selected || !rendered.has(selected.id)) {
    selectNode(getRootNode());
    return;
  }
  const cur = selected;
  if (dir === 'left') {
    if (cur.id !== rootMid && cur.parent && rendered.has(cur.parent.id)) {
      selectNode(cur.parent);
    }
    return;
  }
  if (dir === 'right') {
    const children = shownChildren(cur);
    if (!children.length) return;
    if (cur.fold) {
      setFold(cur, false);
    }
    const c = centerOf(cur);
    const best = children.reduce((a, b) =>
      Math.abs(centerOf(a).y - c.y) <= Math.abs(centerOf(b).y - c.y) ? a : b,
    );
    selectNode(best);
    return;
  }
  // up / down: siblings first, then the geometrically nearest node.
  const delta = dir === 'up' ? -1 : 1;
  if (cur.parent && cur.id !== rootMid) {
    const siblings = shownChildren(cur.parent);
    const sib = siblings[siblings.indexOf(cur) + delta];
    if (sib) {
      selectNode(sib);
      return;
    }
  }
  const c = centerOf(cur);
  let best: MNode | null = null;
  let bestScore = Infinity;
  walk(doc.root, (n) => {
    if (n === cur || !isShown(n)) return;
    const o = centerOf(n);
    const dy = (o.y - c.y) * delta;
    if (dy <= 1) return;
    const score = dy + Math.abs(o.r.x - c.r.x) * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  });
  if (best) selectNode(best);
}

/* ------------------------------------------------------------------------ */
/* Folding                                                                   */
/* ------------------------------------------------------------------------ */

async function refreshFolds() {
  walk(doc.root, (n) => {
    const inode = rendered.get(n.id);
    if (inode) {
      inode.payload = {
        ...inode.payload,
        fold: n.fold && inode.children?.length ? 1 : 0,
      };
    }
  });
  await mm.renderData();
  updateSelection();
}

function setFold(node: MNode, fold: boolean, recursive = false) {
  if (recursive) {
    walk(node, (n) => {
      n.fold = fold;
    });
  } else {
    node.fold = fold;
  }
  return refreshFolds();
}

function toggleFold(node: MNode, recursive = false) {
  if (!shownChildren(node).length) return;
  return setFold(node, !node.fold, recursive);
}

function showLevels(level: number) {
  const root = getRootNode();
  const visit = (n: MNode, depth: number) => {
    n.fold = level > 0 && depth >= level;
    n.children.forEach((c) => visit(c, depth + 1));
  };
  visit(root, 1);
  if (selected && !isShown(selected)) {
    let s: MNode | null = selected;
    while (s && !isShown(s)) s = s.parent;
    selected = s;
  }
  return refreshFolds().then(() => mm.fit());
}

mm.handleClick = (e: MouseEvent, d: INode) => {
  const node = findById(doc, d.payload?.mid as number);
  if (!node) return;
  toggleFold(node, e.ctrlKey || e.metaKey);
};

/* ------------------------------------------------------------------------ */
/* Editing                                                                   */
/* ------------------------------------------------------------------------ */

function focusInput() {
  if (document.activeElement !== input) input.focus({ preventScroll: true });
}

function positionInput() {
  const target = editing ? editing.node : selected;
  // A node may not be rendered (yet, or hidden by markmap): anchor the input
  // next to the closest rendered ancestor instead.
  let anchor = target;
  while (anchor && !(rendered.has(anchor.id) && isShown(anchor))) {
    anchor = anchor.parent;
  }
  const inode = getINode(anchor);
  const svgRect = svgEl.getBoundingClientRect();
  const t = zoomTransform(svgEl);
  if (!inode) {
    input.style.left = `${svgRect.left + 10}px`;
    input.style.top = `${svgRect.top + 50}px`;
    return;
  }
  const { rect } = inode.state;
  const { paddingX } = mm.options;
  const offset =
    anchor === target ? 0 : rect.width + mm.options.spacingHorizontal / 2;
  const left = svgRect.left + t.x + (rect.x + paddingX + offset) * t.k;
  const top = svgRect.top + t.y + rect.y * t.k;
  input.style.left = `${left}px`;
  input.style.top = `${top}px`;
  input.style.transform = `scale(${t.k})`;
  if (editing) {
    autosize(anchor === target ? rect.width - paddingX * 2 : 0, rect.height);
  }
}

function autosize(minWidth = 0, minHeight = 0) {
  input.style.width = '0px';
  input.style.height = '0px';
  const width = Math.max(minWidth, 60, input.scrollWidth + 12);
  input.style.width = `${Math.min(width, 800)}px`;
  input.style.height = `${Math.max(minHeight, input.scrollHeight)}px`;
}

mm.zoom.on('zoom.mmEditor', () => {
  positionInput();
});

function startEdit(
  node: MNode,
  opts: { isNew?: boolean; replace?: boolean; fallback?: MNode | null } = {},
) {
  if (node.kind === 'root') {
    showStatus('The root title comes from the frontmatter `title`.');
    return;
  }
  const multiline = node.kind === 'block';
  editing = {
    node,
    isNew: !!opts.isNew,
    original: node.text,
    multiline,
    fallback: opts.fallback ?? null,
  };
  selected = node;
  input.classList.add('editing');
  input.classList.toggle('multiline', multiline);
  if (!opts.replace) {
    input.value = node.text;
    input.setSelectionRange(input.value.length, input.value.length);
  }
  app.classList.add('is-editing');
  updateSelection();
  focusInput();
}

async function finishEdit(save = true, then?: 'child' | 'sibling') {
  const state = editing;
  if (!state) return;
  editing = null;
  const value = state.multiline
    ? input.value.replace(/\s+$/, '')
    : input.value.replace(/\s*\n\s*/g, ' ').trim();
  input.value = '';
  input.classList.remove('editing', 'multiline');
  input.style.width = '';
  input.style.height = '';
  app.classList.remove('is-editing');
  const { node } = state;

  if (state.isNew && (!save || !value)) {
    remove(node);
    selected = state.fallback;
    await commit(false);
    focusInput();
    return;
  }
  const changed = save && value !== state.original;
  if (changed) node.text = value;
  if (then) {
    // Chain the next node immediately; it renders everything at once.
    if (changed || state.isNew) {
      text = serialize(doc);
      host.postMessage({ type: 'edit', text });
    }
    focusInput();
    await runCommand(then === 'child' ? 'addChild' : 'addSibling');
    return;
  }
  if (changed || state.isNew) {
    await commit();
  } else {
    updateSelection();
  }
  focusInput();
}

async function createAndEdit(make: () => MNode | null, fallback: MNode | null) {
  const node = make();
  if (!node) return;
  selected = node;
  // Enter edit mode right away so that fast typing is not lost while the
  // map is re-rendered.
  startEdit(node, { isNew: true, fallback });
  await commit(false);
  if (editing?.node !== node) return;
  positionInput();
  const inode = getINode(node);
  if (inode)
    mm.ensureVisible(inode, { left: 40, right: 160, top: 60, bottom: 40 });
}

input.addEventListener('compositionstart', () => {
  composing = true;
  if (!editing && selected && selected.kind !== 'root') {
    startEdit(selected, { replace: true });
  }
});
input.addEventListener('compositionend', () => {
  composing = false;
  if (editing) autosize();
});

input.addEventListener('input', () => {
  if (!editing) {
    if (!selected || selected.kind === 'root' || !input.value) {
      input.value = '';
      return;
    }
    // Typing on a selected node replaces its text, like XMind.
    startEdit(selected, { replace: true });
  }
  positionInput();
});

input.addEventListener('blur', () => {
  // Commit when focus leaves the editor (e.g. clicking elsewhere).
  setTimeout(() => {
    if (editing && document.activeElement !== input) finishEdit(true);
  });
});

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

const visible = (n: MNode) => rendered.has(n.id);

async function structural(fn: () => boolean | void, keep = selected) {
  if (fn() === false) return;
  selected = keep;
  await commit();
  selectNode(selected);
}

async function runCommand(cmd: string) {
  const node = selected;
  const isRoot = !node || node.id === rootMid || node.kind === 'root';
  switch (cmd) {
    case 'addChild': {
      const parent = node || getRootNode();
      if (parent.kind === 'block') return;
      await createAndEdit(() => addChild(doc, parent), parent);
      break;
    }
    case 'addSibling':
    case 'addSiblingBefore': {
      if (!node) return;
      if (isRoot) return runCommand('addChild');
      await createAndEdit(
        () => addSibling(doc, node, cmd === 'addSiblingBefore'),
        node,
      );
      break;
    }
    case 'insertParent': {
      if (!node || isRoot) return;
      await createAndEdit(() => insertParent(doc, node), node);
      break;
    }
    case 'delete':
    case 'deleteKeepChildren': {
      if (!node || isRoot) return;
      const parent = node.parent!;
      const siblings = shownChildren(parent);
      const i = siblings.indexOf(node);
      const next = siblings[i + 1] || siblings[i - 1] || parent;
      if (cmd === 'delete') remove(node);
      else removeKeepChildren(node);
      await structural(() => true, next);
      break;
    }
    case 'moveUp':
    case 'moveDown':
      if (!node || isRoot) return;
      await structural(() =>
        moveSibling(doc, node, cmd === 'moveUp' ? -1 : 1, visible),
      );
      break;
    case 'indent':
      if (!node || isRoot) return;
      await structural(() => indent(doc, node, visible));
      break;
    case 'outdent':
      if (!node || isRoot || node.parent?.id === rootMid) return;
      await structural(() => outdent(doc, node));
      break;
    case 'duplicate': {
      if (!node || isRoot) return;
      const copy = cloneTree(node);
      const parent = node.parent!;
      insertNodes(doc, parent, [copy], parent.children.indexOf(node) + 1);
      await structural(() => true, copy);
      break;
    }
    case 'edit':
      if (node) startEdit(node);
      break;
    case 'toggle':
      if (node) await toggleFold(node);
      break;
    case 'toggleRecursive':
      if (node) await setFold(node, !node.fold, true);
      break;
    case 'expandAll':
      await showLevels(0);
      break;
    case 'collapseAll':
      await showLevels(1);
      break;
    case 'level2':
      await showLevels(2);
      break;
    case 'level3':
      await showLevels(3);
      break;
    case 'zoomIn':
      await mm.rescale(1.25);
      break;
    case 'zoomOut':
      await mm.rescale(0.8);
      break;
    case 'fit':
      await mm.fit();
      break;
    case 'openText':
      host.postMessage({ type: 'openText' });
      break;
    case 'help':
      helpEl.hidden = !helpEl.hidden;
      break;
  }
  if (!editing) focusInput();
}

app.querySelector('.mm-toolbar')!.addEventListener('mousedown', (e) => {
  // Keep focus in the editor input.
  e.preventDefault();
});
app.querySelector('.mm-toolbar')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
    'button[data-cmd]',
  );
  if (btn) runCommand(btn.dataset.cmd!);
});
helpEl.addEventListener('click', () => {
  helpEl.hidden = true;
  focusInput();
});

/* ------------------------------------------------------------------------ */
/* Keyboard                                                                  */
/* ------------------------------------------------------------------------ */

function handleEditKey(e: KeyboardEvent) {
  const state = editing!;
  // Keep native text editing (undo, copy, paste...) inside the input.
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    finishEdit(false);
  } else if (e.key === 'Enter') {
    if (state.multiline && !(e.ctrlKey || e.metaKey)) return;
    if (!state.multiline && e.shiftKey) return; // ignore, keep single line
    e.preventDefault();
    finishEdit(true);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    finishEdit(true, e.shiftKey ? undefined : 'child');
  }
}

function handleCommandKey(e: KeyboardEvent) {
  const ctrl = e.ctrlKey || e.metaKey;
  const { key, code, shiftKey: shift, altKey: alt } = e;
  let cmd: string | undefined;
  if (key === 'Enter' && ctrl) cmd = 'insertParent';
  else if (key === 'Enter') cmd = shift ? 'addSiblingBefore' : 'addSibling';
  else if (key === 'Tab') cmd = shift ? 'outdent' : 'addChild';
  else if (key === 'Insert') cmd = 'addChild';
  else if (key === 'F2' || (key === ' ' && !ctrl && !alt)) cmd = 'edit';
  else if ((key === 'Delete' || key === 'Backspace') && ctrl)
    cmd = 'deleteKeepChildren';
  else if (key === 'Delete' || key === 'Backspace') cmd = 'delete';
  else if (alt && key === 'ArrowUp') cmd = 'moveUp';
  else if (alt && key === 'ArrowDown') cmd = 'moveDown';
  else if (alt && key === 'ArrowRight') cmd = 'indent';
  else if (alt && key === 'ArrowLeft') cmd = 'outdent';
  else if (key.startsWith('Arrow') && !ctrl) {
    e.preventDefault();
    e.stopPropagation();
    navigate(key.slice(5).toLowerCase() as 'up');
    return;
  } else if (key === 'Home') {
    e.preventDefault();
    e.stopPropagation();
    selectNode(getRootNode());
    return;
  } else if (key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    helpEl.hidden = true;
    return;
  } else if (ctrl && code === 'Slash')
    cmd = shift ? 'toggleRecursive' : 'toggle';
  else if (alt && !ctrl && /^Digit\d$/.test(code)) {
    e.preventDefault();
    e.stopPropagation();
    showLevels(+code.slice(5));
    return;
  } else if (ctrl && (key === '=' || key === '+')) cmd = 'zoomIn';
  else if (ctrl && key === '-') cmd = 'zoomOut';
  else if (ctrl && key === '0') cmd = 'fit';
  else if (ctrl && key.toLowerCase() === 'd') cmd = 'duplicate';
  else if (key === 'F1' || (key === '?' && !ctrl)) cmd = 'help';
  if (!cmd) return;
  e.preventDefault();
  e.stopPropagation();
  runCommand(cmd);
}

input.addEventListener('keydown', (e) => {
  if (composing || e.isComposing || e.keyCode === 229) {
    e.stopPropagation();
    return;
  }
  if (editing) handleEditKey(e);
  else handleCommandKey(e);
});

/* ------------------------------------------------------------------------ */
/* Clipboard                                                                 */
/* ------------------------------------------------------------------------ */

function copySelected(e: ClipboardEvent) {
  if (!selected || selected.kind === 'root') return false;
  e.clipboardData?.setData('text/plain', subtreeToMarkdown([selected]));
  e.preventDefault();
  return true;
}

document.addEventListener('copy', (e) => {
  if (editing) return;
  copySelected(e);
});

document.addEventListener('cut', (e) => {
  if (editing) return;
  if (copySelected(e) && selected && selected.id !== rootMid) {
    runCommand('delete');
  }
});

document.addEventListener('paste', (e) => {
  if (editing) return;
  e.preventDefault();
  const data = e.clipboardData?.getData('text/plain') || '';
  const nodes = parseFragment(data);
  if (!nodes.length) return;
  const parent =
    selected && selected.kind !== 'block' ? selected : getRootNode();
  insertNodes(doc, parent, nodes);
  structural(() => true, nodes[0]);
});

/* ------------------------------------------------------------------------ */
/* Mouse: select, edit, links, drag & drop                                   */
/* ------------------------------------------------------------------------ */

function nodeFromEvent(e: Event): MNode | null {
  const g = (e.target as Element).closest?.('g.markmap-node') as
    | (SVGGElement & { __data__?: INode })
    | null;
  const mid = g?.__data__?.payload?.mid as number | undefined;
  if (mid != null) return findById(doc, mid) || null;
  // Nodes that are not part of the model (e.g. nested blocks): pick the
  // closest mapped ancestor.
  const d = g?.__data__;
  if (!d) return null;
  const path = d.state.path.split('.');
  while (path.length) {
    const seg = path.pop()!;
    if (seg.startsWith('m')) return findById(doc, +seg.slice(1)) || null;
  }
  return null;
}

let suppressClick = false;

svgEl.addEventListener(
  'click',
  (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const link = (e.target as Element).closest?.('a');
    if (link) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        host.postMessage({ type: 'openLink', href: link.getAttribute('href') });
        return;
      }
    }
    if (editing) return;
    const node = nodeFromEvent(e);
    if ((e.target as Element).closest('circle')) return;
    selectNode(node, false);
    focusInput();
  },
  true,
);

svgEl.addEventListener(
  'dblclick',
  (e) => {
    const node = nodeFromEvent(e);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    startEdit(node);
  },
  true,
);

interface DragState {
  node: MNode;
  x: number;
  y: number;
  active: boolean;
  ghost?: HTMLDivElement;
  target?: { node: MNode; position: DropPosition };
}
let drag: DragState | null = null;

svgEl.addEventListener(
  'mousedown',
  (e) => {
    if (e.button !== 0 || editing) return;
    if ((e.target as Element).closest('circle')) return;
    const node = nodeFromEvent(e);
    if (!node || node.id === rootMid || node.kind === 'root') return;
    drag = { node, x: e.clientX, y: e.clientY, active: false };
  },
  true,
);

function hitTest(clientX: number, clientY: number, exclude: MNode) {
  const svgRect = svgEl.getBoundingClientRect();
  const t = zoomTransform(svgEl);
  const x = (clientX - svgRect.left - t.x) / t.k;
  const y = (clientY - svgRect.top - t.y) / t.k;
  let hit: { node: MNode; position: DropPosition } | undefined;
  walk(doc.root, (n) => {
    if (hit || !isShown(n) || isAncestor(exclude, n)) return;
    const { rect } = getINode(n)!.state;
    const pad = 6;
    if (
      x < rect.x - pad ||
      x > rect.x + rect.width + pad ||
      y < rect.y - pad ||
      y > rect.y + rect.height + pad
    ) {
      return;
    }
    const ratio = (y - rect.y + pad) / (rect.height + pad * 2);
    let position: DropPosition = 'child';
    if (n.id !== rootMid && n.kind !== 'root') {
      if (ratio < 0.3) position = 'before';
      else if (ratio > 0.7) position = 'after';
    }
    if (position === 'child' && n.kind === 'block') position = 'after';
    hit = { node: n, position };
  });
  return hit;
}

window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    drag.active = true;
    const ghost = document.createElement('div');
    ghost.className = 'mm-ghost';
    ghost.textContent = drag.node.text || '(empty)';
    document.body.append(ghost);
    drag.ghost = ghost;
    app.classList.add('is-dragging');
  }
  drag.ghost!.style.left = `${e.clientX + 12}px`;
  drag.ghost!.style.top = `${e.clientY + 8}px`;
  drag.target = hitTest(e.clientX, e.clientY, drag.node);
  const target = drag.target;
  if (!target) {
    dropRect.style('display', 'none');
    return;
  }
  const { rect } = getINode(target.node)!.state;
  const pad = 4;
  if (target.position === 'child') {
    dropRect
      .style('display', null)
      .attr('class', 'mm-drop')
      .attr('x', rect.x - pad)
      .attr('y', rect.y - pad)
      .attr('width', rect.width + pad * 2)
      .attr('height', rect.height + pad * 2);
  } else {
    const y =
      target.position === 'before' ? rect.y - pad : rect.y + rect.height + pad;
    dropRect
      .style('display', null)
      .attr('class', 'mm-drop mm-drop-line')
      .attr('x', rect.x)
      .attr('y', y - 2)
      .attr('width', Math.max(rect.width, 40))
      .attr('height', 4);
  }
});

window.addEventListener('mouseup', () => {
  const state = drag;
  drag = null;
  if (!state?.active) return;
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
  state.ghost?.remove();
  app.classList.remove('is-dragging');
  dropRect.style('display', 'none');
  const target = state.target;
  if (!target) return;
  structural(
    () => moveTo(doc, state.node, target.node, target.position),
    state.node,
  );
});

// Clicking on the blank canvas keeps keyboard focus in the editor.
svgEl.addEventListener('mouseup', () => {
  if (!editing) setTimeout(focusInput);
});
window.addEventListener('focus', () => {
  if (!editing) focusInput();
});

select(window).on('resize.mmEditor', () => positionInput());

host.postMessage({ type: 'ready' });
