/**
 * A structural model of a markmap Markdown document.
 *
 * The model understands the parts of Markdown that markmap turns into nodes
 * (ATX headings and list items) and keeps everything else (paragraphs, code
 * blocks, tables, frontmatter...) verbatim, so that a document can be edited
 * as a tree and written back to Markdown without losing content.
 */

export type NodeKind = 'root' | 'heading' | 'list' | 'block';

export interface MNode {
  id: number;
  kind: NodeKind;
  /** Heading level (1-6), 0 for other kinds. */
  level: number;
  /**
   * Heading / list item: the inline Markdown on the first line.
   * Block: the raw lines joined by `\n`.
   */
  text: string;
  /** List item continuation lines, dedented relative to the content. */
  extra: string[];
  /** Bullet character (`-`, `*`, `+`) or ordered delimiter (`.`, `)`). */
  marker: string;
  ordered: boolean;
  /** Original number of an ordered list item. */
  num: number;
  /** Whether a blank line precedes this node in the source. */
  blankBefore: boolean;
  children: MNode[];
  parent: MNode | null;
  /** 0-based line of this node in the current text. */
  line: number;
  /** UI-only fold state. `undefined` means "not decided yet". */
  fold?: boolean;
}

export interface MDoc {
  root: MNode;
  frontmatter: string[] | null;
  eol: string;
  trailingNewline: boolean;
  /** Indent width used for nested list items. */
  indentUnit: number;
  /** Default bullet used for new list items. */
  bullet: string;
  /** Whether a blank line separates a heading from the following list. */
  headingGap: boolean;
}

let nextId = 1;

export function createNode(props: Partial<MNode> = {}): MNode {
  return {
    id: nextId++,
    kind: 'list',
    level: 0,
    text: '',
    extra: [],
    marker: '-',
    ordered: false,
    num: 1,
    blankBefore: false,
    children: [],
    parent: null,
    line: -1,
    ...props,
  };
}

const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const RE_LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_FENCE = /^([ \t]*)(`{3,}|~{3,})/;

function expandIndent(line: string) {
  const m = line.match(/^[ \t]*/)!;
  let width = 0;
  for (const ch of m[0])
    width = ch === '\t' ? width + 4 - (width % 4) : width + 1;
  return { width, rest: line.slice(m[0].length) };
}

/** Remove up to `n` columns of leading whitespace. */
function dedent(line: string, n: number) {
  const { width, rest } = expandIndent(line);
  return ' '.repeat(Math.max(0, width - n)) + rest;
}

function stripClosingHashes(text: string) {
  return text.replace(/(^|[ \t]+)#+[ \t]*$/, '').trim();
}

interface ListFrame {
  node: MNode;
  indent: number;
  contentIndent: number;
}

interface Fence {
  char: string;
  len: number;
}

function matchFenceOpen(line: string): Fence | null {
  const m = line.match(RE_FENCE);
  return m ? { char: m[2][0], len: m[2].length } : null;
}

function isFenceClose(line: string, fence: Fence) {
  const t = line.trim();
  return (
    t.length >= fence.len &&
    t[0] === fence.char &&
    new RegExp(`^\\${fence.char}+$`).test(t)
  );
}

export function parse(text: string): MDoc {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text === '' || /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (trailingNewline && text !== '') lines.pop();

  const root = createNode({ kind: 'root', line: -1 });
  const doc: MDoc = {
    root,
    frontmatter: null,
    eol,
    trailingNewline,
    indentUnit: 2,
    bullet: '-',
    headingGap: true,
  };
  const gapVotes = [0, 0];
  let afterHeading = false;

  let i = 0;
  if (lines[0] === '---') {
    const end = lines.findIndex(
      (l, j) => j > 0 && (l === '---' || l === '...'),
    );
    if (end > 0) {
      doc.frontmatter = lines.slice(0, end + 1);
      i = end + 1;
    }
  }

  const headingStack: MNode[] = [root];
  let listStack: ListFrame[] = [];
  /** Node that receives continuation lines. */
  let current: MNode | null = null;
  let blockLines: string[] | null = null;
  let fence: Fence | null = null;
  let fenceDedent = 0;
  let pendingBlank = false;
  const indentSamples: number[] = [];
  const bullets: Record<string, number> = {};

  const headingTop = () => headingStack[headingStack.length - 1];
  const finishBlock = () => {
    if (current?.kind === 'block' && blockLines) {
      current.text = blockLines.join('\n');
    }
    blockLines = null;
  };
  const appendTo = (node: MNode, line: string, indent: number) => {
    if (node.kind === 'block') {
      blockLines!.push(line);
    } else {
      if (pendingBlank) node.extra.push('');
      node.extra.push(dedent(line, indent));
    }
  };
  const addChild = (parent: MNode, node: MNode) => {
    node.parent = parent;
    parent.children.push(node);
  };

  for (; i < lines.length; i += 1) {
    const line = lines[i];

    if (fence && current) {
      if (current.kind === 'block') blockLines!.push(line);
      else current.extra.push(dedent(line, fenceDedent));
      if (isFenceClose(line, fence)) fence = null;
      continue;
    }

    if (!line.trim()) {
      if (current?.kind === 'block') {
        finishBlock();
        current = null;
      }
      pendingBlank = true;
      continue;
    }

    const { width: indent } = expandIndent(line);
    const listMatch = RE_HR.test(line) ? null : line.match(RE_LIST);

    // Continuation of an open list item (indented content).
    if (!listMatch && listStack.length) {
      let k = listStack.length - 1;
      while (k >= 0 && listStack[k].contentIndent > indent) k -= 1;
      if (k >= 0) {
        listStack = listStack.slice(0, k + 1);
        const frame = listStack[k];
        current = frame.node;
        appendTo(current, line, frame.contentIndent);
        const f = matchFenceOpen(line);
        if (f) {
          fence = f;
          fenceDedent = frame.contentIndent;
        }
        pendingBlank = false;
        continue;
      }
    }

    const headingMatch = line.match(RE_HEADING);
    if (headingMatch && !(listStack.length && indent > 3)) {
      finishBlock();
      listStack = [];
      const level = headingMatch[1].length;
      while (headingTop().kind !== 'root' && headingTop().level >= level) {
        headingStack.pop();
      }
      const node = createNode({
        kind: 'heading',
        level,
        text: stripClosingHashes(headingMatch[2] || ''),
        blankBefore: pendingBlank,
        line: i,
      });
      addChild(headingTop(), node);
      headingStack.push(node);
      current = null;
      pendingBlank = false;
      afterHeading = true;
      continue;
    }

    if (listMatch) {
      finishBlock();
      const marker = listMatch[2];
      const ordered = /\d/.test(marker);
      const spaces = listMatch[3] ? expandIndent(listMatch[3]).width : 1;
      const contentIndent =
        indent + marker.length + (spaces > 4 || !listMatch[4] ? 1 : spaces);
      while (
        listStack.length &&
        listStack[listStack.length - 1].contentIndent > indent
      ) {
        listStack.pop();
      }
      const parentFrame = listStack[listStack.length - 1];
      if (parentFrame) indentSamples.push(indent - parentFrame.indent);
      if (!ordered) bullets[marker] = (bullets[marker] || 0) + 1;
      if (afterHeading) gapVotes[pendingBlank ? 1 : 0] += 1;
      const node = createNode({
        kind: 'list',
        text: (listMatch[4] || '').trim(),
        marker: ordered ? marker.slice(-1) : marker,
        ordered,
        num: ordered ? parseInt(marker, 10) : 1,
        // Only meaningful between list items (loose lists).
        blankBefore: pendingBlank && current?.kind === 'list',
        line: i,
      });
      afterHeading = false;
      addChild(parentFrame ? parentFrame.node : headingTop(), node);
      listStack.push({ node, indent, contentIndent });
      current = node;
      pendingBlank = false;
      continue;
    }

    // Lazy continuation of a list item paragraph.
    if (current?.kind === 'list' && !pendingBlank) {
      current.extra.push(line.trim());
      continue;
    }
    // Continuation of a block.
    if (current?.kind === 'block' && !pendingBlank) {
      blockLines!.push(line);
      const f = matchFenceOpen(line);
      if (f) fence = f;
      continue;
    }

    // A new block.
    afterHeading = false;
    finishBlock();
    listStack = [];
    const node = createNode({
      kind: 'block',
      blankBefore: pendingBlank,
      line: i,
    });
    addChild(headingTop(), node);
    current = node;
    blockLines = [line];
    const f = matchFenceOpen(line);
    if (f) fence = f;
    pendingBlank = false;
  }
  finishBlock();

  doc.headingGap = gapVotes[1] >= gapVotes[0];
  if (indentSamples.length) {
    const min = Math.min(...indentSamples.filter((n) => n > 0));
    if (min === 4) doc.indentUnit = 4;
  }
  const topBullet = Object.entries(bullets).sort((a, b) => b[1] - a[1])[0];
  if (topBullet) doc.bullet = topBullet[0];
  return doc;
}

/* ------------------------------------------------------------------------ */
/* Serialization                                                             */
/* ------------------------------------------------------------------------ */

function toListItem(node: MNode, bullet: string) {
  if (node.kind === 'list') return;
  if (node.kind === 'block') {
    const [first, ...rest] = node.text.split('\n');
    node.text = first.trim();
    node.extra = rest;
  }
  node.kind = 'list';
  node.level = 0;
  node.marker = bullet;
  node.ordered = false;
  node.blankBefore = false;
}

/** Turn a node into a heading; extra paragraph lines join with `<br>`. */
function toHeading(node: MNode, level: number) {
  if (node.kind === 'list') {
    const n = paragraphLength(node);
    if (n) {
      node.text = [node.text, ...node.extra.slice(0, n).map((l) => l.trim())]
        .filter(Boolean)
        .join('<br>');
      node.extra = node.extra.slice(n);
    }
  }
  node.kind = 'heading';
  node.level = level;
  node.ordered = false;
}

/** Blocks that markmap renders as nodes: code blocks, tables and images. */
export function isVisualBlock(node: MNode) {
  if (node.kind !== 'block') return false;
  const t = node.text.trim();
  return (
    /^(`{3,}|~{3,})/.test(t) ||
    /^[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-+:?[ \t]*(\||$)/m.test(t) ||
    /^!\[[^\]]*\]\([^)]*\)$/.test(t)
  );
}

/**
 * markmap shows only one kind of children under a heading, in this order of
 * precedence: headings, then blocks (code, tables, images), then list items.
 */
export function isHiddenByMarkmap(node: MNode) {
  const parent = node.parent;
  if (!parent || parent.kind === 'list' || node.kind === 'heading')
    return false;
  if (parent.children.some((c) => c.kind === 'heading')) return true;
  return node.kind === 'list' && parent.children.some(isVisualBlock);
}

/**
 * Make an inserted node fit among its new siblings, so that markmap keeps
 * showing it (markmap hides list items of a heading that has sub-headings).
 */
function adoptKind(doc: MDoc, node: MNode) {
  const parent = node.parent;
  if (!parent || parent.kind === 'list' || parent.kind === 'block') return;
  const others = parent.children.filter(
    (c) => c !== node && c.kind !== 'block',
  );
  const heading = others.find((c) => c.kind === 'heading');
  if (heading && node.kind !== 'heading') {
    if (node.kind === 'block') return;
    toHeading(node, heading.level);
    node.blankBefore = true;
  } else if (!heading && others.length && node.kind === 'heading') {
    toListItem(node, others[0].marker || doc.bullet);
  } else if (
    !others.length &&
    parent.kind === 'root' &&
    node.kind !== 'block'
  ) {
    toHeading(node, 1);
  }
  // List items next to code blocks / tables would be hidden: turn those
  // blocks into list items, which markmap renders with the same content.
  const hasList = parent.children.some((c) => c.kind === 'list');
  if (hasList) {
    parent.children
      .filter(isVisualBlock)
      .forEach((c) => toListItem(c, doc.bullet));
  }
}

/**
 * Make the tree representable in Markdown:
 * - children of list items are list items;
 * - headings deeper than level 6 become list items;
 * - list items after a heading sibling become headings (otherwise they would
 *   be swallowed by the previous heading);
 * - blocks after a heading sibling are moved before the headings.
 */
export function normalize(doc: MDoc) {
  const walk = (parent: MNode, parentLevel: number) => {
    const forceList = parent.kind === 'list';
    if (!forceList) {
      const firstHeading = parent.children.findIndex(
        (c) => c.kind === 'heading',
      );
      if (firstHeading >= 0) {
        const head = parent.children.slice(0, firstHeading);
        const tail = parent.children.slice(firstHeading);
        const movedBlocks = tail.filter((c) => c.kind === 'block');
        const rest = tail.filter((c) => c.kind !== 'block');
        parent.children = [...head, ...movedBlocks, ...rest];
      }
    }
    let seenHeading = false;
    let prevLevel = 6;
    const refLevel =
      parent.children.find((c) => c.kind === 'heading')?.level ??
      parentLevel + 1;
    for (const child of parent.children) {
      child.parent = parent;
      if (forceList) {
        toListItem(child, doc.bullet);
      } else if (
        child.kind === 'heading' ||
        (seenHeading && child.kind === 'list')
      ) {
        const min = parentLevel + 1;
        const wanted = child.kind === 'heading' ? child.level : refLevel;
        const level = Math.max(min, Math.min(wanted, prevLevel));
        if (level > 6) {
          toListItem(child, doc.bullet);
        } else {
          if (child.kind === 'list') child.blankBefore = true;
          toHeading(child, level);
          seenHeading = true;
          prevLevel = level;
        }
      }
      walk(child, child.kind === 'heading' ? child.level : parentLevel);
    }
  };
  walk(doc.root, 0);
}

export function serialize(doc: MDoc): string {
  normalize(doc);
  const out: string[] = [];
  if (doc.frontmatter) out.push(...doc.frontmatter);
  type Last = 'none' | 'heading' | 'list' | 'block';
  let last: Last = doc.frontmatter ? 'block' : 'none';
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };

  const emitList = (node: MNode, indent: number, num: number) => {
    if (
      last === 'block' ||
      (last === 'heading' && doc.headingGap) ||
      (last === 'list' && node.blankBefore)
    ) {
      blank();
    }
    const marker = node.ordered ? `${num}${node.marker}` : node.marker;
    const pad = ' '.repeat(indent);
    node.line = out.length;
    out.push(`${pad}${marker} ${node.text}`);
    const contentIndent = indent + marker.length + 1;
    for (const line of node.extra) {
      out.push(line ? ' '.repeat(contentIndent) + line : '');
    }
    last = 'list';
    const childIndent = indent + Math.max(doc.indentUnit, marker.length + 1);
    emitChildren(node, childIndent);
  };

  const emitChildren = (parent: MNode, listIndent: number) => {
    let runStart = 1;
    let runIndex = 0;
    parent.children.forEach((child, idx) => {
      const prev = parent.children[idx - 1];
      if (child.kind === 'heading') {
        if (last !== 'none') blank();
        child.line = out.length;
        out.push(`${'#'.repeat(child.level)} ${child.text}`);
        last = 'heading';
        emitChildren(child, 0);
      } else if (child.kind === 'list') {
        if (child.ordered) {
          if (!prev || prev.kind !== 'list' || !prev.ordered) {
            runStart = child.num || 1;
            runIndex = 0;
          }
          emitList(child, listIndent, runStart + runIndex);
          runIndex += 1;
        } else {
          emitList(child, listIndent, 0);
        }
      } else if (child.kind === 'block') {
        if (last !== 'none') blank();
        child.line = out.length;
        out.push(...child.text.split('\n'));
        last = 'block';
        emitChildren(child, 0);
      }
    });
  };

  doc.root.line = -1;
  emitChildren(doc.root, 0);
  let text = out.join(doc.eol);
  if (doc.trailingNewline && out.length) text += doc.eol;
  return text;
}

/* ------------------------------------------------------------------------ */
/* Tree helpers & operations                                                 */
/* ------------------------------------------------------------------------ */

export function walk(node: MNode, fn: (node: MNode) => void | false) {
  if (fn(node) === false) return;
  node.children.forEach((child) => walk(child, fn));
}

export function findById(doc: MDoc, id: number): MNode | undefined {
  let found: MNode | undefined;
  walk(doc.root, (node) => {
    if (found) return false;
    if (node.id === id) found = node;
  });
  return found;
}

export function isAncestor(ancestor: MNode, node: MNode | null) {
  for (let n = node; n; n = n.parent) if (n === ancestor) return true;
  return false;
}

function detach(node: MNode) {
  const parent = node.parent;
  if (!parent) return -1;
  const index = parent.children.indexOf(node);
  parent.children.splice(index, 1);
  node.parent = null;
  return index;
}

function attach(parent: MNode, node: MNode, index = parent.children.length) {
  node.parent = parent;
  parent.children.splice(index, 0, node);
}

/** Create a node shaped like `ref` (a sibling) or suitable as a child of `parent`. */
function makeNewNode(doc: MDoc, parent: MNode, ref?: MNode): MNode {
  if (ref && ref.kind !== 'block') {
    return createNode({
      kind: ref.kind,
      level: ref.level,
      marker: ref.marker,
      ordered: ref.ordered,
      num: ref.num,
      blankBefore: ref.kind === 'heading' || ref.blankBefore,
    });
  }
  const lastChild = [...parent.children]
    .reverse()
    .find((c) => c.kind !== 'block');
  if (lastChild) return makeNewNode(doc, parent, lastChild);
  if (parent.kind === 'root') {
    return createNode({ kind: 'heading', level: 1, blankBefore: true });
  }
  if (parent.kind === 'list') {
    return createNode({
      kind: 'list',
      marker: parent.ordered ? doc.bullet : parent.marker,
    });
  }
  return createNode({ kind: 'list', marker: doc.bullet });
}

export function addChild(doc: MDoc, parent: MNode, text = ''): MNode {
  const node = makeNewNode(doc, parent);
  node.text = text;
  // Keep list items before sub-headings so they stay under `parent`.
  let index = parent.children.length;
  if (node.kind !== 'heading') {
    const firstHeading = parent.children.findIndex((c) => c.kind === 'heading');
    if (firstHeading >= 0) index = firstHeading;
  }
  attach(parent, node, index);
  adoptKind(doc, node);
  parent.fold = false;
  return node;
}

export function addSibling(
  doc: MDoc,
  node: MNode,
  before = false,
  text = '',
): MNode | null {
  const parent = node.parent;
  if (!parent) return null;
  const sibling = makeNewNode(doc, parent, node);
  sibling.text = text;
  const index = parent.children.indexOf(node);
  attach(parent, sibling, before ? index : index + 1);
  adoptKind(doc, sibling);
  return sibling;
}

/** Wrap `node` in a new parent node. */
export function insertParent(doc: MDoc, node: MNode): MNode | null {
  const parent = node.parent;
  if (!parent) return null;
  const wrapper = makeNewNode(doc, parent, node);
  const index = detach(node);
  attach(parent, wrapper, index);
  attach(wrapper, node);
  return wrapper;
}

export function remove(node: MNode) {
  detach(node);
}

/** Remove a node but keep its children in its place. */
export function removeKeepChildren(node: MNode) {
  const parent = node.parent;
  if (!parent) return;
  const index = detach(node);
  node.children.forEach((child, i) => attach(parent, child, index + i));
  node.children = [];
}

export type DropPosition = 'child' | 'before' | 'after';

export function moveTo(
  doc: MDoc,
  node: MNode,
  target: MNode,
  position: DropPosition,
) {
  if (isAncestor(node, target)) return false;
  if (position !== 'child' && !target.parent) return false;
  if (position === 'child' && target.kind === 'block') return false;
  detach(node);
  if (position === 'child') {
    attach(target, node);
    target.fold = false;
  } else {
    const parent = target.parent!;
    const index = parent.children.indexOf(target);
    attach(parent, node, position === 'before' ? index : index + 1);
  }
  if (node.kind === 'list') {
    const sibling = node.parent!.children.find(
      (c) => c !== node && c.kind === 'list',
    );
    node.blankBefore = !!sibling?.blankBefore;
  }
  adoptKind(doc, node);
  return true;
}

/** Make `node` a child of its previous visible sibling. */
export function indent(
  doc: MDoc,
  node: MNode,
  isVisible: (n: MNode) => boolean,
) {
  const parent = node.parent;
  if (!parent) return false;
  const index = parent.children.indexOf(node);
  const prev = parent.children.slice(0, index).reverse().find(isVisible);
  if (!prev) return false;
  return moveTo(doc, node, prev, 'child');
}

/** Move `node` after its parent. */
export function outdent(doc: MDoc, node: MNode) {
  const parent = node.parent;
  if (!parent?.parent) return false;
  return moveTo(doc, node, parent, 'after');
}

export function moveSibling(
  doc: MDoc,
  node: MNode,
  delta: -1 | 1,
  isVisible: (n: MNode) => boolean,
) {
  const parent = node.parent;
  if (!parent) return false;
  const siblings = parent.children;
  const index = siblings.indexOf(node);
  let j = index + delta;
  while (j >= 0 && j < siblings.length && !isVisible(siblings[j])) j += delta;
  if (j < 0 || j >= siblings.length) return false;
  return moveTo(doc, node, siblings[j], delta < 0 ? 'before' : 'after');
}

export function cloneTree(node: MNode): MNode {
  const copy = createNode({
    ...node,
    id: undefined,
    children: [],
    parent: null,
  });
  copy.id = nextId++;
  copy.extra = [...node.extra];
  node.children.forEach((child) => attach(copy, cloneTree(child)));
  return copy;
}

/** Serialize a subtree as a nested Markdown list (for the clipboard). */
export function subtreeToMarkdown(nodes: MNode[], unit = 2): string {
  const out: string[] = [];
  const emit = (node: MNode, depth: number) => {
    const pad = ' '.repeat(depth * unit);
    if (node.kind === 'block') {
      node.text.split('\n').forEach((line, i) => {
        out.push(i ? `${pad}  ${line}` : `${pad}- ${line}`);
      });
    } else {
      out.push(`${pad}- ${node.text}`);
      node.extra.forEach((line) => out.push(line ? `${pad}  ${line}` : ''));
    }
    node.children.forEach((child) => emit(child, depth + 1));
  };
  nodes.forEach((node) => emit(node, 0));
  return out.join('\n');
}

/**
 * Parse pasted text into nodes. Markdown lists/headings keep their
 * structure; plain text becomes one node per line, nested by indentation.
 */
export function parseFragment(text: string): MNode[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!normalized.trim()) return [];
  const lines = normalized.split('\n');
  const looksLikeMarkdown = lines.some(
    (l) => RE_LIST.test(l) || RE_HEADING.test(l),
  );
  if (looksLikeMarkdown) {
    const fragment = parse(normalized);
    const nodes = fragment.root.children;
    nodes.forEach((n) => (n.parent = null));
    return nodes;
  }
  const root = createNode({ kind: 'root' });
  const stack: { node: MNode; indent: number }[] = [{ node: root, indent: -1 }];
  for (const line of lines) {
    if (!line.trim()) continue;
    const { width } = expandIndent(line);
    while (stack[stack.length - 1].indent >= width) stack.pop();
    const node = createNode({ kind: 'list', text: line.trim() });
    attach(stack[stack.length - 1].node, node);
    stack.push({ node, indent: width });
  }
  root.children.forEach((n) => (n.parent = null));
  return root.children;
}

export function insertNodes(
  doc: MDoc,
  parent: MNode,
  nodes: MNode[],
  index = parent.children.length,
) {
  nodes.forEach((node, i) => {
    attach(parent, node, index + i);
    adoptKind(doc, node);
  });
  parent.fold = false;
}

/**
 * Carry ids and fold states from an old tree to a freshly parsed one, so
 * selection and folding survive external edits (typing in the text editor,
 * undo/redo...).
 */
export function reconcile(oldDoc: MDoc, newDoc: MDoc) {
  const match = (a: MNode, b: MNode) => {
    b.id = a.id;
    b.fold = a.fold;
    const used = new Set<MNode>();
    b.children.forEach((child, i) => {
      let candidate = a.children.find(
        (c) => !used.has(c) && c.kind === child.kind && c.text === child.text,
      );
      if (!candidate) {
        const same = a.children[i];
        if (same && !used.has(same) && same.kind === child.kind) {
          candidate = same;
        }
      }
      if (candidate) {
        used.add(candidate);
        match(candidate, child);
      }
    });
  };
  match(oldDoc.root, newDoc.root);
}

/* ------------------------------------------------------------------------ */
/* Markers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Markers are plain emoji at the start of a node's text (after a task list
 * checkbox), so they show up both in the mindmap and in the Markdown source
 * and can be searched for.
 */
export const MARKERS = ['🔴', '🟡', '🟢'];

const RE_PREFIX = /^(\[[ xX]\]\s+)?((?:(?:🔴|🟡|🟢)️?\s*)*)/u;

export function splitMarker(text: string) {
  const m = RE_PREFIX.exec(text)!;
  const checkbox = m[1] || '';
  const markers = m[2] || '';
  return {
    checkbox,
    marker: MARKERS.find((k) => markers.includes(k)) ?? null,
    /** Checkbox and markers, i.e. what precedes the actual text. */
    prefix: m[0],
    rest: text.slice(m[0].length),
  };
}

/** Replace the marker of `text` (`null` removes it). */
export function setMarker(text: string, marker: string | null) {
  const { checkbox, rest } = splitMarker(text);
  return checkbox + (marker ? `${marker} ` : '') + rest;
}

/* ------------------------------------------------------------------------ */
/* Topic text as typed by the user                                           */
/* ------------------------------------------------------------------------ */

/**
 * Number of list item continuation lines that belong to its first paragraph,
 * i.e. the lines shown (and edited) as the topic text.
 */
function paragraphLength(node: MNode) {
  let n = 0;
  while (n < node.extra.length) {
    const line = node.extra[n];
    if (!line.trim() || /^ {4}/.test(line) || matchFenceOpen(line)) break;
    n += 1;
  }
  return n;
}

const RE_BR = /<br\s*\/?>/i;
/** Code spans and math keep their content verbatim. */
const RE_VERBATIM = /(`+)[\s\S]*?\1|\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g;

function mapOutsideVerbatim(text: string, fn: (part: string) => string) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(RE_VERBATIM)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Raw HTML tags already present in the source; they are kept as HTML. */
function rawTags(text: string) {
  const tags: string[] = [];
  mapOutsideVerbatim(text, (part) => {
    for (const m of part.matchAll(
      /(^|[^\\])(<\/?[A-Za-z][^<>]*>|<!--.*?-->)/g,
    )) {
      tags.push(m[2]);
    }
    return part;
  });
  return tags;
}

/** Escape characters that would turn the line into a block (quote, list...). */
function escapeLineStart(line: string) {
  if (
    /^(>|#{1,6}(\s|$)|[-*+](\s|$)|`{3,}|~{3,}|=+\s*$)/.test(line) ||
    RE_HR.test(line)
  ) {
    return `\\${line}`;
  }
  const m = /^(\d{1,9})([.)](\s|$))/.exec(line);
  return m ? `${m[1]}\\${line.slice(m[1].length)}` : line;
}

function unescapeLineStart(line: string) {
  const candidates = [line.replace(/^\\/, ''), line.replace(/^(\d+)\\/, '$1')];
  return (
    candidates.find((c) => c !== line && escapeLineStart(c) === line) ?? line
  );
}

function escapeText(line: string, keep: string[], heading: boolean) {
  let text = mapOutsideVerbatim(line, (part) =>
    part.replace(/<(?=[A-Za-z/!?])|&(?=#?\w+;)/g, (ch, offset: number) =>
      ch === '<' && keep.some((tag) => part.startsWith(tag, offset))
        ? ch
        : `\\${ch}`,
    ),
  );
  text = escapeLineStart(text);
  // A trailing ` ###` would be read as the closing sequence of the heading.
  if (heading) text = text.replace(/(\s)(#+)$/, '$1\\$2');
  return text;
}

function unescapeText(line: string, heading: boolean) {
  let text = heading ? line.replace(/(\s)\\(#+)$/, '$1$2') : line;
  text = unescapeLineStart(text);
  return mapOutsideVerbatim(text, (part) =>
    part.replace(/\\(<(?=[A-Za-z/!?])|&(?=#?\w+;))/g, '$1'),
  );
}

/**
 * The text of a topic as shown in the inline editor: special characters
 * unescaped, one line per line break.
 */
export function getEditText(node: MNode): string {
  if (node.kind === 'block' || node.kind === 'root') return node.text;
  const heading = node.kind === 'heading';
  const lines = heading
    ? [node.text]
    : [node.text, ...node.extra.slice(0, paragraphLength(node))];
  return lines
    .flatMap((line) => line.split(RE_BR))
    .map((line) => unescapeText(line.trim(), heading))
    .join('\n');
}

/**
 * Set the text of a topic from the inline editor. Characters that Markdown
 * would interpret (`>`, `<tag>`, `- `, `# `...) are escaped so that they are
 * displayed as typed. Line breaks become continuation lines in list items
 * and `<br>` in headings.
 */
export function setEditText(node: MNode, value: string) {
  if (node.kind === 'block' || node.kind === 'root') {
    node.text = value;
    return;
  }
  const heading = node.kind === 'heading';
  const n = heading ? 0 : paragraphLength(node);
  const keep = rawTags([node.text, ...node.extra.slice(0, n)].join('\n'));
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => escapeText(line, keep, heading));
  if (heading) {
    node.text = lines.join('<br>');
  } else {
    node.text = lines[0] || '';
    node.extra = [...lines.slice(1), ...node.extra.slice(n)];
  }
}
