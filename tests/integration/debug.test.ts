import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Debug Test', () => {
  it('should show connection flow', async () => {
    const port = 19090;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    server.config.verbose = true;
    
    let serverConnected = false;
    wss.on('connection', (ws) => {
      console.log('[TEST] Server received connection');
      serverConnected = true;
      attachClient(ws);
      console.log('[TEST] Server attached client');
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.verbose = true;
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('open', () => {
      console.log('[TEST] Client WebSocket opened, serverConnected=', serverConnected);
    });
    
    setServer(ws);
    console.log('[TEST] Client setServer called');
    
    try {
      console.log('[TEST] Waiting for serverOpen...');
      await Promise.race([
        client.serverOpen.then(() => console.log('[TEST] serverOpen resolved!')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for serverOpen')), 8000))
      ]);
    } catch (e) {
      console.log('[TEST] Error:', e.message);
    }
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 15000);
});
