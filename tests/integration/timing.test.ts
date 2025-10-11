import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Timing Test', () => {
  it('should test timing of setup', async () => {
    const port = 19104;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    let attachTime = 0;
    wss.on('connection', (ws) => {
      console.log('[TEST] Server connection event at t=0ms');
      
      // Delay attach to simulate slow setup
      setTimeout(() => {
        console.log('[TEST] Attaching client at t=50ms');
        attachClient(ws);
        attachTime = Date.now();
      }, 50);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.syncRequestsTimeout = 500;
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('open', () => {
      console.log('[TEST] Client open event');
    });
    
    setServer(ws);
    
    await Promise.race([
      client.serverOpen.then(() => console.log('[TEST] serverOpen resolved!')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 1000))
    ]).catch(e => console.log('[TEST] Error:', e.message));
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
