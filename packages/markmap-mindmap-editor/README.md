# Markmap Mindmap Editor (VS Code extension)

Edit Markdown **as a mindmap**, XMind style. The mindmap is the editor: add,
rename, move, fold and delete nodes with the keyboard or mouse. Every change
is written back to the `.md` file (so VS Code undo/redo, save and git all keep
working), and edits made in the text editor show up in the mindmap live.

Rendering uses markmap itself, so math, code highlighting, checkboxes,
tables and frontmatter options (`markmap:` in the frontmatter) look the same
as in markmap.

## Build & install locally

```bash
# from the repository root
npx pnpm@9 install

# build the markmap packages this extension depends on
cd packages/markmap-common      && npx vite build && cd ../..
cd packages/markmap-html-parser && npx vite build && cd ../..
cd packages/markmap-view        && npx vite build && TARGET=es npx vite build && cd ../..
cd packages/markmap-lib         && npx vite build && TARGET=browserEs npx vite build && cd ../..

# build & package the extension
cd packages/markmap-mindmap-editor
node build.mjs
npx vsce package --no-dependencies --allow-missing-repository --skip-license -o markmap-mindmap-editor.vsix

# install it into VS Code
code --install-extension markmap-mindmap-editor.vsix
```

To hack on it instead, open `packages/markmap-mindmap-editor` in VS Code, run
`node build.mjs --watch` and press <kbd>F5</kbd> (Extension Development Host).

## Open a file as a mindmap

- Click the mindmap icon in the editor title bar of any Markdown file, or
- right click a `.md` file in the explorer → **Open as Editable Mindmap**, or
- right click an editor tab → **Reopen Editor With…** → **Markmap Mindmap Editor**.

The **Markdown** toolbar button opens the source side by side.

To always open `*.mm.md` files as mindmaps, add to your settings:

```json
"workbench.editorAssociations": { "*.mm.md": "markmapMindmapEditor.editor" }
```

## Shortcuts

| Key                                     | Action                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| <kbd>Enter</kbd>                        | Add sibling after (on root: add child)                  |
| <kbd>Shift+Enter</kbd>                  | Add sibling before                                      |
| <kbd>Tab</kbd> / <kbd>Insert</kbd>      | Add child                                               |
| <kbd>Ctrl+Enter</kbd>                   | Insert parent                                           |
| <kbd>F2</kbd> / <kbd>Space</kbd> / double click | Edit text                                       |
| just start typing                       | Replace the text of the selected node (IME supported)   |
| <kbd>Enter</kbd> / <kbd>Esc</kbd> while editing | Finish / cancel                                 |
| <kbd>Tab</kbd> while editing            | Finish and add a child                                  |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | Delete node and its children                           |
| <kbd>Ctrl+Delete</kbd>                  | Delete node, keep its children                          |
| Arrow keys                              | Select parent / child / sibling                         |
| <kbd>Home</kbd>                         | Select root                                             |
| <kbd>Alt+↑</kbd> / <kbd>Alt+↓</kbd>     | Move node up / down                                     |
| <kbd>Alt+→</kbd>                        | Indent (become child of previous sibling)               |
| <kbd>Alt+←</kbd> / <kbd>Shift+Tab</kbd> | Outdent                                                 |
| Drag & drop                             | Drop on a node → child; on its top/bottom edge → sibling |
| <kbd>Ctrl+/</kbd>                       | Collapse / expand node                                  |
| <kbd>Ctrl+Shift+/</kbd>                 | Collapse / expand node recursively                      |
| <kbd>Alt+0</kbd>                        | Expand all                                              |
| <kbd>Alt+1</kbd> … <kbd>Alt+9</kbd>     | Show N levels                                           |
| <kbd>Ctrl+C</kbd> / <kbd>Ctrl+X</kbd> / <kbd>Ctrl+V</kbd> | Copy / cut / paste as child (Markdown list text) |
| <kbd>Ctrl+D</kbd>                       | Duplicate                                               |
| <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd>   | Undo / redo                                             |
| <kbd>Ctrl+=</kbd> / <kbd>Ctrl+-</kbd> / <kbd>Ctrl+0</kbd> | Zoom in / out / fit                   |
| Ctrl + click a link                     | Open the link                                           |
| <kbd>F1</kbd> / <kbd>?</kbd>            | Show shortcuts                                          |

Clicking the circle of a node folds/unfolds it (Ctrl + click: recursively).

## How Markdown is written

- New nodes follow their siblings: next to headings they become headings,
  next to list items they become list items; children of list items are
  nested list items.
- markmap only shows one kind of child under a heading (sub-headings win over
  code blocks/tables, which win over list items). The editor keeps everything
  visible: a list item moved after a heading becomes a heading, a heading
  moved under a list item becomes a list item, and code blocks / tables next
  to new list items are turned into list items containing them.
- Content that markmap does not show as nodes (paragraphs, frontmatter,
  blockquotes...) is kept as-is.
- Folding is a view state and is not written to the file. Initial folding
  still honours `<!-- markmap: fold -->` and `initialExpandLevel`.
