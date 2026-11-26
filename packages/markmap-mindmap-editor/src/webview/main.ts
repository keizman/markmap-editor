import { select, zoomTransform } from 'd3';
import { INode, loadCSS, loadJS } from 'markmap-common';
import { Transformer } from 'markmap-lib';
import { Markmap, deriveOptions, simpleHash } from 'markmap-view';
import {
  DropPosition,
  MARKERS,
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
  getEditText,
  setEditText,
  setMarker,
  splitMarker,
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

const MARK_NAMES = ['Red', 'Yellow', 'Green'];

const markButtons = (attr: string, title: (i: number) => string) =>
  MARKERS.map(
    (m, i) => `<button ${attr}="${attr === 'data-cmd' ? `mark${i + 1}` : m}"
      title="${title(i)}">${m}</button>`,
  ).join('');

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
<div class="mm-side">
  <div class="mm-row">
    <span class="mm-label">Mark</span>
    ${markButtons('data-cmd', (i) => `${MARK_NAMES[i]} marker (Ctrl+${i + 1}), click again to remove`)}
    <button data-cmd="markClear" title="Remove marker">⊘</button>
  </div>
  <div class="mm-row mm-search">
    <input class="mm-search-input" type="text" placeholder="Search (Ctrl+F)" spellcheck="false">
    ${markButtons('data-find', (i) => `Find ${MARK_NAMES[i].toLowerCase()} markers`)}
    <span class="mm-search-count"></span>
    <button data-cmd="searchPrev" title="Previous match (Shift+Enter / Shift+F3)">↑</button>
    <button data-cmd="searchNext" title="Next match (Enter / F3)">↓</button>
  </div>
</div>
<div class="mm-banner" hidden>Showing one branch only · <a href="#">Show all</a> (Esc / Ctrl+;)</div>
<div class="mm-help" hidden>
  <h3>Keyboard shortcuts</h3>
  <table>
    <tr><td>Enter</td><td>Add sibling after (on root: add child)</td></tr>
    <tr><td>Shift+Enter</td><td>Add sibling before</td></tr>
    <tr><td>Tab / Insert</td><td>Add child</td></tr>
    <tr><td>Ctrl+Enter</td><td>Insert parent</td></tr>
    <tr><td>F2 / Space / double click / just type</td><td>Edit text</td></tr>
    <tr><td>Enter / Esc (while editing)</td><td>Finish / cancel editing</td></tr>
    <tr><td>Shift+Enter (while editing)</td><td>New line inside the topic</td></tr>
    <tr><td>Tab (while editing)</td><td>Finish and add child</td></tr>
    <tr><td>Delete / Backspace</td><td>Delete topic with its children</td></tr>
    <tr><td>Ctrl+Delete / Ctrl+Backspace</td><td>Delete single topic (keep its children)</td></tr>
    <tr><td>Arrow keys</td><td>Select parent / child / sibling</td></tr>
    <tr><td>Home</td><td>Select root</td></tr>
    <tr><td>Ctrl/Shift+click, drag on blank area</td><td>Multi-select (box select)</td></tr>
    <tr><td>Ctrl+A</td><td>Select all</td></tr>
    <tr><td>Alt+↑ / Alt+↓</td><td>Move up / down</td></tr>
    <tr><td>Alt+→ / Shift+Tab, Alt+←</td><td>Indent / outdent</td></tr>
    <tr><td>Drag topics</td><td>Drop on a topic: child; on its top/bottom edge: sibling</td></tr>
    <tr><td>Right drag / wheel</td><td>Pan / zoom</td></tr>
    <tr><td>Right click / Shift+F10</td><td>Context menu</td></tr>
    <tr><td>Ctrl+/</td><td>Fold / unfold subtopics</td></tr>
    <tr><td>Ctrl+Alt+/</td><td>Fold / unfold all sub-branches</td></tr>
    <tr><td>Ctrl+Shift+/</td><td>Fold / unfold topic recursively</td></tr>
    <tr><td>Ctrl+;</td><td>Show branch only / show all</td></tr>
    <tr><td>Alt+0</td><td>Expand all</td></tr>
    <tr><td>Alt+1 … Alt+9</td><td>Show N levels</td></tr>
    <tr><td>Ctrl+1 / 2 / 3</td><td>Toggle 🔴 / 🟡 / 🟢 marker</td></tr>
    <tr><td>Ctrl+F, F3 / Shift+F3</td><td>Search, next / previous match</td></tr>
    <tr><td>Ctrl+C / Ctrl+X / Ctrl+V</td><td>Copy / cut / paste (as child) — Markdown list text</td></tr>
    <tr><td>Ctrl+D</td><td>Duplicate</td></tr>
    <tr><td>Ctrl+Z / Ctrl+Y</td><td>Undo / redo (VS Code)</td></tr>
    <tr><td>Ctrl+= / Ctrl+- / Ctrl+0</td><td>Zoom in / out / fit</td></tr>
    <tr><td>Ctrl+click link</td><td>Open link</td></tr>
  </table>
  <p>Click anywhere to close.</p>
</div>
<div class="mm-menu" hidden></div>
<div class="mm-marquee" hidden></div>
<textarea class="mm-input" spellcheck="false" autocomplete="off"></textarea>
<div class="mm-status"></div>
`;

const svgEl = app.querySelector<SVGSVGElement>('.mm-svg')!;
const input = app.querySelector<HTMLTextAreaElement>('.mm-input')!;
const helpEl = app.querySelector<HTMLDivElement>('.mm-help')!;
const statusEl = app.querySelector<HTMLDivElement>('.mm-status')!;
const menuEl = app.querySelector<HTMLDivElement>('.mm-menu')!;
const marqueeEl = app.querySelector<HTMLDivElement>('.mm-marquee')!;
const bannerEl = app.querySelector<HTMLDivElement>('.mm-banner')!;
const searchEl = app.querySelector<HTMLDivElement>('.mm-search')!;
const searchInput = app.querySelector<HTMLInputElement>('.mm-search-input')!;
const searchCount = app.querySelector<HTMLSpanElement>('.mm-search-count')!;

const transformer = new Transformer();
const mm = Markmap.create(svgEl, { duration: 300 });
const baseOptions = { ...mm.options };

// Pan with the right mouse button (left button selects), zoom with the wheel.
mm.zoom.filter((event: any) => {
  if (event.type === 'wheel')
    return mm.options.scrollForPan ? event.ctrlKey : true;
  if (event.type === 'dblclick') return false;
  if (event.type.startsWith('touch')) return true;
  return event.type === 'mousedown' && event.button === 2;
});

const layer = mm.g.insert('g', ':first-child').attr('class', 'mm-layer');
const matchLayer = layer.append('g');
const selLayer = layer.append('g');
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
/** Primary selection: target of keyboard commands. */
let selected: MNode | null = null;
/** Additional selected node ids (multi-selection). */
let extra = new Set<number>();
/** Model id -> rendered markmap node */
let rendered = new Map<number, INode>();
let rootMid = 0;
/** "Show branch only": model id of the branch shown as the root. */
let focusId: number | null = null;

let query = '';
let matches: MNode[] = [];
let matchIndex = -1;

interface EditState {
  node: MNode;
  isNew: boolean;
  original: string;
  multiline: boolean;
  /** Node to select when a new node is cancelled. */
  fallback: MNode | null;
  /** Checkbox / marker kept when the text is replaced by typing. */
  keepPrefix: string;
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

  let dataRoot = root as INode;
  if (focusId != null) {
    const focusNode = findById(doc, focusId);
    const focusINode = rendered.get(focusId);
    if (focusNode && focusINode && focusId !== rootMid) {
      focusNode.fold = false;
      focusINode.payload = { ...focusINode.payload, fold: 0 };
      dataRoot = focusINode;
    } else {
      focusId = null;
    }
  }
  bannerEl.hidden = focusId == null;

  mm.options = {
    ...baseOptions,
    ...derived,
    initialExpandLevel: -1,
    autoFit: false,
    duration: derived.duration ?? 300,
  };
  mm.setOptions();
  mm.state.data = dataRoot;
  mm.updateStyle();
  await mm.renderData();
  if (seq !== renderSeq) return;
  if (firstRender) {
    firstRender = false;
    await mm.fit();
  }
  if (selected && !findById(doc, selected.id)) selected = null;
  extra.forEach((mid) => {
    if (!findById(doc, mid)) extra.delete(mid);
  });
  if (query) computeMatches();
  updateSelection();
}

function getINode(node: MNode | null | undefined) {
  return node ? rendered.get(node.id) : undefined;
}

function getRootNode() {
  return findById(doc, rootMid) || doc.root;
}

/** The node displayed as the root (differs in "show branch only" mode). */
function viewRoot() {
  return (focusId != null && findById(doc, focusId)) || getRootNode();
}

function isRootNode(node: MNode) {
  return node.kind === 'root' || node.id === rootMid;
}

function isShown(node: MNode) {
  if (!rendered.has(node.id)) return false;
  const top = viewRoot();
  if (focusId != null && !isAncestor(top, node)) return false;
  if (node === top) return true;
  for (let p = node.parent; p; p = p.parent) {
    if (p.fold) return false;
    if (p === top) break;
  }
  return true;
}

interface RectItem {
  id: number;
  r: { x: number; y: number; width: number; height: number };
  cls: string;
}

function drawRects(
  group: any,
  items: RectItem[],
  pad: number,
  animate: boolean,
) {
  const place = (s: any) =>
    s
      .attr('x', (d: RectItem) => d.r.x - pad)
      .attr('y', (d: RectItem) => d.r.y - pad)
      .attr('width', (d: RectItem) => d.r.width + pad * 2)
      .attr('height', (d: RectItem) => d.r.height + pad * 2);
  const sel = group.selectAll('rect').data(items, (d: RectItem) => d.id);
  sel.exit().remove();
  sel
    .enter()
    .append('rect')
    .attr('rx', 4)
    .attr('class', (d: RectItem) => d.cls)
    .call(place);
  sel.attr('class', (d: RectItem) => d.cls);
  if (animate) {
    sel.transition().duration(mm.options.duration).call(place);
  } else {
    sel.interrupt().call(place);
  }
}

function updateSelection(animate = true) {
  drawRects(
    selLayer,
    selectedNodes()
      .filter(isShown)
      .map((n) => ({
        id: n.id,
        r: getINode(n)!.state.rect,
        cls: n === selected ? 'mm-selection primary' : 'mm-selection',
      })),
    4,
    animate,
  );
  const current = matches[matchIndex];
  drawRects(
    matchLayer,
    matches.filter(isShown).map((n) => ({
      id: n.id,
      r: getINode(n)!.state.rect,
      cls: n === current ? 'mm-match current' : 'mm-match',
    })),
    7,
    animate,
  );
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

function selectedNodes(): MNode[] {
  const list: MNode[] = [];
  if (selected) list.push(selected);
  if (extra.size) {
    walk(doc.root, (n) => {
      if (n !== selected && extra.has(n.id)) list.push(n);
    });
  }
  return list;
}

function isSelected(node: MNode) {
  return node === selected || extra.has(node.id);
}

/** Drop nodes whose ancestor is in the list, sort in document order. */
function topLevel(nodes: MNode[]) {
  const set = new Set(nodes);
  const order = new Map<MNode, number>();
  walk(doc.root, (n) => {
    order.set(n, order.size);
  });
  return nodes
    .filter((n) => {
      for (let p = n.parent; p; p = p.parent) if (set.has(p)) return false;
      return true;
    })
    .sort((a, b) => order.get(a)! - order.get(b)!);
}

function setSelection(
  primary: MNode | null,
  others: MNode[] = [],
  animate = true,
) {
  selected = primary;
  extra = new Set(others.filter((n) => n !== primary).map((n) => n.id));
  updateSelection(animate);
}

function selectNode(node: MNode | null, reveal = true) {
  setSelection(node);
  if (reveal) revealSelected();
}

function revealSelected() {
  const inode = getINode(selected);
  if (inode && selected && isShown(selected)) {
    mm.ensureVisible(inode, { left: 40, right: 40, top: 60, bottom: 40 });
  }
}

function toggleSelect(node: MNode) {
  if (node === selected) {
    const rest = selectedNodes().slice(1);
    if (rest.length) setSelection(rest[0], rest);
  } else if (extra.has(node.id)) {
    extra.delete(node.id);
    updateSelection();
  } else {
    setSelection(node, selectedNodes());
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
  if (!selected || !isShown(selected)) {
    selectNode(viewRoot());
    return;
  }
  const cur = selected;
  const top = viewRoot();
  if (dir === 'left') {
    if (cur !== top && cur.parent && rendered.has(cur.parent.id)) {
      selectNode(cur.parent);
    } else {
      selectNode(cur);
    }
    return;
  }
  if (dir === 'right') {
    const children = shownChildren(cur);
    if (!children.length) return selectNode(cur);
    if (cur.fold) {
      setFold([cur], false);
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
  if (cur.parent && cur !== top && cur.id !== rootMid) {
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
  selectNode(best || cur);
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

function hasShownChildren(node: MNode) {
  return shownChildren(node).length > 0;
}

function setFold(nodes: MNode[], fold: boolean, recursive = false) {
  nodes.forEach((node) => {
    if (recursive) {
      walk(node, (n) => {
        n.fold = fold;
      });
    } else {
      node.fold = fold;
    }
  });
  return refreshFolds();
}

/** Is any branch below `node` (not `node` itself) folded? */
function hasFoldedSubBranch(node: MNode) {
  let found = false;
  node.children.forEach((c) =>
    walk(c, (n) => {
      if (found) return false;
      if (n.fold && hasShownChildren(n)) found = true;
    }),
  );
  return found;
}

function hasSubBranch(node: MNode) {
  return node.children.some(hasShownChildren);
}

/** XMind "Fold All Sub-branches": keep the children shown, fold below them. */
function toggleSubBranches(nodes: MNode[], primary: MNode) {
  const unfold = hasFoldedSubBranch(primary);
  nodes.forEach((node) => {
    node.fold = false;
    node.children.forEach((c) =>
      walk(c, (n) => {
        n.fold = unfold ? false : hasShownChildren(n);
      }),
    );
  });
  return refreshFolds();
}

function showLevels(level: number) {
  const root = viewRoot();
  const visit = (n: MNode, depth: number) => {
    n.fold = level > 0 && depth >= level;
    n.children.forEach((c) => visit(c, depth + 1));
  };
  visit(root, 1);
  const shown = selectedNodes().filter(isShown);
  if (selected && !isShown(selected)) {
    let s: MNode | null = selected;
    while (s && !isShown(s)) s = s.parent;
    setSelection(s, shown, false);
  } else {
    setSelection(selected, shown, false);
  }
  return refreshFolds().then(() => mm.fit());
}

mm.handleClick = (e: MouseEvent, d: INode) => {
  const node = findById(doc, d.payload?.mid as number);
  if (!node || !hasShownChildren(node)) return;
  setFold([node], !node.fold, e.ctrlKey || e.metaKey);
};

/* ------------------------------------------------------------------------ */
/* Show branch only                                                          */
/* ------------------------------------------------------------------------ */

async function setFocus(id: number | null) {
  focusId = id;
  await render();
  await mm.fit();
}

/** Select a node, unfolding and leaving "branch only" mode as needed. */
async function revealNode(node: MNode) {
  let needRender = false;
  if (focusId != null && !isAncestor(viewRoot(), node)) {
    focusId = null;
    needRender = true;
  }
  let changed = false;
  for (let p = node.parent; p; p = p.parent) {
    if (p.fold) {
      p.fold = false;
      changed = true;
    }
  }
  if (needRender) await render();
  else if (changed) await refreshFolds();
  selectNode(node);
}

/* ------------------------------------------------------------------------ */
/* Markers                                                                   */
/* ------------------------------------------------------------------------ */

async function applyMarker(marker: string | null) {
  const targets = selectedNodes().filter(
    (n) => n.kind !== 'root' && n.kind !== 'block',
  );
  if (!targets.length) return;
  // Clicking the marker every target already has removes it.
  const remove =
    marker != null &&
    targets.every((n) => splitMarker(n.text).marker === marker);
  let changed = false;
  targets.forEach((n) => {
    const next = setMarker(n.text, remove ? null : marker);
    if (next !== n.text) {
      n.text = next;
      changed = true;
    }
  });
  if (changed) await commit();
}

/* ------------------------------------------------------------------------ */
/* Search                                                                    */
/* ------------------------------------------------------------------------ */

function computeMatches() {
  const q = query.toLowerCase();
  const current = matches[matchIndex];
  matches = [];
  if (q) {
    walk(doc.root, (n) => {
      if (
        n.kind !== 'root' &&
        rendered.has(n.id) &&
        getEditText(n).toLowerCase().includes(q)
      ) {
        matches.push(n);
      }
    });
  }
  matchIndex = current ? matches.indexOf(current) : -1;
  updateSearchCount();
}

function updateSearchCount() {
  searchCount.textContent = query
    ? `${matchIndex >= 0 ? matchIndex + 1 : 0}/${matches.length}`
    : '';
  searchEl.classList.toggle('no-match', !!query && !matches.length);
}

async function gotoMatch(delta: 1 | -1) {
  if (!matches.length) return;
  matchIndex =
    matchIndex < 0
      ? delta > 0
        ? 0
        : matches.length - 1
      : (matchIndex + delta + matches.length) % matches.length;
  updateSearchCount();
  await revealNode(matches[matchIndex]);
}

function setQuery(value: string) {
  query = value.trim();
  matchIndex = -1;
  computeMatches();
  updateSelection(false);
  if (matches.length) gotoMatch(1);
}

function clearSearch() {
  searchInput.value = '';
  setQuery('');
}

searchInput.addEventListener('input', () => setQuery(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter' || e.key === 'F3') {
    e.preventDefault();
    gotoMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    clearSearch();
    focusInput();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInput.select();
  }
});

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
  if (rightDown) rightDown.moved = true;
  closeMenu();
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
  closeMenu();
  const multiline = node.kind === 'block';
  editing = {
    node,
    isNew: !!opts.isNew,
    original: getEditText(node),
    multiline,
    fallback: opts.fallback ?? null,
    keepPrefix: opts.replace && !multiline ? splitMarker(node.text).prefix : '',
  };
  setSelection(node, [], false);
  input.classList.add('editing');
  input.classList.toggle('multiline', multiline);
  if (!opts.replace) {
    input.value = getEditText(node);
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
  let value = state.multiline
    ? input.value.replace(/\s+$/, '')
    : input.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
  // Typing over a node replaces its text but keeps its checkbox / marker.
  if (value && state.keepPrefix && !splitMarker(value).prefix) {
    value = state.keepPrefix + value;
  }
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
  if (changed) setEditText(node, value);
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
/* Clipboard                                                                 */
/* ------------------------------------------------------------------------ */

/** Fallback when the system clipboard is not accessible. */
let internalClipboard = '';

function selectionMarkdown() {
  const nodes = topLevel(selectedNodes()).filter((n) => n.kind !== 'root');
  return nodes.length ? subtreeToMarkdown(nodes) : '';
}

async function copyToClipboard() {
  const md = selectionMarkdown();
  if (!md) return false;
  internalClipboard = md;
  let ok = false;
  try {
    // Fires the `copy` event below, which writes the Markdown.
    ok = document.execCommand('copy');
  } catch {
    // ignore
  }
  if (!ok) {
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      // keep the internal clipboard only
    }
  }
  return true;
}

async function pasteFromClipboard() {
  try {
    const data = await navigator.clipboard.readText();
    if (data) {
      pasteText(data);
      return;
    }
  } catch {
    // ignore
  }
  let ok = false;
  try {
    // Fires the `paste` event below.
    ok = document.execCommand('paste');
  } catch {
    // ignore
  }
  if (!ok && internalClipboard) pasteText(internalClipboard);
}

function pasteText(data: string) {
  const nodes = parseFragment(data);
  if (!nodes.length) return;
  const parent = selected && selected.kind !== 'block' ? selected : viewRoot();
  insertNodes(doc, parent, nodes);
  extra = new Set(nodes.slice(1).map((n) => n.id));
  structural(() => true, nodes[0]);
}

const clipboardTarget = () =>
  !editing && document.activeElement !== searchInput;

document.addEventListener('copy', (e) => {
  if (!clipboardTarget()) return;
  const md = selectionMarkdown();
  if (!md) return;
  internalClipboard = md;
  e.clipboardData?.setData('text/plain', md);
  e.preventDefault();
});

document.addEventListener('cut', (e) => {
  if (!clipboardTarget()) return;
  const md = selectionMarkdown();
  if (!md) return;
  internalClipboard = md;
  e.clipboardData?.setData('text/plain', md);
  e.preventDefault();
  runCommand('delete');
});

document.addEventListener('paste', (e) => {
  if (!clipboardTarget()) return;
  e.preventDefault();
  pasteText(e.clipboardData?.getData('text/plain') || '');
});

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */
/* ------------------------------------------------------------------------ */

const visible = (n: MNode) => rendered.has(n.id);

async function structural(fn: () => boolean | void, keep = selected) {
  if (fn() === false) return;
  selected = keep;
  await commit();
  revealSelected();
}

/** Where the selection goes after `nodes` are deleted. */
function nextAfterRemoval(nodes: MNode[]) {
  const set = new Set(nodes);
  const gone = (n: MNode) => {
    for (let p: MNode | null = n; p; p = p.parent) if (set.has(p)) return true;
    return false;
  };
  const base = selected && gone(selected) ? selected : nodes[0];
  const parent = base.parent!;
  const siblings = shownChildren(parent);
  const i = siblings.indexOf(base);
  const candidate = [
    ...siblings.slice(i + 1),
    ...siblings.slice(0, Math.max(i, 0)).reverse(),
  ].find((s) => !gone(s));
  if (candidate) return candidate;
  let p: MNode | null = parent;
  while (p && gone(p)) p = p.parent;
  return p;
}

function moveMany(nodes: MNode[], target: MNode, position: DropPosition) {
  let ok = false;
  let ref = target;
  nodes.forEach((n) => {
    if (position === 'after') {
      if (moveTo(doc, n, ref, 'after')) {
        ok = true;
        ref = n;
      }
    } else if (moveTo(doc, n, target, position)) {
      ok = true;
    }
  });
  return ok;
}

async function runCommand(cmd: string) {
  closeMenu();
  const node = selected;
  const top = viewRoot();
  const isRoot = !node || isRootNode(node) || node === top;
  /** Selected nodes that can be moved / deleted. */
  const many = () => topLevel(selectedNodes()).filter((n) => !isRootNode(n));
  switch (cmd) {
    case 'addChild': {
      const parent = node || top;
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
      const nodes = many();
      if (!nodes.length) return;
      const next = nextAfterRemoval(nodes);
      nodes.forEach((n) =>
        cmd === 'delete' ? remove(n) : removeKeepChildren(n),
      );
      extra.clear();
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
      if (node.parent === top) return;
      await structural(() => outdent(doc, node));
      break;
    case 'duplicate': {
      const nodes = many();
      if (!nodes.length) return;
      const copies = nodes.map((n) => {
        const copy = cloneTree(n);
        const parent = n.parent!;
        insertNodes(doc, parent, [copy], parent.children.indexOf(n) + 1);
        return copy;
      });
      extra = new Set(copies.slice(1).map((n) => n.id));
      await structural(() => true, copies[0]);
      break;
    }
    case 'edit':
      if (node) startEdit(node);
      break;
    case 'toggle':
    case 'toggleRecursive': {
      if (!node) return;
      const targets = selectedNodes().filter(hasShownChildren);
      if (!targets.length) return;
      const fold = !(hasShownChildren(node) ? node : targets[0]).fold;
      await setFold(targets, fold, cmd === 'toggleRecursive');
      break;
    }
    case 'toggleSubBranches': {
      if (!node) return;
      const targets = selectedNodes().filter(hasSubBranch);
      if (!targets.length) return;
      await toggleSubBranches(targets, hasSubBranch(node) ? node : targets[0]);
      break;
    }
    case 'showBranch':
      if (focusId != null && (!node || node.id === focusId || isRootNode(node)))
        await setFocus(null);
      else if (node && !isRootNode(node)) await setFocus(node.id);
      break;
    case 'showAll':
      if (focusId != null) await setFocus(null);
      break;
    case 'mark1':
    case 'mark2':
    case 'mark3':
      await applyMarker(MARKERS[+cmd.slice(4) - 1]);
      break;
    case 'markClear':
      await applyMarker(null);
      break;
    case 'cut':
      if (many().length && (await copyToClipboard())) {
        await runCommand('delete');
      }
      break;
    case 'copy':
      await copyToClipboard();
      break;
    case 'paste':
      await pasteFromClipboard();
      break;
    case 'selectAll': {
      const all: MNode[] = [];
      walk(top, (n) => {
        if (isShown(n)) all.push(n);
      });
      setSelection(node && isShown(node) ? node : top, all);
      break;
    }
    case 'search':
      searchInput.focus();
      searchInput.select();
      return;
    case 'searchNext':
      await gotoMatch(1);
      break;
    case 'searchPrev':
      await gotoMatch(-1);
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
  if (!editing && document.activeElement !== searchInput) focusInput();
}

for (const panel of app.querySelectorAll('.mm-toolbar, .mm-side')) {
  panel.addEventListener('mousedown', (e) => {
    // Keep focus where it is (editor input or search box).
    if ((e.target as Element).closest('button')) e.preventDefault();
  });
  panel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-cmd],button[data-find]',
    );
    if (!btn) return;
    if (btn.dataset.find) {
      searchInput.value = btn.dataset.find;
      setQuery(searchInput.value);
      return;
    }
    runCommand(btn.dataset.cmd!);
  });
}
helpEl.addEventListener('click', () => {
  helpEl.hidden = true;
  focusInput();
});
bannerEl.addEventListener('click', (e) => {
  e.preventDefault();
  runCommand('showAll');
});

/* ------------------------------------------------------------------------ */
/* Context menu                                                              */
/* ------------------------------------------------------------------------ */

type MenuEntry =
  | { label: string; key?: string; cmd: string; disabled?: boolean }
  | '-'
  | 'markers';

function nodeMenu(): MenuEntry[] {
  const node = selected!;
  const root = isRootNode(node) || node === viewRoot();
  const movable = topLevel(selectedNodes()).some((n) => !isRootNode(n));
  return [
    { label: 'Add Topic', key: 'Enter', cmd: 'addSibling' },
    {
      label: 'Add Subtopic',
      key: 'Tab',
      cmd: 'addChild',
      disabled: node.kind === 'block',
    },
    {
      label: 'Insert Parent Topic',
      key: 'Ctrl+Enter',
      cmd: 'insertParent',
      disabled: root,
    },
    {
      label: 'Edit Topic',
      key: 'F2',
      cmd: 'edit',
      disabled: node.kind === 'root',
    },
    '-',
    { label: 'Cut', key: 'Ctrl+X', cmd: 'cut', disabled: !movable },
    { label: 'Copy', key: 'Ctrl+C', cmd: 'copy' },
    {
      label: 'Paste',
      key: 'Ctrl+V',
      cmd: 'paste',
      disabled: node.kind === 'block',
    },
    { label: 'Duplicate', key: 'Ctrl+D', cmd: 'duplicate', disabled: !movable },
    { label: 'Delete', key: 'Backspace', cmd: 'delete', disabled: !movable },
    {
      label: 'Delete Single Topic',
      key: 'Ctrl+Backspace',
      cmd: 'deleteKeepChildren',
      disabled: !movable,
    },
    '-',
    'markers',
    '-',
    {
      label: node.fold ? 'Unfold Subtopic' : 'Fold Subtopic',
      key: 'Ctrl+/',
      cmd: 'toggle',
      disabled: !hasShownChildren(node),
    },
    {
      label: hasFoldedSubBranch(node)
        ? 'Unfold All Sub-branches'
        : 'Fold All Sub-branches',
      key: 'Ctrl+Alt+/',
      cmd: 'toggleSubBranches',
      disabled: !hasSubBranch(node),
    },
    '-',
    {
      label: focusId === node.id ? 'Show All Branches' : 'Show Branch Only',
      key: 'Ctrl+;',
      cmd: 'showBranch',
      disabled: isRootNode(node) && focusId == null,
    },
  ];
}

function canvasMenu(): MenuEntry[] {
  return [
    { label: 'Expand All', key: 'Alt+0', cmd: 'expandAll' },
    { label: 'Collapse All', key: 'Alt+1', cmd: 'collapseAll' },
    '-',
    { label: 'Select All', key: 'Ctrl+A', cmd: 'selectAll' },
    { label: 'Search', key: 'Ctrl+F', cmd: 'search' },
    { label: 'Fit Map', key: 'Ctrl+0', cmd: 'fit' },
    ...(focusId != null
      ? [{ label: 'Show All Branches', key: 'Ctrl+;', cmd: 'showAll' }]
      : []),
  ];
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function showMenu(x: number, y: number, entries: MenuEntry[]) {
  menuEl.innerHTML = entries
    .map((entry) => {
      if (entry === '-') return '<div class="mm-menu-sep"></div>';
      if (entry === 'markers') {
        return `<div class="mm-menu-markers"><span>Marker</span>${markButtons(
          'data-cmd',
          (i) => `${MARK_NAMES[i]} (Ctrl+${i + 1})`,
        )}<button data-cmd="markClear" title="Remove marker">⊘</button></div>`;
      }
      return `<div class="mm-menu-item${entry.disabled ? ' disabled' : ''}" data-cmd="${
        entry.cmd
      }"><span>${escapeHtml(entry.label)}</span><kbd>${escapeHtml(
        entry.key || '',
      )}</kbd></div>`;
    })
    .join('');
  menuEl.hidden = false;
  const { width, height } = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width - 4))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height - 4))}px`;
}

function closeMenu() {
  menuEl.hidden = true;
}

function openMenuAtSelection() {
  if (!selected || !isShown(selected)) {
    const r = svgEl.getBoundingClientRect();
    showMenu(r.left + 40, r.top + 60, canvasMenu());
    return;
  }
  const r = clientRect(selected);
  showMenu(r.left, r.bottom + 4, nodeMenu());
}

menuEl.addEventListener('mousedown', (e) => e.preventDefault());
menuEl.addEventListener('contextmenu', (e) => e.preventDefault());
menuEl.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd]');
  if (!item || item.classList.contains('disabled')) return;
  runCommand(item.dataset.cmd!);
});
window.addEventListener(
  'mousedown',
  (e) => {
    if (!menuEl.contains(e.target as Node)) closeMenu();
  },
  true,
);
window.addEventListener('blur', closeMenu);

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
    // Shift+Enter: line break inside the topic (native textarea newline).
    if (!state.multiline && e.shiftKey) {
      requestAnimationFrame(() => positionInput());
      return;
    }
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
  const handled = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (!menuEl.hidden) {
    closeMenu();
    if (key === 'Escape') return handled();
  }
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
    handled();
    navigate(key.slice(5).toLowerCase() as 'up');
    return;
  } else if (key === 'Home') {
    handled();
    selectNode(viewRoot());
    return;
  } else if (key === 'Escape') {
    handled();
    if (!helpEl.hidden) helpEl.hidden = true;
    else if (focusId != null) runCommand('showAll');
    else if (extra.size) selectNode(selected, false);
    else if (query) clearSearch();
    return;
  } else if (key === 'ContextMenu' || (shift && key === 'F10')) {
    handled();
    openMenuAtSelection();
    return;
  } else if (ctrl && alt && code === 'Slash') cmd = 'toggleSubBranches';
  else if (ctrl && code === 'Slash') cmd = shift ? 'toggleRecursive' : 'toggle';
  else if (ctrl && code === 'Semicolon') cmd = 'showBranch';
  else if (ctrl && !alt && /^Digit[1-3]$/.test(code)) cmd = `mark${code[5]}`;
  else if (alt && !ctrl && /^Digit\d$/.test(code)) {
    handled();
    showLevels(+code.slice(5));
    return;
  } else if (ctrl && (key === '=' || key === '+')) cmd = 'zoomIn';
  else if (ctrl && key === '-') cmd = 'zoomOut';
  else if (ctrl && key === '0') cmd = 'fit';
  else if (ctrl && key.toLowerCase() === 'd') cmd = 'duplicate';
  else if (ctrl && key.toLowerCase() === 'f') cmd = 'search';
  else if (ctrl && key.toLowerCase() === 'a') cmd = 'selectAll';
  else if (key === 'F3') cmd = shift ? 'searchPrev' : 'searchNext';
  else if (key === 'F1' || (key === '?' && !ctrl)) cmd = 'help';
  if (!cmd) return;
  handled();
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

input.addEventListener('contextmenu', (e) => {
  if (editing) return;
  e.preventDefault();
  e.stopPropagation();
  openMenuAtSelection();
});

/* ------------------------------------------------------------------------ */
/* Mouse: select, box select, edit, links, drag & drop, pan                  */
/* ------------------------------------------------------------------------ */

function toMap(clientX: number, clientY: number) {
  const s = svgEl.getBoundingClientRect();
  const t = zoomTransform(svgEl);
  return {
    x: (clientX - s.left - t.x) / t.k,
    y: (clientY - s.top - t.y) / t.k,
  };
}

function clientRect(node: MNode) {
  const r = getINode(node)!.state.rect;
  const s = svgEl.getBoundingClientRect();
  const t = zoomTransform(svgEl);
  const left = s.left + t.x + r.x * t.k;
  const top = s.top + t.y + r.y * t.k;
  return {
    left,
    top,
    right: left + r.width * t.k,
    bottom: top + r.height * t.k,
  };
}

/**
 * Find the node at a point. Each node owns a generous area around it:
 * the link gap on its left, a minimum width on its right and half of the
 * vertical spacing, so short topics are easy to hit. The closest wins.
 */
function pickNode(
  clientX: number,
  clientY: number,
  exclude?: (n: MNode) => boolean,
): MNode | null {
  const { x, y } = toMap(clientX, clientY);
  const { spacingHorizontal, spacingVertical } = mm.options;
  let best: MNode | null = null;
  let bestScore = Infinity;
  walk(doc.root, (n) => {
    if (!isShown(n) || exclude?.(n)) return;
    const r = getINode(n)!.state.rect;
    const left = r.x - spacingHorizontal * 0.6;
    const right = r.x + Math.max(r.width, 80) + 8;
    const top = r.y - spacingVertical / 2 - 2;
    const bottom = r.y + r.height + spacingVertical / 2 + 2;
    if (x < left || x > right || y < top || y > bottom) return;
    const dx = x < r.x ? r.x - x : Math.max(0, x - r.x - r.width);
    const dy = y < r.y ? r.y - y : Math.max(0, y - r.y - r.height);
    const score = dx + dy * 3;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  });
  return best;
}

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

function nodeAt(e: MouseEvent) {
  return nodeFromEvent(e) || pickNode(e.clientX, e.clientY);
}

let suppressClick = false;

function suppressNextClick() {
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 0);
}

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
      }
    }
  },
  true,
);

svgEl.addEventListener(
  'dblclick',
  (e) => {
    const node = nodeAt(e);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    startEdit(node);
  },
  true,
);

interface DragState {
  nodes: MNode[];
  /** The node under the mouse. */
  anchor: MNode;
  x: number;
  y: number;
  active: boolean;
  /** Clicking a node of a multi-selection selects only that node. */
  collapse: boolean;
  ghost?: HTMLDivElement;
  target?: { node: MNode; position: DropPosition };
}
let drag: DragState | null = null;

interface MarqueeState {
  x: number;
  y: number;
  active: boolean;
  additive: boolean;
  base: MNode[];
  basePrimary: MNode | null;
}
let marquee: MarqueeState | null = null;

let rightDown: { x: number; y: number; moved: boolean } | null = null;

svgEl.addEventListener(
  'mousedown',
  (e) => {
    closeMenu();
    if (e.button === 2) {
      // Right button pans the map (d3-zoom); a click opens the menu.
      rightDown = { x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    if (e.button !== 0) return;
    if ((e.target as Element).closest('circle')) return; // fold toggle
    e.preventDefault();
    if (editing) finishEdit(true);
    else focusInput();
    const ctrl = e.ctrlKey || e.metaKey;
    const link = (e.target as Element).closest('a');
    const node = nodeAt(e);
    if (!node) {
      marquee = {
        x: e.clientX,
        y: e.clientY,
        active: false,
        additive: ctrl || e.shiftKey,
        base: selectedNodes(),
        basePrimary: selected,
      };
      return;
    }
    if (ctrl && link) return; // Ctrl+click opens the link
    if (ctrl || e.shiftKey) {
      toggleSelect(node);
      return;
    }
    const inSelection = isSelected(node) && extra.size > 0;
    if (!inSelection) selectNode(node, false);
    const nodes = topLevel(inSelection ? selectedNodes() : [node]).filter(
      (n) => !isRootNode(n) && n !== viewRoot(),
    );
    if (!nodes.length && !inSelection) return;
    drag = {
      nodes,
      anchor: node,
      x: e.clientX,
      y: e.clientY,
      active: false,
      collapse: inSelection,
    };
  },
  true,
);

svgEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const down = rightDown;
  rightDown = null;
  if (
    down &&
    (down.moved || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4)
  ) {
    return; // it was a pan
  }
  if (editing) finishEdit(true);
  const node = nodeAt(e);
  if (node) {
    if (!isSelected(node)) selectNode(node, false);
    showMenu(e.clientX, e.clientY, nodeMenu());
  } else {
    showMenu(e.clientX, e.clientY, canvasMenu());
  }
  focusInput();
});

function dropTarget(clientX: number, clientY: number, nodes: MNode[]) {
  const node = pickNode(clientX, clientY, (n) =>
    nodes.some((d) => isAncestor(d, n)),
  );
  if (!node) return undefined;
  const { y } = toMap(clientX, clientY);
  const r = getINode(node)!.state.rect;
  const pad = 6;
  const ratio = (y - r.y + pad) / (r.height + pad * 2);
  let position: DropPosition = 'child';
  if (!isRootNode(node) && node !== viewRoot()) {
    if (ratio < 0.3) position = 'before';
    else if (ratio > 0.7) position = 'after';
  }
  if (position === 'child' && node.kind === 'block') position = 'after';
  return { node, position };
}

function updateMarquee(e: MouseEvent) {
  const m = marquee!;
  if (!m.active) {
    if (Math.hypot(e.clientX - m.x, e.clientY - m.y) < 4) return;
    m.active = true;
    marqueeEl.hidden = false;
  }
  const left = Math.min(m.x, e.clientX);
  const right = Math.max(m.x, e.clientX);
  const top = Math.min(m.y, e.clientY);
  const bottom = Math.max(m.y, e.clientY);
  Object.assign(marqueeEl.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
  });
  const hits: MNode[] = [];
  walk(doc.root, (n) => {
    if (!isShown(n)) return;
    const r = clientRect(n);
    if (
      r.right >= left &&
      r.left <= right &&
      r.bottom >= top &&
      r.top <= bottom
    )
      hits.push(n);
  });
  if (m.additive) {
    const all = [...m.base, ...hits.filter((n) => !m.base.includes(n))];
    setSelection(m.basePrimary || all[0] || null, all, false);
  } else if (hits.length) {
    setSelection(hits[0], hits, false);
  } else {
    setSelection(m.basePrimary, [], false);
  }
}

window.addEventListener('mousemove', (e) => {
  if (marquee) {
    updateMarquee(e);
    return;
  }
  if (!drag || !drag.nodes.length) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    drag.active = true;
    const ghost = document.createElement('div');
    ghost.className = 'mm-ghost';
    const more = drag.nodes.length - 1;
    ghost.textContent =
      (drag.nodes[0].text || '(empty)') + (more ? `  +${more}` : '');
    document.body.append(ghost);
    drag.ghost = ghost;
    app.classList.add('is-dragging');
  }
  drag.ghost!.style.left = `${e.clientX + 12}px`;
  drag.ghost!.style.top = `${e.clientY + 8}px`;
  drag.target = dropTarget(e.clientX, e.clientY, drag.nodes);
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

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (marquee) {
    const m = marquee;
    marquee = null;
    marqueeEl.hidden = true;
    if (m.active) suppressNextClick();
    else if (!m.additive && extra.size) selectNode(selected, false);
    return;
  }
  const state = drag;
  drag = null;
  if (!state) return;
  if (!state.active) {
    if (state.collapse) selectNode(state.anchor, false);
    return;
  }
  suppressNextClick();
  state.ghost?.remove();
  app.classList.remove('is-dragging');
  dropRect.style('display', 'none');
  const target = state.target;
  if (!target) return;
  structural(
    () => moveMany(state.nodes, target.node, target.position),
    selected,
  );
});

// Clicking on the blank canvas keeps keyboard focus in the editor.
svgEl.addEventListener('mouseup', () => {
  if (!editing && document.activeElement !== searchInput) {
    setTimeout(focusInput);
  }
});
window.addEventListener('focus', () => {
  if (!editing && document.activeElement !== searchInput) focusInput();
});

select(window).on('resize.mmEditor', () => positionInput());

host.postMessage({ type: 'ready' });
