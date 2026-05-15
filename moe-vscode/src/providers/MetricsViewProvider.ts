import * as vscode from 'vscode';
import { MoeDaemonClient } from '../services/MoeDaemonClient';
import type { MetricsAggregate } from '../types/moe';

/**
 * Metrics view provider — a small webview pinned to the Moe activity-bar
 * container. Polls the daemon every 30s while visible (and on focus) and
 * renders KPI cards + a per-epic breakdown table. Match the BoardViewProvider
 * pattern so styling and lifecycle stay consistent.
 */
export class MetricsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'moe.metrics';
    private static readonly POLL_INTERVAL_MS = 30_000;

    private _view?: vscode.WebviewView;
    private disposed = false;
    private pollTimer: NodeJS.Timeout | undefined;
    private rangeDays: number | null = 30;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly client: MoeDaemonClient
    ) {
        this.disposables.push(
            client.onMetrics((aggregate) => {
                if (this.disposed) { return; }
                this.postAggregate(aggregate);
            })
        );
        this.disposables.push(
            client.onConnectionChanged((status) => {
                if (status === 'connected') {
                    this.requestRefresh();
                }
            })
        );
    }

    dispose(): void {
        this.disposed = true;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.disposables.forEach(d => d.dispose());
        this.disposables.length = 0;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtml();

        webviewView.webview.onDidReceiveMessage((msg) => {
            switch (msg?.type) {
                case 'ready':
                case 'refresh':
                    this.requestRefresh();
                    break;
                case 'setRange':
                    this.rangeDays = typeof msg.days === 'number' ? msg.days : null;
                    this.requestRefresh();
                    break;
            }
        });

        webviewView.onDidDispose(() => {
            this._view = undefined;
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = undefined;
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.requestRefresh();
                this.startPolling();
            } else {
                if (this.pollTimer) {
                    clearInterval(this.pollTimer);
                    this.pollTimer = undefined;
                }
            }
        });

        if (webviewView.visible) {
            this.startPolling();
        }
    }

    private startPolling(): void {
        if (this.pollTimer || this.disposed) { return; }
        this.pollTimer = setInterval(() => {
            if (this.disposed) { return; }
            this.requestRefresh();
        }, MetricsViewProvider.POLL_INTERVAL_MS);
    }

    private requestRefresh(): void {
        if (this.disposed) { return; }
        const sinceIso = this.rangeDays != null
            ? new Date(Date.now() - this.rangeDays * 86_400_000).toISOString()
            : undefined;
        try {
            this.client.listMetrics({ sinceIso });
        } catch {
            // Connection drops are handled by the daemon client; swallow here.
        }
    }

    private postAggregate(aggregate: MetricsAggregate): void {
        this._view?.webview.postMessage({
            type: 'aggregate',
            aggregate,
            rangeDays: this.rangeDays,
            lastUpdated: new Date().toISOString()
        });
    }

    private getHtml(): string {
        const csp = this._view?.webview.cspSource ?? '';
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${csp};">
    <title>Moe Metrics</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-sideBar-background);
            margin: 0;
            padding: 8px;
        }
        .toolbar {
            display: flex;
            gap: 6px;
            align-items: center;
            margin-bottom: 8px;
            flex-wrap: wrap;
        }
        .toolbar-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }
        .range-chip {
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
            cursor: pointer;
            border: 1px solid var(--vscode-panel-border);
            background: transparent;
            color: var(--vscode-foreground);
        }
        .range-chip.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .last-updated {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-left: auto;
        }
        .kpis {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 6px;
            margin-bottom: 12px;
        }
        .kpi-card {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 10px;
            background: var(--vscode-editor-background);
        }
        .kpi-label {
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
        }
        .kpi-value {
            font-size: 18px;
            font-weight: bold;
            margin-top: 2px;
        }
        .section-title {
            font-size: 12px;
            font-weight: bold;
            margin: 8px 0 6px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        table.epics {
            width: 100%;
            border-collapse: collapse;
            font-size: 11px;
        }
        table.epics th {
            text-align: left;
            font-weight: bold;
            color: var(--vscode-descriptionForeground);
            padding: 4px 6px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        table.epics td {
            padding: 3px 6px;
            border-bottom: 1px dashed var(--vscode-panel-border);
        }
        .empty {
            color: var(--vscode-descriptionForeground);
            padding: 8px;
            text-align: center;
            font-style: italic;
        }
    </style>
</head>
<body>
    <div class="toolbar">
        <span class="toolbar-label">Range:</span>
        <button class="range-chip" data-days="7">7d</button>
        <button class="range-chip active" data-days="30">30d</button>
        <button class="range-chip" data-days="">All</button>
        <span class="last-updated" id="lastUpdated"></span>
    </div>
    <div class="kpis">
        <div class="kpi-card"><div class="kpi-label">First-pass approval</div><div class="kpi-value" id="kpiFirstPass">—</div></div>
        <div class="kpi-card"><div class="kpi-label">Avg wall-clock</div><div class="kpi-value" id="kpiWallClock">—</div></div>
        <div class="kpi-card"><div class="kpi-label">Avg reopens</div><div class="kpi-value" id="kpiReopen">—</div></div>
        <div class="kpi-card"><div class="kpi-label">Total completed</div><div class="kpi-value" id="kpiTotal">—</div></div>
    </div>
    <div class="section-title">Per-epic breakdown</div>
    <div id="epicTableWrap">
        <p class="empty">No metrics yet.</p>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function humaniseMs(ms) {
            if (ms == null) { return '—'; }
            if (ms <= 0) { return '0s'; }
            const totalSec = Math.floor(ms / 1000);
            const days = Math.floor(totalSec / 86400);
            const hours = Math.floor((totalSec % 86400) / 3600);
            const minutes = Math.floor((totalSec % 3600) / 60);
            const seconds = totalSec % 60;
            if (days > 0) { return hours > 0 ? days + 'd ' + hours + 'h' : days + 'd'; }
            if (hours > 0) { return minutes > 0 ? hours + 'h ' + minutes + 'm' : hours + 'h'; }
            if (minutes > 0) { return (seconds > 0 && minutes < 5) ? minutes + 'm ' + seconds + 's' : minutes + 'm'; }
            return seconds + 's';
        }

        function escapeHtml(text) {
            if (text == null) { return ''; }
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        document.querySelectorAll('.range-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.range-chip').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const days = btn.getAttribute('data-days');
                vscode.postMessage({ type: 'setRange', days: days === '' ? null : Number(days) });
            });
        });

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg && msg.type === 'aggregate') {
                renderAggregate(msg.aggregate || {}, msg.lastUpdated);
            }
        });

        function renderAggregate(a, lastUpdated) {
            const firstPass = (typeof a.firstPassApprovalPct === 'number')
                ? Math.round(a.firstPassApprovalPct * 100) + '%'
                : '—';
            document.getElementById('kpiFirstPass').textContent = firstPass;
            document.getElementById('kpiWallClock').textContent = humaniseMs(a.avgWallClockMs);
            document.getElementById('kpiReopen').textContent = (typeof a.avgReopenCount === 'number')
                ? a.avgReopenCount.toFixed(1)
                : '—';
            document.getElementById('kpiTotal').textContent = (a.totalCompleted != null)
                ? String(a.totalCompleted)
                : '—';

            const wrap = document.getElementById('epicTableWrap');
            const rows = Array.isArray(a.perEpic) ? a.perEpic : [];
            if (rows.length === 0) {
                wrap.innerHTML = '<p class="empty">No metrics yet.</p>';
            } else {
                let html = '<table class="epics"><thead><tr><th>Epic</th><th>Completed</th><th>Avg reopen</th><th>Avg wall-clock</th></tr></thead><tbody>';
                for (const r of rows) {
                    const title = escapeHtml(r.epicTitle || r.epicId);
                    const avgReopen = (typeof r.avgReopenCount === 'number') ? r.avgReopenCount.toFixed(1) : '—';
                    html += '<tr><td>' + title + '</td><td>' + (r.completed != null ? r.completed : 0) + '</td><td>' + avgReopen + '</td><td>' + escapeHtml(humaniseMs(r.avgWallClockMs)) + '</td></tr>';
                }
                html += '</tbody></table>';
                wrap.innerHTML = html;
            }

            if (lastUpdated) {
                document.getElementById('lastUpdated').textContent = 'Updated ' + new Date(lastUpdated).toLocaleTimeString();
            }
        }

        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
