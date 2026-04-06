import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Detect whether the extension is running inside Antigravity (VS Code fork)
 * rather than vanilla VS Code.
 */
export function isAntigravity(): boolean {
    return vscode.env.appName?.toLowerCase().includes('antigravity') ?? false;
}

/**
 * Register the moe-proxy as an MCP server in Antigravity's MCP registry.
 * No-op on vanilla VS Code.
 */
export function registerMcpServer(
    extensionPath: string,
    projectPath: string,
    outputChannel: vscode.OutputChannel
): void {
    try {
        const proxyPath = path.join(extensionPath, 'bundled', 'proxy', 'dist', 'index.js');
        // Antigravity exposes an MCP registration API on the vscode namespace.
        // If the API is not available, this is a no-op.
        const antigravityApi = (vscode as any).antigravity;
        if (antigravityApi?.registerMcpServer) {
            antigravityApi.registerMcpServer({
                name: 'moe-proxy',
                command: 'node',
                args: [proxyPath],
                cwd: projectPath,
            });
            outputChannel.appendLine('Registered moe-proxy as Antigravity MCP server');
        }
    } catch (err: any) {
        outputChannel.appendLine(`Antigravity MCP registration failed: ${err.message}`);
    }
}
