import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';
import { execSync, spawn } from 'child_process';

export interface PermissionCheckResult {
  chromeInstalled: boolean;
  chromePath?: string;
  canLaunchChrome: boolean;
  permissionError?: string;
  platform: string;
}

// Find Chrome/Chromium executable path
function findChromePath(): string | undefined {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS - try common Chrome locations
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
  } else if (platform === 'win32') {
    // Windows
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of paths) {
      if (p && fs.existsSync(p)) return p;
    }
  } else {
    // Linux
    try {
      return execSync('which google-chrome || which chromium-browser || which chromium', { encoding: 'utf-8' }).trim();
    } catch {
      // Not found
    }
  }

  return undefined;
}

export interface WhatsAppConfig {
  enabled: boolean;
  allowedNumbers: string[]; // Numbers that can send commands
  notifyNumbers: string[]; // Numbers to send notifications to
  autoReply: boolean; // Reply with Claude responses
}

export interface WhatsAppStatus {
  connected: boolean;
  ready: boolean;
  phoneNumber?: string;
  error?: string;
}

type MessageHandler = (from: string, body: string, message: Message) => void;
type StatusHandler = (status: WhatsAppStatus) => void;
type QRHandler = (qrDataUrl: string) => void;

// Lazy-loaded paths (app.getPath only works after app is ready)
function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'whatsapp-config.json');
}

function getSessionPath(): string {
  return path.join(app.getPath('userData'), 'whatsapp-session');
}

class WhatsAppService {
  private client: Client | null = null;
  private mainWindow: BrowserWindow | null = null;
  private config: WhatsAppConfig = {
    enabled: false,
    allowedNumbers: [],
    notifyNumbers: [],
    autoReply: true,
  };
  private status: WhatsAppStatus = {
    connected: false,
    ready: false,
  };
  private configLoaded = false;

  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private qrHandlers: QRHandler[] = [];

  // Constructor does nothing - loadConfig() is called lazily
  constructor() {
    // Don't call loadConfig here - app may not be ready yet
  }

  // Ensure config is loaded (called lazily when needed)
  private ensureConfigLoaded() {
    if (!this.configLoaded) {
      this.loadConfig();
      this.configLoaded = true;
    }
  }

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private loadConfig() {
    try {
      const configPath = getConfigPath();
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf-8');
        this.config = { ...this.config, ...JSON.parse(data) };
      }
    } catch (err) {
      console.error('Failed to load WhatsApp config:', err);
    }
  }

  async saveConfig(newConfig: Partial<WhatsAppConfig>) {
    this.ensureConfigLoaded();
    this.config = { ...this.config, ...newConfig };
    try {
      await fs.promises.writeFile(getConfigPath(), JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save WhatsApp config:', err);
    }
  }

  getConfig(): WhatsAppConfig {
    this.ensureConfigLoaded();
    return { ...this.config };
  }

  getStatus(): WhatsAppStatus {
    return { ...this.status };
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
    };
  }

  onStatusChange(handler: StatusHandler) {
    this.statusHandlers.push(handler);
    return () => {
      this.statusHandlers = this.statusHandlers.filter(h => h !== handler);
    };
  }

  onQR(handler: QRHandler) {
    this.qrHandlers.push(handler);
    return () => {
      this.qrHandlers = this.qrHandlers.filter(h => h !== handler);
    };
  }

  private updateStatus(update: Partial<WhatsAppStatus>) {
    this.status = { ...this.status, ...update };
    this.statusHandlers.forEach(h => h(this.status));
    this.mainWindow?.webContents.send('whatsapp-status', this.status);
  }

  private log(message: string, data?: unknown) {
    const logMsg = `[WhatsApp] ${message}`;
    console.log(logMsg, data || '');
    this.mainWindow?.webContents.send('whatsapp-log', { message, data, timestamp: new Date().toISOString() });
  }

  async initialize(): Promise<void> {
    if (this.client) {
      this.log('Client already initialized');
      return;
    }

    this.ensureConfigLoaded();
    this.log('Initializing...');

    // Ensure session directory exists
    const sessionPath = getSessionPath();
    await fs.promises.mkdir(sessionPath, { recursive: true });
    this.log('Session path: ' + sessionPath);

    // Find Chrome executable
    const chromePath = findChromePath();
    this.log('Chrome path: ' + (chromePath || 'NOT FOUND'));

    if (!chromePath) {
      this.updateStatus({ error: 'Chrome/Chromium nicht gefunden. Bitte installiere Google Chrome.' });
      throw new Error('Chrome not found');
    }

    // Check if Chrome exists and is executable
    if (!fs.existsSync(chromePath)) {
      this.log('Chrome not found at path!');
      this.updateStatus({ error: `Chrome nicht gefunden: ${chromePath}` });
      throw new Error('Chrome not found at path');
    }
    this.log('Chrome exists, creating client...');

    try {
      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: sessionPath,
        }),
        puppeteer: {
          headless: true,
          executablePath: chromePath,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
          ],
        },
      });
      this.log('Client created');
    } catch (err) {
      this.log('Failed to create client', (err as Error).message);
      this.updateStatus({ error: `Client-Erstellung fehlgeschlagen: ${(err as Error).message}` });
      throw err;
    }

    this.client.on('loading_screen', (percent, message) => {
      this.log(`Loading: ${percent}% - ${message}`);
    });

    this.client.on('qr', async (qr) => {
      this.log('QR code received');
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
        this.qrHandlers.forEach(h => h(qrDataUrl));
        this.mainWindow?.webContents.send('whatsapp-qr', qrDataUrl);
      } catch (err) {
        this.log('Failed to generate QR code', (err as Error).message);
      }
    });

    this.client.on('ready', async () => {
      this.log('Client ready!');
      const info = this.client?.info;
      this.updateStatus({
        connected: true,
        ready: true,
        phoneNumber: info?.wid?.user,
        error: undefined,
      });
    });

    this.client.on('authenticated', () => {
      this.log('Authenticated');
      this.updateStatus({ connected: true, error: undefined });
    });

    this.client.on('auth_failure', (msg) => {
      this.log('Auth failure', msg);
      this.updateStatus({ connected: false, ready: false, error: `Auth failed: ${msg}` });
    });

    this.client.on('disconnected', (reason) => {
      this.log('Disconnected', reason);
      this.updateStatus({ connected: false, ready: false, error: `Disconnected: ${reason}` });
      this.client = null;
    });

    this.client.on('message', async (message: Message) => {
      // Get sender number (remove @c.us suffix)
      const from = message.from.replace('@c.us', '');
      const body = message.body;

      console.log(`WhatsApp message from ${from}: ${body.substring(0, 50)}...`);

      // Check if sender is allowed
      if (this.config.allowedNumbers.length > 0 && !this.config.allowedNumbers.includes(from)) {
        console.log(`Ignoring message from non-allowed number: ${from}`);
        return;
      }

      // Notify handlers
      this.messageHandlers.forEach(h => h(from, body, message));
      this.mainWindow?.webContents.send('whatsapp-message', { from, body });
    });

    this.log('Starting client.initialize()...');
    try {
      await this.client.initialize();
      this.log('client.initialize() completed');
    } catch (err) {
      const error = err as Error;
      this.log('client.initialize() FAILED', { message: error.message, stack: error.stack });
      this.updateStatus({ error: `Init fehlgeschlagen: ${error.message}` });
      throw err;
    }
  }

  async sendMessage(to: string, message: string): Promise<boolean> {
    if (!this.client || !this.status.ready) {
      console.error('WhatsApp client not ready');
      return false;
    }

    try {
      // Ensure number has @c.us suffix
      const chatId = to.includes('@') ? to : `${to}@c.us`;
      await this.client.sendMessage(chatId, message);
      console.log(`WhatsApp message sent to ${to}`);
      return true;
    } catch (err) {
      console.error('Failed to send WhatsApp message:', err);
      return false;
    }
  }

  async sendNotification(message: string): Promise<void> {
    this.ensureConfigLoaded();
    for (const number of this.config.notifyNumbers) {
      await this.sendMessage(number, message);
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (err) {
        console.error('Error destroying WhatsApp client:', err);
      }
      this.client = null;
      this.updateStatus({ connected: false, ready: false });
    }
  }

  async logout(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch (err) {
        console.error('Error logging out WhatsApp client:', err);
      }
      await this.disconnect();
      // Clear session data
      try {
        await fs.promises.rm(getSessionPath(), { recursive: true, force: true });
      } catch (err) {
        console.error('Error clearing WhatsApp session:', err);
      }
    }
  }

  isReady(): boolean {
    return this.status.ready;
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    const platform = process.platform;
    const chromePath = findChromePath();

    const result: PermissionCheckResult = {
      chromeInstalled: !!chromePath,
      chromePath,
      canLaunchChrome: false,
      platform,
    };

    if (!chromePath) {
      result.permissionError = 'Chrome/Chromium ist nicht installiert.';
      return result;
    }

    // Try to launch Chrome briefly to check permissions
    return new Promise((resolve) => {
      try {
        const chromeProcess = spawn(chromePath, [
          '--headless',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--dump-dom',
          'about:blank',
        ], {
          timeout: 10000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        chromeProcess.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        const timeout = setTimeout(() => {
          chromeProcess.kill();
          // If it didn't fail quickly, it probably has permissions
          result.canLaunchChrome = true;
          resolve(result);
        }, 5000);

        chromeProcess.on('error', (err) => {
          clearTimeout(timeout);
          result.canLaunchChrome = false;
          result.permissionError = `Chrome konnte nicht gestartet werden: ${err.message}`;

          // Check for macOS permission errors
          if (platform === 'darwin' && (
            err.message.includes('EPERM') ||
            err.message.includes('operation not permitted') ||
            err.message.includes('sandbox')
          )) {
            result.permissionError = 'macOS blockiert den Start von Chrome. Bitte erlaube Claude MC in den Systemeinstellungen unter Datenschutz & Sicherheit.';
          }

          resolve(result);
        });

        chromeProcess.on('exit', (code) => {
          clearTimeout(timeout);

          // Check stderr for permission-related errors
          if (stderr.includes('Operation not permitted') ||
              stderr.includes('sandbox') ||
              stderr.includes('EPERM')) {
            result.canLaunchChrome = false;
            result.permissionError = 'macOS blockiert Chrome. Bitte prüfe die Systemeinstellungen unter Datenschutz & Sicherheit.';
          } else if (code === 0 || code === null) {
            result.canLaunchChrome = true;
          } else {
            // Non-zero exit but not a permission error
            result.canLaunchChrome = true; // Might still work for WhatsApp
          }

          resolve(result);
        });

      } catch (err) {
        result.canLaunchChrome = false;
        result.permissionError = `Fehler beim Prüfen: ${(err as Error).message}`;
        resolve(result);
      }
    });
  }
}

// Singleton instance
export const whatsAppService = new WhatsAppService();
