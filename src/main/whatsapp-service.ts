import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';

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

  async initialize(): Promise<void> {
    if (this.client) {
      console.log('WhatsApp client already initialized');
      return;
    }

    console.log('Initializing WhatsApp client...');

    // Ensure session directory exists
    await fs.promises.mkdir(SESSION_PATH, { recursive: true });

    this.client = new Client({
      authStrategy: new LocalAuth({
        dataPath: SESSION_PATH,
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      },
    });

    this.client.on('qr', async (qr) => {
      console.log('WhatsApp QR code received');
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
        this.qrHandlers.forEach(h => h(qrDataUrl));
        this.mainWindow?.webContents.send('whatsapp-qr', qrDataUrl);
      } catch (err) {
        console.error('Failed to generate QR code:', err);
      }
    });

    this.client.on('ready', async () => {
      console.log('WhatsApp client is ready');
      const info = this.client?.info;
      this.updateStatus({
        connected: true,
        ready: true,
        phoneNumber: info?.wid?.user,
        error: undefined,
      });
    });

    this.client.on('authenticated', () => {
      console.log('WhatsApp authenticated');
      this.updateStatus({ connected: true, error: undefined });
    });

    this.client.on('auth_failure', (msg) => {
      console.error('WhatsApp auth failure:', msg);
      this.updateStatus({ connected: false, ready: false, error: `Auth failed: ${msg}` });
    });

    this.client.on('disconnected', (reason) => {
      console.log('WhatsApp disconnected:', reason);
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

    try {
      await this.client.initialize();
    } catch (err) {
      console.error('Failed to initialize WhatsApp client:', err);
      this.updateStatus({ error: (err as Error).message });
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
