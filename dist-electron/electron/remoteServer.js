"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteServer = void 0;
const express_1 = __importDefault(require("express"));
const node_http_1 = __importDefault(require("node:http"));
const node_path_1 = __importDefault(require("node:path"));
const ws_1 = require("ws");
class RemoteServer {
    app = null;
    httpServer = null;
    wss = null;
    clients = new Set();
    lastState = null;
    opts;
    currentPort = null;
    constructor(opts) {
        this.opts = opts;
    }
    async start() {
        const port = this.opts.getPort();
        if (this.httpServer && this.currentPort === port)
            return;
        await this.stop();
        this.app = (0, express_1.default)();
        const staticDir = node_path_1.default.join(__dirname, 'remote-ui');
        this.app.use(express_1.default.static(staticDir));
        this.app.get('/health', (_req, res) => res.json({ ok: true }));
        this.httpServer = node_http_1.default.createServer(this.app);
        this.wss = new ws_1.WebSocketServer({ server: this.httpServer, path: '/ws' });
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);
            if (this.lastState)
                ws.send(JSON.stringify({ type: 'state', payload: this.lastState }));
            ws.on('message', (raw) => {
                let msg;
                try {
                    msg = JSON.parse(raw.toString());
                }
                catch {
                    return;
                }
                if (msg.type === 'auth') {
                    const ok = msg.pin === this.opts.getPin();
                    ws.send(JSON.stringify({ type: 'auth', ok }));
                    return;
                }
                if (msg.type === 'command' && msg.pin === this.opts.getPin()) {
                    this.opts.onCommand(msg.payload);
                }
            });
            ws.on('close', () => this.clients.delete(ws));
        });
        await new Promise((resolve, reject) => {
            this.httpServer.on('error', reject);
            this.httpServer.listen(port, '0.0.0.0', () => resolve());
        });
        this.currentPort = port;
        console.log(`[remote] servindo em http://0.0.0.0:${port}`);
    }
    async stop() {
        this.clients.forEach((c) => c.close());
        this.clients.clear();
        await new Promise((resolve) => {
            if (this.wss)
                this.wss.close(() => resolve());
            else
                resolve();
        });
        await new Promise((resolve) => {
            if (this.httpServer)
                this.httpServer.close(() => resolve());
            else
                resolve();
        });
        this.wss = null;
        this.httpServer = null;
        this.app = null;
        this.currentPort = null;
    }
    broadcastState(snapshot) {
        this.lastState = snapshot;
        const data = JSON.stringify({ type: 'state', payload: snapshot });
        this.clients.forEach((c) => {
            if (c.readyState === c.OPEN)
                c.send(data);
        });
    }
}
exports.RemoteServer = RemoteServer;
//# sourceMappingURL=remoteServer.js.map