import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Create output channel for displaying command output
let outputChannel: vscode.OutputChannel;

async function fsExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function detectMinPythonVersion(folderUri: vscode.Uri | undefined): Promise<string | null> {
    if (!folderUri) {
        return null;
    }

    if (await fsExists(vscode.Uri.joinPath(folderUri, '.venv'))) {
        return null;
    }

    if (await fsExists(vscode.Uri.joinPath(folderUri, '.python-version'))) {
        return null;
    }

    const pyprojectUri = vscode.Uri.joinPath(folderUri, 'pyproject.toml');
    let content: string;
    try {
        const data = await vscode.workspace.fs.readFile(pyprojectUri);
        content = new TextDecoder().decode(data);
    } catch (e) {
        // no pyproject.toml found or can't read it
        return null;
    }

    // Try to extract project.requires-python value
    // Look for requires-python = "..." (in [project] section or anywhere)
    const reqMatch = content.match(/requires-python\s*=\s*(?:"([^"]+)|'([^']+)'|([^\n#]+))/i);
    const spec = reqMatch ? (reqMatch[1] || reqMatch[2] || reqMatch[3] || '').trim() : '';
    if (!spec) {
        return null;
    }

    // Determine minimal version from the spec string.
    // Only accept a '>=' style minimum (e.g., '>=3.8' or '>=3.8,<4').
    // Do NOT coerce a bare major version like '3' into '3.0'.
    const matched = spec.match(/>=\s*([0-9]+(?:\.[0-9]+){0,2})/);
    return matched ? matched[1] : null;
}

function getConfig() {
    const cfg = vscode.workspace.getConfiguration('uvs');
    return {
        command: cfg.get<string>('command', 'uv sync --frozen'),
        autoEnable: cfg.get<boolean>('autoEnable', true),
        delaySeconds: cfg.get<number>('delaySeconds', 2)
    };
}

async function runSyncCommand(command: string, folderUri?: vscode.Uri) {
    if (!command || command.trim().length === 0) {
        vscode.window.showErrorMessage('uvs: no command configured');
        return;
    }

    let finalCommand = command;
    if (folderUri) {
        // detect minimum Python version if .python-version doesn't exist
        const minVersion = await detectMinPythonVersion(folderUri);
        if (minVersion) {
            // add -p minVersion to command if .python-version doesn't exist
            finalCommand = `${command} -p ${minVersion}`;
        }
    }

    const cwd = folderUri ? folderUri.fsPath : undefined;

    // Log to output channel
    outputChannel.appendLine('='.repeat(60));
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Running: ${finalCommand}`);
    if (cwd) {
        outputChannel.appendLine(`Working directory: ${cwd}`);
    }
    outputChannel.appendLine('='.repeat(60));

    try {
        vscode.window.showInformationMessage(`uvs: Running ${finalCommand}`);
        const { stdout, stderr } = await execAsync(finalCommand, { cwd });

        // Write stdout to output channel
        if (stdout && stdout.trim().length > 0) {
            outputChannel.appendLine(stdout);
        }

        // Write stderr to output channel (uv might output to stderr even on success)
        if (stderr && stderr.trim().length > 0) {
            outputChannel.appendLine(stderr);
        }

        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ✓ Sync completed successfully`);
        vscode.window.showInformationMessage('uvs: Sync completed successfully');
    } catch (err: any) {
        const errorMsg = err.message || String(err);

        // Log error details to output channel
        outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ✗ Sync failed`);
        outputChannel.appendLine(`Error: ${errorMsg}`);
        if (err.stdout) {
            outputChannel.appendLine('--- stdout ---');
            outputChannel.appendLine(err.stdout);
        }
        if (err.stderr) {
            outputChannel.appendLine('--- stderr ---');
            outputChannel.appendLine(err.stderr);
        }

        vscode.window.showErrorMessage(`uvs: Sync failed - ${errorMsg}`);
        console.error('uvs error', err);
    }

}

export function activate(context: vscode.ExtensionContext) {
    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel('uvs');
    context.subscriptions.push(outputChannel);

    const cfg = getConfig();

    const disposable = vscode.commands.registerCommand('uvs.syncNow', async () => {
        const c = getConfig();
        // choose active workspace folder if available
        const folderUri = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri
            : undefined;
        await runSyncCommand(c.command, folderUri);
    });
    context.subscriptions.push(disposable);

    // If workspace contains pyproject.toml and autoEnable is true, run after delay
    if (cfg.autoEnable) {
        const delay = Math.max(0, cfg.delaySeconds || 0) * 1000;
        setTimeout(async () => {
            // verify pyproject.toml exists in workspace and remember folder
            const folders = vscode.workspace.workspaceFolders;
            let found = false;
            let foundFolderUri: vscode.Uri | undefined;
            if (folders) {
                for (const folder of folders) {
                    const uri = vscode.Uri.joinPath(folder.uri, 'pyproject.toml');
                    const lockUri = vscode.Uri.joinPath(folder.uri, 'uv.lock');
                    if (await fsExists(uri) && await fsExists(lockUri)) {
                        found = true;
                        foundFolderUri = folder.uri;
                        break;
                    }
                }
            }

            if (found && foundFolderUri) {
                // run in the folder where pyproject.toml was found
                await runSyncCommand(cfg.command, foundFolderUri);
            } else {
                // If extension was activated by onStartupFinished and not workspaceContains, be quiet.
            }
        }, delay);
    }
}
