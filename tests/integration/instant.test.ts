import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Instant Test', () => {
  it('should test instant attach', async () => {
    const port = 19105;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    wss.on('connection', (ws) => {
      console.log('[TEST] Server connection, immediately attaching');
      attachClient(ws);
      console.log('[TEST] Attached');
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.syncRequestsTimeout = 2000;
    client.config.verbose = true;
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    console.log('[TEST] Calling setServer');
    setServer(ws);
    
    await Promise.race([
      client.serverOpen.then(() => console.log('[TEST] serverOpen resolved!')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
    ]).catch(e => console.log('[TEST] Error:', e.message));
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
