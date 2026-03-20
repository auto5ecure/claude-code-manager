import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';
import { execSync } from 'child_process';

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

const CONFIG_PATH = path.join(app.getPath('userData'), 'whatsapp-config.json');
const SESSION_PATH = path.join(app.getPath('userData'), 'whatsapp-session');

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

  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private qrHandlers: QRHandler[] = [];

  constructor() {
    this.loadConfig();
  }

  setMainWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  private loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
        this.config = { ...this.config, ...JSON.parse(data) };
      }
    } catch (err) {
      console.error('Failed to load WhatsApp config:', err);
    }
  }

  async saveConfig(newConfig: Partial<WhatsAppConfig>) {
    this.config = { ...this.config, ...newConfig };
    try {
      await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save WhatsApp config:', err);
    }
  }

  getConfig(): WhatsAppConfig {
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

    this.log('Initializing...');

    // Ensure session directory exists
    await fs.promises.mkdir(SESSION_PATH, { recursive: true });
    this.log('Session path: ' + SESSION_PATH);

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
          dataPath: SESSION_PATH,
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
            '--no-zygote',
            '--disable-gpu',
            '--single-process',
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
        await fs.promises.rm(SESSION_PATH, { recursive: true, force: true });
      } catch (err) {
        console.error('Error clearing WhatsApp session:', err);
      }
    }
  }

  isReady(): boolean {
    return this.status.ready;
  }
}

// Singleton instance
export const whatsAppService = new WhatsAppService();
