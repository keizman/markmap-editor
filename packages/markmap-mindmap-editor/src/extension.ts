import * as vscode from 'vscode';

const VIEW_TYPE = 'markmapMindmapEditor.editor';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'openText' }
  | { type: 'openLink'; href: string };

class MindmapEditorProvider implements vscode.CustomTextEditorProvider {
  static active: vscode.TextDocument | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const { webview } = panel;
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const roots = [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      docDir,
    ];
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (folder) roots.push(folder.uri);
    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = this.getHtml(webview, docDir);

    // Texts produced by the webview that are still being applied. Change
    // events carrying them must not be echoed back.
    const pending: string[] = [];
    let queue = Promise.resolve();

    const post = () =>
      webview.postMessage({ type: 'update', text: document.getText() });

    const applyEdit = async (text: string) => {
      if (text === document.getText()) return;
      pending.push(text);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        text,
      );
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        pending.splice(pending.indexOf(text), 1);
        post();
      }
    };

    const disposables: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        if (!e.contentChanges.length) return;
        const text = document.getText();
        const index = pending.indexOf(text);
        if (index >= 0) {
          pending.splice(0, index + 1);
          return;
        }
        post();
      }),
      webview.onDidReceiveMessage((msg: WebviewMessage) => {
        switch (msg.type) {
          case 'ready':
            post();
            break;
          case 'edit':
            queue = queue.then(() => applyEdit(msg.text)).catch(console.error);
            break;
          case 'openText':
            vscode.window.showTextDocument(document, {
              viewColumn: vscode.ViewColumn.Beside,
            });
            break;
          case 'openLink':
            openLink(msg.href, docDir);
            break;
        }
      }),
      panel.onDidChangeViewState(() => {
        if (panel.active) MindmapEditorProvider.active = document;
      }),
    ];
    MindmapEditorProvider.active = document;
    panel.onDidDispose(() => {
      if (MindmapEditorProvider.active === document) {
        MindmapEditorProvider.active = undefined;
      }
      disposables.forEach((d) => d.dispose());
    });
  }

  private getHtml(webview: vscode.Webview, docDir: vscode.Uri) {
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(dist, 'webview.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(dist, 'webview.css'),
    );
    const base = webview.asWebviewUri(docDir).toString().replace(/\/?$/, '/');
    const nonce = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 36).toString(36),
    ).join('');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} https: 'unsafe-inline'`,
      `font-src ${webview.cspSource} https: data:`,
      `script-src 'nonce-${nonce}' https:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${base}">
<link rel="stylesheet" href="${style}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function openLink(href: string, docDir: vscode.Uri) {
  if (/^[a-z][\w+.-]*:/i.test(href) && !href.startsWith('vscode-webview:')) {
    vscode.env.openExternal(vscode.Uri.parse(href));
    return;
  }
  const [path] = href.split('#');
  if (!path) return;
  vscode.commands.executeCommand(
    'vscode.open',
    vscode.Uri.joinPath(docDir, decodeURIComponent(path)),
  );
}

function getTargetUri(uri?: vscode.Uri) {
  if (uri instanceof vscode.Uri) return uri;
  return vscode.window.activeTextEditor?.document.uri;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new MindmapEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    ),
    vscode.commands.registerCommand(
      'markmapMindmapEditor.open',
      (uri?: vscode.Uri) => {
        const target = getTargetUri(uri);
        if (target)
          vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
      },
    ),
    vscode.commands.registerCommand(
      'markmapMindmapEditor.openToSide',
      (uri?: vscode.Uri) => {
        const target = getTargetUri(uri);
        if (target) {
          vscode.commands.executeCommand(
            'vscode.openWith',
            target,
            VIEW_TYPE,
            vscode.ViewColumn.Beside,
          );
        }
      },
    ),
    vscode.commands.registerCommand('markmapMindmapEditor.openText', () => {
      const doc = MindmapEditorProvider.active;
      if (doc) {
        vscode.window.showTextDocument(doc, {
          viewColumn: vscode.ViewColumn.Beside,
        });
      }
    }),
  );
}

export function deactivate() {}
