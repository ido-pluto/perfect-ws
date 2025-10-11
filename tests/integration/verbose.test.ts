import { describe, it } from 'vitest';
import { PerfectWS } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Verbose Test', () => {
  it('should show verbose logging', async () => {
    const port = 19200;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWS.server();
    server.config.verbose = true;
    
    wss.on('connection', (ws) => {
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWS.client();
    client.config.verbose = true;
    client.config.syncRequestsTimeout = 30000;
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    setServer(ws);
    
    await Promise.race([
      client.serverOpen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]).catch(() => {});
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
