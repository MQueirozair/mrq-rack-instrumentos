import express from 'express';
import type { Express } from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { RemoteCommand, RemoteStateSnapshot } from '../shared/types';

interface RemoteServerOptions {
  getPort: () => number;
  getPin: () => string;
  onCommand: (cmd: RemoteCommand) => void;
}

export class RemoteServer {
  private app: Express | null = null;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private lastState: RemoteStateSnapshot | null = null;
  private opts: RemoteServerOptions;
  private currentPort: number | null = null;

  constructor(opts: RemoteServerOptions) {
    this.opts = opts;
  }

  async start() {
    const port = this.opts.getPort();
    if (this.httpServer && this.currentPort === port) return;
    await this.stop();

    this.app = express();
    const staticDir = path.join(__dirname, 'remote-ui');
    this.app.use(express.static(staticDir));
    this.app.get('/health', (_req, res) => res.json({ ok: true }));

    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      if (this.lastState) ws.send(JSON.stringify({ type: 'state', payload: this.lastState }));

      ws.on('message', (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === 'auth') {
          const ok = msg.pin === this.opts.getPin();
          ws.send(JSON.stringify({ type: 'auth', ok }));
          return;
        }
        if (msg.type === 'command' && msg.pin === this.opts.getPin()) {
          this.opts.onCommand(msg.payload as RemoteCommand);
        }
      });

      ws.on('close', () => this.clients.delete(ws));
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on('error', reject);
      this.httpServer!.listen(port, '0.0.0.0', () => resolve());
    });
    this.currentPort = port;
    console.log(`[remote] servindo em http://0.0.0.0:${port}`);
  }

  async stop() {
    this.clients.forEach((c) => c.close());
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
    await new Promise<void>((resolve) => {
      if (this.httpServer) this.httpServer.close(() => resolve());
      else resolve();
    });
    this.wss = null;
    this.httpServer = null;
    this.app = null;
    this.currentPort = null;
  }

  broadcastState(snapshot: RemoteStateSnapshot) {
    this.lastState = snapshot;
    const data = JSON.stringify({ type: 'state', payload: snapshot });
    this.clients.forEach((c) => {
      if (c.readyState === c.OPEN) c.send(data);
    });
  }
}
