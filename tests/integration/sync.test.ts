import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Sync Test', () => {
  it('should sync requests', async () => {
    const port = 19099;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    wss.on('connection', (ws) => {
      console.log('[TEST] Server connection');
      
      const originalSend = ws.send.bind(ws);
      ws.send = ((data: any, callback?: any) => {
        console.log('[TEST] Server ws.send called with', data.length, 'bytes');
        try {
          const parsed = server['deserialize'](data);
          console.log('[TEST] Sending response for:', parsed.requestId?.substring(0, 30));
        } catch {}
        return originalSend(data, callback);
      }) as any;
      
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.syncRequestsTimeout = 2000;
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    let messageCount = 0;
    ws.on('message', (data) => {
      messageCount++;
      try {
        const parsed = client['deserialize'](data);
        console.log('[TEST] Client message #' + messageCount + ' for requestId:', parsed.requestId?.substring(0, 30));
      } catch (e) {
        console.log('[TEST] Client message #' + messageCount + ':', data.length, 'bytes');
      }
    });
    
    setServer(ws);
    
    console.log('[TEST] Waiting for serverOpen...');
    await Promise.race([
      client.serverOpen.then(() => console.log('[TEST] serverOpen resolved!')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
    ]).catch(e => console.log('[TEST] Error:', e.message));
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
