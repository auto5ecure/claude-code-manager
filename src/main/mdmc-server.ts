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

  // Base64-encode the payloads for embedding in the installer
  const agentJsB64 = Buffer.from(agentJs).toString('base64');
  const wgConfB64 = Buffer.from(wgConf).toString('base64');

  // ── Bundled installer for macOS / Linux ────────────────────────────────────
  // Everything (WG config + agent.js) is embedded as base64 – one file, one run.
  const installSh = `#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║         Claude MC Agent – Bundled Installer          ║
# ║  Client : ${client.name.substring(0, 42).padEnd(42)}  ║
# ║  Platform: ${client.platform.padEnd(41)}  ║
# ╚══════════════════════════════════════════════════════╝
AGENT_DIR="$HOME/.claudemc-agent"
IFACE="claudemc"
SERVER_URL="ws://${macWgIp}:${wsPort}"

echo ""
echo "  Claude MC Agent Installer"
echo "  Client: ${client.name}"
echo "  Server: $SERVER_URL"
echo ""

# ── 1. Node.js prüfen / auto-installieren ─────────────────────────────────
_install_node() {
  echo "  Node.js nicht gefunden – wird automatisch installiert..."
  if [ "$(uname)" = "Darwin" ]; then
    if command -v brew &>/dev/null; then
      brew install node
    else
      echo "  Lade Node.js LTS pkg von nodejs.org..."
      NODE_PKG="/tmp/node-lts.pkg"
      curl -fsSL "https://nodejs.org/dist/latest-v20.x/node-v20.19.0.pkg" -o "$NODE_PKG" 2>/dev/null \
        || curl -fsSL "https://nodejs.org/dist/v20.19.0/node-v20.19.0.pkg" -o "$NODE_PKG"
      sudo installer -pkg "$NODE_PKG" -target / && rm -f "$NODE_PKG"
    fi
    for p in /opt/homebrew/bin /usr/local/bin; do [ -f "$p/node" ] && export PATH="$p:$PATH"; done
  elif [ "$(uname)" = "Linux" ]; then
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y nodejs
    elif command -v yum &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - && sudo yum install -y nodejs
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm nodejs npm
    elif command -v apk &>/dev/null; then
      sudo apk add nodejs npm
    else
      echo "✗ Paketmanager nicht erkannt. Node.js manuell installieren: https://nodejs.org"; return 1
    fi
  fi
}

if ! command -v node &>/dev/null; then
  _install_node || { echo "✗ Node.js Installation fehlgeschlagen. Bitte manuell installieren: https://nodejs.org"; exit 1; }
fi
if ! command -v node &>/dev/null; then
  echo "✗ Node.js nicht gefunden. Bitte manuell installieren: https://nodejs.org"; exit 1
fi
echo "✓ Node.js $(node --version)"

# ── 2. Dateien entpacken ───────────────────────────────────────────────────
mkdir -p "$AGENT_DIR"

# Decode embedded payloads (compatible with macOS + Linux)
_b64_decode() { echo "$1" | base64 -d 2>/dev/null || echo "$1" | base64 -D 2>/dev/null || echo "$1" | python3 -c "import sys,base64; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read()))"; }

_b64_decode "${agentJsB64}" > "$AGENT_DIR/agent.js"
_b64_decode "${wgConfB64}"  > "$AGENT_DIR/wg-claudemc.conf"
chmod 600 "$AGENT_DIR/wg-claudemc.conf"
echo "✓ Dateien entpackt → $AGENT_DIR"

# ── 3. ws npm-Paket installieren ───────────────────────────────────────────
cd "$AGENT_DIR"
if [ ! -d node_modules/ws ]; then
  echo "  Installiere ws..."
  npm install ws --save --quiet 2>/dev/null || npm install ws --save
fi
echo "✓ ws Paket bereit"

# ── 4. WireGuard auto-installieren + einrichten ────────────────────────────
_install_wireguard() {
  echo "  WireGuard nicht gefunden – wird automatisch installiert..."
  if [ "$(uname)" = "Darwin" ]; then
    if ! command -v brew &>/dev/null; then
      echo "  Installiere Homebrew..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      for bp in /opt/homebrew/bin /usr/local/bin; do [ -f "$bp/brew" ] && export PATH="$bp:$PATH"; done
    fi
    brew install wireguard-tools && return 0
    return 1
  elif [ "$(uname)" = "Linux" ]; then
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y wireguard wireguard-tools
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y wireguard-tools
    elif command -v yum &>/dev/null; then
      sudo yum install -y epel-release && sudo yum install -y wireguard-tools
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm wireguard-tools
    elif command -v apk &>/dev/null; then
      sudo apk add wireguard-tools
    else
      echo "  Paketmanager nicht erkannt – WireGuard manuell installieren: https://www.wireguard.com/install/"; return 1
    fi
  fi
}

WG_OK=0
if ! command -v wg &>/dev/null && ! command -v wg-quick &>/dev/null; then
  _install_wireguard && WG_OK=1 || echo "  WireGuard-Installation fehlgeschlagen – Tunnel übersprungen"
else
  WG_OK=1
fi

if [ "$WG_OK" = "1" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    sudo cp "$AGENT_DIR/wg-claudemc.conf" "/etc/wireguard/claudemc.conf"
    sudo chmod 600 "/etc/wireguard/claudemc.conf"
    sudo wg-quick down claudemc 2>/dev/null || true
    sudo wg-quick up claudemc && echo "✓ WireGuard-Tunnel gestartet" || echo "  WG-Start fehlgeschlagen: sudo wg-quick up claudemc"
  elif [ "$(uname)" = "Linux" ]; then
    sudo cp "$AGENT_DIR/wg-claudemc.conf" "/etc/wireguard/claudemc.conf"
    sudo chmod 600 "/etc/wireguard/claudemc.conf"
    if command -v systemctl &>/dev/null; then
      sudo systemctl enable wg-quick@claudemc 2>/dev/null || true
      sudo systemctl restart wg-quick@claudemc && echo "✓ WireGuard-Tunnel gestartet (systemd)" || echo "  WG-Start fehlgeschlagen"
    else
      sudo wg-quick up claudemc && echo "✓ WireGuard-Tunnel gestartet" || echo "  WG-Start fehlgeschlagen"
    fi
  fi
else
  echo "  WG-Config gespeichert: $AGENT_DIR/wg-claudemc.conf"
fi

# ── 5. Agent als Dienst einrichten + starten ───────────────────────────────
NODE_BIN="$(which node)"

if [ "$(uname)" = "Linux" ] && command -v systemctl &>/dev/null; then
  UNIT="/etc/systemd/system/claudemc-agent.service"
  sudo tee "$UNIT" > /dev/null <<UNIT
[Unit]
Description=Claude MC Agent (${client.name})
After=network.target wg-quick@\${IFACE}.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$AGENT_DIR
ExecStart=$NODE_BIN $AGENT_DIR/agent.js
Restart=on-failure
RestartSec=10
StandardOutput=append:$AGENT_DIR/agent.log
StandardError=append:$AGENT_DIR/agent.log

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable claudemc-agent 2>/dev/null || true
  sudo systemctl restart claudemc-agent
  echo "✓ Agent als systemd-Dienst eingerichtet & gestartet"
  echo "  Logs: journalctl -u claudemc-agent -f"

elif [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.claudemc.agent.plist"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claudemc.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$AGENT_DIR/agent.js</string>
  </array>
  <key>WorkingDirectory</key><string>$AGENT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$AGENT_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$AGENT_DIR/agent.log</string>
</dict></plist>
PLIST
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "✓ Agent als LaunchAgent eingerichtet (startet beim Login automatisch)"
  echo "  Logs: tail -f $AGENT_DIR/agent.log"

else
  # Fallback: direkt starten
  nohup node "$AGENT_DIR/agent.js" >> "$AGENT_DIR/agent.log" 2>&1 &
  echo "✓ Agent gestartet (PID: $!)"
  echo "  Für Auto-Start: @reboot node $AGENT_DIR/agent.js  (crontab -e)"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  ✓ Installation abgeschlossen!"
echo "  Agent verbindet mit: $SERVER_URL"
echo "══════════════════════════════════════════"
echo ""
`;

  // ── Bundled installer for Windows (PowerShell) ─────────────────────────────
  const installPs1 = `# ═══════════════════════════════════════════════════════
# Claude MC Agent – Bundled Installer (Windows)
# Client  : ${client.name}
# Platform: windows
# ═══════════════════════════════════════════════════════

$AgentDir = "$env:USERPROFILE\\.claudemc-agent"
$ServerUrl = "ws://${macWgIp}:${wsPort}"
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null

Write-Host ""
Write-Host "  Claude MC Agent Installer" -ForegroundColor Cyan
Write-Host "  Client: ${client.name}"
Write-Host "  Server: $ServerUrl"
Write-Host ""

# ── 1. Node.js prüfen / auto-installieren ─────────────────────────────────
$nodeOk = $false
try { node --version 2>&1 | Out-Null; $nodeOk = $true } catch {}

if (-not $nodeOk) {
    Write-Host "    Node.js nicht gefunden – wird automatisch installiert..."
    $installed = $false
    # Try winget (Windows 10/11)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "    winget install OpenJS.NodeJS.LTS..."
        winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>$null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        try { node --version 2>&1 | Out-Null; $installed = $true } catch {}
    }
    # Try Chocolatey
    if (-not $installed -and (Get-Command choco -ErrorAction SilentlyContinue)) {
        choco install nodejs-lts -y 2>$null
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        try { node --version 2>&1 | Out-Null; $installed = $true } catch {}
    }
    # Fallback: direct MSI download
    if (-not $installed) {
        Write-Host "    Lade Node.js MSI von nodejs.org..."
        $nodeMsi = "$env:TEMP\\node-lts.msi"
        Invoke-WebRequest "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi" -OutFile $nodeMsi -UseBasicParsing
        Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $nodeMsi, "/qn", "/norestart") -Wait
        Remove-Item $nodeMsi -ErrorAction SilentlyContinue
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        try { node --version 2>&1 | Out-Null; $installed = $true } catch {}
    }
    if (-not $installed) {
        Write-Host "FEHLER: Node.js Installation fehlgeschlagen. Bitte manuell installieren: https://nodejs.org" -ForegroundColor Red
        exit 1
    }
}
Write-Host "OK  Node.js $(node --version)" -ForegroundColor Green

# ── 2. Dateien entpacken ──────────────────────────────────────────────────
$agentB64 = "${agentJsB64}"
$wgB64    = "${wgConfB64}"

[IO.File]::WriteAllBytes("$AgentDir\\agent.js",    [Convert]::FromBase64String($agentB64))
[IO.File]::WriteAllBytes("$AgentDir\\wg-claudemc.conf", [Convert]::FromBase64String($wgB64))
Write-Host "OK  Dateien entpackt → $AgentDir" -ForegroundColor Green

# ── 3. ws npm-Paket installieren ──────────────────────────────────────────
Set-Location $AgentDir
if (-not (Test-Path "$AgentDir\\node_modules\\ws")) {
    Write-Host "    Installiere ws..."
    npm install ws --save --quiet 2>$null
}
Write-Host "OK  ws Paket bereit" -ForegroundColor Green

# ── 4. WireGuard auto-installieren + einrichten ───────────────────────────
$wgExe = "C:\\Program Files\\WireGuard\\wireguard.exe"
if (-not (Test-Path $wgExe)) {
    Write-Host "    WireGuard nicht gefunden – wird automatisch installiert..."
    $wgInstalled = $false
    # Try winget
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id WireGuard.WireGuard --silent --accept-source-agreements --accept-package-agreements 2>$null
        if (Test-Path $wgExe) { $wgInstalled = $true }
    }
    # Try Chocolatey
    if (-not $wgInstalled -and (Get-Command choco -ErrorAction SilentlyContinue)) {
        choco install wireguard -y 2>$null
        if (Test-Path $wgExe) { $wgInstalled = $true }
    }
    # Fallback: direct download
    if (-not $wgInstalled) {
        Write-Host "    Lade WireGuard Installer herunter..."
        $wgSetup = "$env:TEMP\\wireguard-installer.exe"
        Invoke-WebRequest "https://download.wireguard.com/windows-client/wireguard-installer.exe" -OutFile $wgSetup -UseBasicParsing
        Start-Process -FilePath $wgSetup -ArgumentList "/S" -Wait
        Remove-Item $wgSetup -ErrorAction SilentlyContinue
        if (Test-Path $wgExe) { $wgInstalled = $true }
    }
    if ($wgInstalled) {
        Write-Host "OK  WireGuard installiert" -ForegroundColor Green
    } else {
        Write-Host "    WireGuard-Installation fehlgeschlagen – Config gespeichert: $AgentDir\\wg-claudemc.conf"
    }
}

if (Test-Path $wgExe) {
    $wgConf = "$AgentDir\\wg-claudemc.conf"
    Write-Host "    WireGuard-Tunnel wird eingerichtet..."
    & $wgExe /installtunnelservice $wgConf 2>$null
    Write-Host "OK  WireGuard-Tunnel gestartet (claudemc)" -ForegroundColor Green
}

# ── 5. Agent als Windows-Dienst oder als Task starten ─────────────────────
$taskName = "ClaudeMCAgent"
$nodePath = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "$AgentDir\\agent.js" -WorkingDirectory $AgentDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName $taskName 2>$null | Out-Null
Write-Host "OK  Agent als Task eingerichtet & gestartet ($taskName)" -ForegroundColor Green

Write-Host ""
Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Installation abgeschlossen!" -ForegroundColor Green
Write-Host "  Agent verbindet mit: $ServerUrl"
Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
`;

  return { wgConf, agentJs, installSh, installPs1 };
}
