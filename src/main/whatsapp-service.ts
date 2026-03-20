import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
} from '@whiskeysockets/baileys';
import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';
import { Boom } from '@hapi/boom';

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

// Message type for handlers (simplified from Baileys)
interface SimpleMessage {
  key: proto.IMessageKey;
  message?: proto.IMessage | null;
}

type MessageHandler = (from: string, body: string, message: SimpleMessage) => void;
type StatusHandler = (status: WhatsAppStatus) => void;
type QRHandler = (qrDataUrl: string) => void;

// Lazy-loaded paths (app.getPath only works after app is ready)
function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'whatsapp-config.json');
}

function getSessionPath(): string {
  return path.join(app.getPath('userData'), 'whatsapp-baileys-session');
}

class WhatsAppService {
  private socket: WASocket | null = null;
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
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  private messageHandlers: MessageHandler[] = [];
  private statusHandlers: StatusHandler[] = [];
  private qrHandlers: QRHandler[] = [];

  constructor() {
    // Don't call loadConfig here - app may not be ready yet
  }

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
    if (this.socket) {
      this.log('Socket already initialized');
      return;
    }

    this.ensureConfigLoaded();
    this.log('Initializing Baileys...');

    // Ensure session directory exists
    const sessionPath = getSessionPath();
    await fs.promises.mkdir(sessionPath, { recursive: true });
    this.log('Session path: ' + sessionPath);

    try {
      // Load auth state
      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      this.log('Auth state loaded');

      // Create socket
      this.socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        // Reduce logging noise
        logger: {
          level: 'silent',
          trace: () => {},
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: (msg: string) => console.error('[Baileys]', msg),
          fatal: (msg: string) => console.error('[Baileys FATAL]', msg),
          child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) as any }),
        } as any,
      });

      this.log('Socket created');

      // Handle connection updates
      this.socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR Code received
        if (qr) {
          this.log('QR code received');
          try {
            const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
            this.qrHandlers.forEach(h => h(qrDataUrl));
            this.mainWindow?.webContents.send('whatsapp-qr', qrDataUrl);
          } catch (err) {
            this.log('Failed to generate QR code', (err as Error).message);
          }
        }

        // Connection state changed
        if (connection === 'close') {
          const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
          this.log('Connection closed', { shouldReconnect, error: lastDisconnect?.error });

          if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.log(`Reconnecting... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            this.socket = null;
            setTimeout(() => this.initialize(), 3000);
          } else {
            this.socket = null;
            this.updateStatus({
              connected: false,
              ready: false,
              error: shouldReconnect ? 'Zu viele Verbindungsversuche' : 'Abgemeldet',
            });
          }
        } else if (connection === 'open') {
          this.log('Connection opened!');
          this.reconnectAttempts = 0;

          // Get phone number from socket
          const phoneNumber = this.socket?.user?.id?.split(':')[0] || this.socket?.user?.id?.split('@')[0];

          this.updateStatus({
            connected: true,
            ready: true,
            phoneNumber,
            error: undefined,
          });
        } else if (connection === 'connecting') {
          this.log('Connecting...');
          this.updateStatus({
            connected: false,
            ready: false,
            error: undefined,
          });
        }
      });

      // Handle credentials update
      this.socket.ev.on('creds.update', saveCreds);

      // Handle incoming messages
      this.socket.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
          // Get sender number (remove @s.whatsapp.net suffix)
          const from = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || '';

          // Get message body
          const body = msg.message?.conversation ||
                      msg.message?.extendedTextMessage?.text ||
                      '';

          if (!body) return;

          this.log(`Message from ${from}: ${body.substring(0, 50)}...`);

          // Check if sender is allowed
          if (this.config.allowedNumbers.length > 0 && !this.config.allowedNumbers.includes(from)) {
            this.log(`Ignoring message from non-allowed number: ${from}`);
            return;
          }

          // Notify handlers
          this.messageHandlers.forEach(h => h(from, body, msg as SimpleMessage));
          this.mainWindow?.webContents.send('whatsapp-message', { from, body });
        }
      });

      this.log('Event handlers registered');

    } catch (err) {
      const error = err as Error;
      this.log('Initialize FAILED', { message: error.message, stack: error.stack });
      this.updateStatus({ error: `Init fehlgeschlagen: ${error.message}` });
      throw err;
    }
  }

  async sendMessage(to: string, message: string): Promise<boolean> {
    if (!this.socket || !this.status.ready) {
      console.error('WhatsApp socket not ready');
      return false;
    }

    try {
      // Ensure number has @s.whatsapp.net suffix
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      await this.socket.sendMessage(jid, { text: message });
      this.log(`Message sent to ${to}`);
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
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch (err) {
        console.error('Error closing WhatsApp socket:', err);
      }
      this.socket = null;
      this.updateStatus({ connected: false, ready: false });
    }
  }

  async logout(): Promise<void> {
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch (err) {
        console.error('Error logging out WhatsApp:', err);
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

  // Simplified - no Chrome needed with Baileys
  async checkPermissions(): Promise<{ chromeInstalled: boolean; canLaunchChrome: boolean; platform: string }> {
    return {
      chromeInstalled: true, // Not needed with Baileys
      canLaunchChrome: true, // Not needed with Baileys
      platform: process.platform,
    };
  }
}

// Singleton instance
export const whatsAppService = new WhatsAppService();
