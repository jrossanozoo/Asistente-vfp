import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

const CONFLICTING_EXTENSIONS: { id: string; message: string }[] = [
  {
    id: 'zoo-logic.vsc-f12-vfp',
    message:
      'Asistente VFP: la extensión "vsc-f12-vfp" está instalada y toma la tecla F12. Conviene desinstalarla: Asistente VFP ya provee Go to Definition.',
  },
  {
    id: 'local.asistente-vfp-zoo',
    message:
      'Asistente VFP: también está instalada "Asistente VFP Zoo", que ya incluye todo lo de esta extensión. Desactivá una de las dos para no ver resultados duplicados.',
  },
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'foxpro' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{prg,PRG,Prg}'),
    },
    initializationOptions: {
      storagePath: context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
    },
  };
  client = new LanguageClient('asistenteVfp', 'Asistente VFP', serverOptions, clientOptions);

  context.subscriptions.push(
    vscode.commands.registerCommand('asistenteVfp.reindex', async () => {
      if (!client) return;
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Asistente VFP: reindexando' },
        () => client!.sendRequest<{ files: number }>('asistenteVfp/reindex'),
      );
      vscode.window.showInformationMessage(`Asistente VFP: ${result.files} archivos indexados.`);
    }),
  );

  for (const c of CONFLICTING_EXTENSIONS) {
    if (vscode.extensions.getExtension(c.id)) void vscode.window.showWarningMessage(c.message);
  }

  await client.start();
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
