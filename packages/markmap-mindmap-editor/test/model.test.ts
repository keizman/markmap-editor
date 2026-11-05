import { Transformer } from 'markmap-lib';
import { describe, expect, test } from 'vitest';
import {
  MDoc,
  MNode,
  addChild,
  addSibling,
  findById,
  indent,
  isHiddenByMarkmap,
  insertParent,
  moveSibling,
  moveTo,
  outdent,
  parse,
  parseFragment,
  reconcile,
  remove,
  serialize,
  setMarker,
  splitMarker,
  subtreeToMarkdown,
} from '../src/model';

const transformer = new Transformer();

function shape(node: MNode): any {
  return {
    t: node.kind === 'block' ? `[${node.kind}]` : node.text,
    c: node.children.map(shape),
  };
}

/** Collect markmap nodes as `line -> parentLine`. */
function markmapParents(text: string) {
  const { root } = transformer.transform(text);
  const result = new Map<number, number>();
  const visit = (node: any, parentLine: number) => {
    const line = node.payload?.lines
      ? parseInt(`${node.payload.lines}`, 10)
      : -1;
    if (line >= 0) result.set(line, parentLine);
    node.children?.forEach((child: any) =>
      visit(child, line >= 0 ? line : parentLine),
    );
  };
  visit(root, -1);
  return result;
}

/** Every non-block model node must be a markmap node with the same parent. */
function expectConsistent(doc: MDoc, text: string) {
  const parents = markmapParents(text);
  const visit = (node: MNode, parentLine: number) => {
    if (isHiddenByMarkmap(node)) {
      expect(parents.has(node.line)).toBe(false);
      return;
    }
    if (node.kind === 'heading' || node.kind === 'list') {
      expect(parents.get(node.line), `line ${node.line}: ${node.text}`).toBe(
        parentLine,
      );
    }
    node.children.forEach((child) =>
      visit(child, node.kind === 'root' ? -1 : node.line),
    );
  };
  // markmap removes an empty root that has a single child
  const top = doc.root.children.filter((c) => c.kind !== 'block');
  if (top.length === 1) {
    visit(top[0], -1);
  } else {
    doc.root.children.forEach((child) => visit(child, -1));
  }
}

const SAMPLE = `---
title: markmap
markmap:
  colorFreezeLevel: 2
---

# Root

Some paragraph that is not a node.

## Branch A

- item 1
  - item 1.1
  - item 1.2
- item 2

  continued paragraph

    \`\`\`js
    console.log('hi');
    \`\`\`
- item 3

## Branch B

1. one
2. two
   - two.a

\`\`\`py
# not a heading
print(1)
\`\`\`

### Deep
`;

describe('parse / serialize', () => {
  test('round trip keeps the structure', () => {
    const doc = parse(SAMPLE);
    const text = serialize(doc);
    const again = parse(text);
    expect(shape(again.root)).toEqual(shape(doc.root));
    expect(serialize(again)).toBe(text);
    expect(text).toContain('colorFreezeLevel: 2');
    expect(text).toContain('Some paragraph that is not a node.');
    expect(text).toContain("console.log('hi');");
    expect(text).toContain('# not a heading');
  });

  test('model lines match markmap nodes', () => {
    const doc = parse(SAMPLE);
    expectConsistent(doc, SAMPLE);
    const text = serialize(doc);
    expectConsistent(doc, text);
  });

  test('keeps CRLF and 4-space indents', () => {
    const src = '# A\r\n\r\n* x\r\n    * y\r\n';
    const doc = parse(src);
    expect(serialize(doc)).toBe(src);
  });
});

describe('operations', () => {
  const build = () =>
    parse(`# Root

## A

- a1
- a2

## B
`);

  test('add sibling / child', () => {
    const doc = build();
    const a = doc.root.children[0].children[0];
    const a1 = a.children[0];
    const s = addSibling(doc, a1, false, 'a1.5')!;
    expect(s.kind).toBe('list');
    const c = addChild(doc, a1, 'child')!;
    expect(c.kind).toBe('list');
    const b2 = addSibling(doc, doc.root.children[0].children[1], false, 'C')!;
    expect(b2.kind).toBe('heading');
    const text = serialize(doc);
    expect(text).toBe(`# Root

## A

- a1
  - child
- a1.5
- a2

## B

## C
`);
    expectConsistent(doc, text);
  });

  test('child of a heading goes before its sub-headings', () => {
    const doc = build();
    const root = doc.root.children[0];
    addChild(doc, root, 'note');
    const text = serialize(doc);
    expect(text.indexOf('- note')).toBeLessThan(text.indexOf('## A'));
    expectConsistent(doc, text);
  });

  test('move a heading under a list item turns it into a list item', () => {
    const doc = build();
    const root = doc.root.children[0];
    const [a, b] = root.children;
    moveTo(doc, b, a.children[1], 'child');
    const text = serialize(doc);
    expect(text).toContain('- a2\n  - B');
    expectConsistent(doc, text);
  });

  test('list item moved after a heading sibling becomes a heading', () => {
    const doc = build();
    const root = doc.root.children[0];
    const a1 = root.children[0].children[0];
    moveTo(doc, a1, root.children[1], 'after');
    const text = serialize(doc);
    expect(text).toContain('## a1');
    expectConsistent(doc, text);
  });

  test('indent / outdent / move / insert parent / remove', () => {
    const doc = build();
    const root = doc.root.children[0];
    const a = root.children[0];
    const [a1, a2] = a.children;
    const visible = () => true;
    expect(indent(doc, a2, visible)).toBe(true);
    expect(a2.parent).toBe(a1);
    expect(outdent(doc, a2)).toBe(true);
    expect(a2.parent).toBe(a);
    expect(moveSibling(doc, a2, -1, visible)).toBe(true);
    expect(a.children[0]).toBe(a2);
    const p = insertParent(doc, a2)!;
    p.text = 'wrap';
    expect(a2.parent).toBe(p);
    let text = serialize(doc);
    expect(text).toContain('- wrap\n  - a2\n- a1');
    expectConsistent(doc, text);
    remove(p);
    text = serialize(doc);
    expect(text).not.toContain('wrap');
    expect(findById(doc, a2.id)).toBeUndefined();
  });

  test('clipboard round trip', () => {
    const doc = build();
    const a = doc.root.children[0].children[0];
    const md = subtreeToMarkdown([a]);
    expect(md).toBe('- A\n  - a1\n  - a2');
    const nodes = parseFragment(md);
    expect(shape(nodes[0])).toEqual(shape(a));
    const plain = parseFragment('x\n  y\n  z\nw');
    expect(plain.map(shape)).toEqual([
      {
        t: 'x',
        c: [
          { t: 'y', c: [] },
          { t: 'z', c: [] },
        ],
      },
      { t: 'w', c: [] },
    ]);
  });

  test('list items next to code blocks and tables stay visible', () => {
    const lines = (...l: string[]) => l.join('\n') + '\n';
    const fence = '`'.repeat(3);
    const doc = parse(
      lines(
        '# R',
        '',
        '## B',
        '',
        `${fence}js`,
        'x',
        fence,
        '',
        '| x | y |',
        '|---|---|',
        '| 1 | 2 |',
      ),
    );
    const b = doc.root.children[0].children[0];
    addChild(doc, b, 'a1');
    const text = serialize(doc);
    expect(text).toBe(
      lines(
        '# R',
        '',
        '## B',
        '',
        `- ${fence}js`,
        '  x',
        `  ${fence}`,
        '- | x | y |',
        '  |---|---|',
        '  | 1 | 2 |',
        '- a1',
      ),
    );
    expectConsistent(doc, text);
    expect(markmapParents(text).size).toBe(5);
  });

  test('a child of a heading with sub-headings is a heading', () => {
    const doc = build();
    const node = addChild(doc, doc.root.children[0], 'C');
    expect(node.kind).toBe('heading');
    expect(serialize(doc)).toContain(['## B', '', '## C', ''].join('\n'));
  });

  test('empty document', () => {
    const doc = parse('');
    const node = addChild(doc, doc.root, 'Hello');
    expect(node.kind).toBe('heading');
    expect(serialize(doc)).toBe('# Hello\n');
  });

  test('markers', () => {
    expect(setMarker('task', '🔴')).toBe('🔴 task');
    expect(setMarker('🔴 task', '🟢')).toBe('🟢 task');
    expect(setMarker('🔴 🟡 task', null)).toBe('task');
    expect(setMarker('[ ] task', '🟡')).toBe('[ ] 🟡 task');
    expect(splitMarker('[x] 🟢 done')).toMatchObject({
      checkbox: '[x] ',
      marker: '🟢',
      prefix: '[x] 🟢 ',
      rest: 'done',
    });
    expect(splitMarker('plain').marker).toBeNull();
    const doc = parse('# R\n\n- [ ] 🔴 a\n');
    const text = serialize(doc);
    expect(text).toContain('- [ ] 🔴 a');
    expectConsistent(doc, text);
  });

  test('reconcile keeps ids and folds', () => {
    const doc = build();
    const a = doc.root.children[0].children[0];
    a.fold = true;
    const next = parse(serialize(doc).replace('a2', 'a2!'));
    reconcile(doc, next);
    const a2 = next.root.children[0].children[0];
    expect(a2.id).toBe(a.id);
    expect(a2.fold).toBe(true);
  });
});
