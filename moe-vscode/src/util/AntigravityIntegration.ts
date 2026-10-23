import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface AntigravityApi {
    registerMcpServer?: (server: {
        name: string;
        command: string;
        args: string[];
        cwd: string;
    }) => void;
}

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
        // bundle-assets.mjs flattens dist contents into bundled/proxy/, so
        // bundled/proxy/index.js is the real path. Fall back to the legacy
        // dist/ layout in case the bundling script changes.
        let proxyPath = path.join(extensionPath, 'bundled', 'proxy', 'index.js');
        if (!fs.existsSync(proxyPath)) {
            proxyPath = path.join(extensionPath, 'bundled', 'proxy', 'dist', 'index.js');
        }
        // Antigravity exposes an MCP registration API on the vscode namespace.
        // If the API is not available, this is a no-op.
        const antigravityApi = (vscode as typeof vscode & { antigravity?: AntigravityApi }).antigravity;
        if (antigravityApi?.registerMcpServer) {
            antigravityApi.registerMcpServer({
                name: 'moe-proxy',
                command: 'node',
                args: [proxyPath],
                cwd: projectPath,
            });
            outputChannel.appendLine('Registered moe-proxy as Antigravity MCP server');
        }
    } catch (err) {
        let message = 'Unknown error';
        try {
            message = err instanceof Error ? err.message : String(err);
        } catch {
            // A third-party API can throw an object that rejects coercion.
        }
        outputChannel.appendLine(`Antigravity MCP registration failed: ${message}`);
    }
}
