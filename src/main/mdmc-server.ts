/**
 * MDMC – Mobile Device Management Server (v1.1.27)
 * WebSocket server on port 4242 for remote client management.
 */

import * as crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { ClientSysInfo, MDMCClient } from '../shared/types';

// ─── WireGuard Key Generation ─────────────────────────────────────────────────

export function generateWireGuardKeys(): { privateKey: string; publicKey: string } {
  const { privateKey: privDer, publicKey: pubDer } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  // PKCS8 DER: raw key bytes at offset 16-48; SPKI DER: raw key bytes at offset 12-44
  return {
    privateKey: (privDer as unknown as Buffer).subarray(16, 48).toString('base64'),
    publicKey: (pubDer as unknown as Buffer).subarray(12, 44).toString('base64'),
  };
}

// ─── Connected Clients ────────────────────────────────────────────────────────

interface ConnectedClient {
  ws: WebSocket;
  clientId: string;
  platform?: string;
  hostname?: string;
  sysinfo?: ClientSysInfo;
  lastSeen: Date;
}

export const connectedClients = new Map<string, ConnectedClient>();

// Map of authToken → clientId for authentication
const tokenToClient = new Map<string, string>();

export type MDMCEventType = 'client-connected' | 'client-disconnected' | 'sysinfo-updated' | 'pty-data' | 'pty-exit';
export type MDMCEventHandler = (event: { type: MDMCEventType; clientId: string; data?: unknown }) => void;

// ─── WebSocket Server ─────────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let eventHandler: MDMCEventHandler | null = null;

export function startMDMCServer(
  port: number,
  clients: MDMCClient[],
  onEvent: MDMCEventHandler
): { success: boolean; port: number; error?: string } {
  if (wss) {
    return { success: true, port };
  }

  // Build token → clientId lookup
  tokenToClient.clear();
  for (const c of clients) {
    tokenToClient.set(c.authToken, c.id);
  }

  eventHandler = onEvent;

  try {
    wss = new WebSocketServer({ port, host: '0.0.0.0' });

    wss.on('connection', (ws) => {
      let authenticated = false;
      let clientId = '';

      ws.on('message', (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (!authenticated) {
          // Expect hello message
          if (msg.type === 'hello' && typeof msg.token === 'string') {
            const cid = tokenToClient.get(msg.token);
            if (!cid) {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
              ws.close();
              return;
            }
            authenticated = true;
            clientId = cid;

            connectedClients.set(clientId, {
              ws,
              clientId,
              platform: typeof msg.platform === 'string' ? msg.platform : undefined,
              hostname: typeof msg.hostname === 'string' ? msg.hostname : undefined,
              lastSeen: new Date(),
            });

            ws.send(JSON.stringify({ type: 'hello-ok', clientId }));
            eventHandler?.({ type: 'client-connected', clientId });
          }
          return;
        }

        // Authenticated messages
        const conn = connectedClients.get(clientId);
        if (!conn) return;
        conn.lastSeen = new Date();

        if (msg.type === 'sysinfo') {
          conn.sysinfo = msg as unknown as ClientSysInfo;
          eventHandler?.({ type: 'sysinfo-updated', clientId, data: conn.sysinfo });
        } else if (msg.type === 'pty-data') {
          eventHandler?.({ type: 'pty-data', clientId, data: { ptyId: msg.ptyId, data: msg.data } });
        } else if (msg.type === 'pty-exit') {
          eventHandler?.({ type: 'pty-exit', clientId, data: { ptyId: msg.ptyId, code: msg.code } });
        }
      });

      ws.on('close', () => {
        if (clientId) {
          connectedClients.delete(clientId);
          eventHandler?.({ type: 'client-disconnected', clientId });
        }
      });

      ws.on('error', () => {
        if (clientId) {
          connectedClients.delete(clientId);
          eventHandler?.({ type: 'client-disconnected', clientId });
        }
      });
    });

    wss.on('error', (err: Error) => {
      console.error('[MDMC] WebSocket server error:', err.message);
    });

    return { success: true, port };
  } catch (err) {
    wss = null;
    return { success: false, port, error: (err as Error).message };
  }
}

export function stopMDMCServer(): void {
  if (wss) {
    wss.close();
    wss = null;
    connectedClients.clear();
    tokenToClient.clear();
  }
}

export function sendToClient(clientId: string, msg: object): boolean {
  const conn = connectedClients.get(clientId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
  try {
    conn.ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

export function getConnectedClientIds(): string[] {
  return Array.from(connectedClients.keys());
}

export function getClientSysinfo(clientId: string): ClientSysInfo | null {
  return connectedClients.get(clientId)?.sysinfo ?? null;
}

export function registerClientToken(authToken: string, clientId: string): void {
  tokenToClient.set(authToken, clientId);
}

export function isServerRunning(): boolean {
  return wss !== null;
}

// ─── Client Package Generator ─────────────────────────────────────────────────

export function generateClientPackage(opts: {
  client: MDMCClient;
  clientPrivateKey: string;
  serverPubKey: string;
  serverEndpoint: string;  // e.g. "46.224.52.87:51820"
  macWgIp: string;
  wsPort: number;
}): { wgConf: string; agentJs: string; installSh: string; installPs1: string } {
  const { client, clientPrivateKey, serverPubKey, serverEndpoint, macWgIp, wsPort } = opts;

  // WireGuard client config
  const wgConf = `[Interface]
PrivateKey = ${clientPrivateKey}
Address = ${client.wgIp}/32
DNS = 1.1.1.1

[Peer]
PublicKey = ${serverPubKey}
Endpoint = ${serverEndpoint}
AllowedIPs = 10.0.0.0/24
PersistentKeepalive = 25
`;

  // Node.js agent script
  const agentJs = `#!/usr/bin/env node
/**
 * Claude MC Agent – Remote Client
 * Auto-generated for: ${client.name}
 * Platform: ${client.platform}
 */

const WebSocket = require('ws');
const { execSync, spawn } = require('child_process');
const os = require('os');

const CONFIG = {
  serverUrl: 'ws://${macWgIp}:${wsPort}',
  authToken: '${client.authToken}',
  platform: '${client.platform}',
  hostname: os.hostname(),
};

let ws;
let reconnectTimer;
const activePtys = {};

function getSysinfo() {
  try {
    const cpus = os.cpus();
    const totalMem = Math.round(os.totalmem() / 1024 / 1024);
    const freeMem = Math.round(os.freemem() / 1024 / 1024);

    // CPU usage (simple approximation)
    let cpu = 0;
    try {
      if (process.platform === 'linux') {
        const stat = require('fs').readFileSync('/proc/stat', 'utf8').split('\\n')[0].split(' ').slice(1).map(Number);
        const idle = stat[3];
        const total = stat.reduce((a, b) => a + b, 0);
        cpu = Math.round(100 - (idle / total) * 100);
      } else if (process.platform === 'darwin') {
        const out = execSync('top -l 1 -s 0 | grep "CPU usage"', { encoding: 'utf8', timeout: 3000 });
        const m = out.match(/(\\d+\\.\\d+)% idle/);
        if (m) cpu = Math.round(100 - parseFloat(m[1]));
      }
    } catch {}

    // Disk info
    let disk = [];
    try {
      if (process.platform !== 'win32') {
        const dfOut = execSync('df -BG / 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        const lines = dfOut.trim().split('\\n').slice(1);
        disk = lines.map(line => {
          const parts = line.trim().split(/\\s+/);
          return {
            mount: parts[5] || '/',
            used: parseInt(parts[2]) || 0,
            total: parseInt(parts[1]) || 0,
          };
        }).filter(d => d.total > 0);
      }
    } catch {}

    return {
      hostname: CONFIG.hostname,
      os: process.platform + ' ' + os.release(),
      cpu,
      mem: { used: totalMem - freeMem, total: totalMem },
      disk,
      uptime: Math.round(os.uptime()),
    };
  } catch (err) {
    return { hostname: CONFIG.hostname, os: process.platform, cpu: 0, mem: { used: 0, total: 0 }, disk: [], uptime: 0 };
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log('[Agent] Connecting to', CONFIG.serverUrl);
  ws = new WebSocket(CONFIG.serverUrl);

  ws.on('open', () => {
    console.log('[Agent] Connected, authenticating...');
    ws.send(JSON.stringify({
      type: 'hello',
      token: CONFIG.authToken,
      platform: CONFIG.platform,
      hostname: CONFIG.hostname,
    }));

    // Send sysinfo every 30s
    const sysinfoInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(sysinfoInterval);
        return;
      }
      ws.send(JSON.stringify({ type: 'sysinfo', ...getSysinfo() }));
    }, 30000);

    // Send initial sysinfo after 2s
    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'sysinfo', ...getSysinfo() }));
      }
    }, 2000);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'hello-ok') {
      console.log('[Agent] Authenticated, client ID:', msg.clientId);
    } else if (msg.type === 'exec-pty') {
      startPty(msg.ptyId, msg.cols || 80, msg.rows || 24);
    } else if (msg.type === 'pty-input') {
      const pty = activePtys[msg.ptyId];
      if (pty) pty.stdin.write(msg.data);
    } else if (msg.type === 'pty-resize') {
      // resize not easily supported in raw child_process, skip
    } else if (msg.type === 'error') {
      console.error('[Agent] Server error:', msg.message);
    }
  });

  ws.on('close', () => {
    console.log('[Agent] Disconnected, reconnecting in 10s...');
    reconnectTimer = setTimeout(connect, 10000);
  });

  ws.on('error', (err) => {
    console.error('[Agent] Error:', err.message);
  });
}

function startPty(ptyId, cols, rows) {
  const shell = process.platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/bash');
  console.log('[Agent] Opening PTY', ptyId, 'shell:', shell);

  try {
    const proc = spawn(shell, [], {
      env: { ...process.env, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activePtys[ptyId] = proc;

    proc.stdout.on('data', (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pty-data', ptyId, data: data.toString('base64') }));
      }
    });

    proc.stderr.on('data', (data) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pty-data', ptyId, data: data.toString('base64') }));
      }
    });

    proc.on('exit', (code) => {
      delete activePtys[ptyId];
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pty-exit', ptyId, code: code || 0 }));
      }
    });
  } catch (err) {
    console.error('[Agent] Failed to start PTY:', err.message);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pty-exit', ptyId, code: 1 }));
    }
  }
}

// Start
connect();

process.on('SIGINT', () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit(0);
});
`;

  // install.sh for macOS/Linux
  const installSh = `#!/bin/bash
# Claude MC Agent Installer
# Client: ${client.name}
# Platform: ${client.platform}

set -e

echo "=== Claude MC Agent Installer ==="
echo "Client: ${client.name}"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js ist nicht installiert."
  echo "Bitte installieren: https://nodejs.org"
  exit 1
fi

echo "Node.js: $(node --version)"

# Install ws dependency
AGENT_DIR="$HOME/.claudemc-agent"
mkdir -p "$AGENT_DIR"

cp agent.js "$AGENT_DIR/"
cd "$AGENT_DIR"

echo "Installiere Abhängigkeiten..."
npm install ws --save --quiet

# Setup WireGuard (optional, skip if wg not available)
if command -v wg &> /dev/null && [ -f "../wg-claudemc.conf" ]; then
  echo ""
  echo "WireGuard-Konfiguration wird kopiert..."
  if [ "$(uname)" = "Darwin" ]; then
    sudo cp ../wg-claudemc.conf /etc/wireguard/claudemc.conf
    sudo wg-quick up claudemc 2>/dev/null || echo "WG-Tunnel konnte nicht gestartet werden (ggf. manuell starten)"
  elif [ "$(uname)" = "Linux" ]; then
    sudo cp ../wg-claudemc.conf /etc/wireguard/claudemc.conf
    sudo chmod 600 /etc/wireguard/claudemc.conf
    sudo systemctl enable wg-quick@claudemc 2>/dev/null || true
    sudo systemctl start wg-quick@claudemc 2>/dev/null || sudo wg-quick up claudemc 2>/dev/null || echo "WG-Tunnel konnte nicht gestartet werden"
  fi
else
  echo "(WireGuard übersprungen – wg-claudemc.conf nicht gefunden oder wg nicht installiert)"
fi

echo ""
echo "Starte Agent..."
node agent.js &
AGENT_PID=$!

echo "Agent gestartet (PID: $AGENT_PID)"
echo ""
echo "Um den Agent dauerhaft zu starten, füge folgendes zur crontab hinzu:"
echo "  @reboot cd $AGENT_DIR && node agent.js"
echo ""
echo "=== Installation abgeschlossen ==="
`;

  // install.ps1 for Windows
  const installPs1 = `# Claude MC Agent Installer (Windows)
# Client: ${client.name}
# Platform: windows

$AgentDir = "$env:USERPROFILE\\.claudemc-agent"
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null

Write-Host "=== Claude MC Agent Installer ===" -ForegroundColor Cyan
Write-Host "Client: ${client.name}"
Write-Host ""

# Check Node.js
try {
    $nodeVersion = node --version 2>&1
    Write-Host "Node.js: $nodeVersion"
} catch {
    Write-Host "ERROR: Node.js ist nicht installiert." -ForegroundColor Red
    Write-Host "Bitte installieren: https://nodejs.org"
    exit 1
}

# Copy agent
Copy-Item "agent.js" "$AgentDir\\" -Force
Set-Location $AgentDir

# Install ws
Write-Host "Installiere Abhängigkeiten..."
npm install ws --save --quiet

Write-Host ""
Write-Host "Starte Agent..."
Start-Process -FilePath "node" -ArgumentList "agent.js" -WorkingDirectory $AgentDir -WindowStyle Minimized

Write-Host "Agent gestartet!" -ForegroundColor Green
Write-Host ""
Write-Host "=== Installation abgeschlossen ===" -ForegroundColor Cyan
`;

  return { wgConf, agentJs, installSh, installPs1 };
}
