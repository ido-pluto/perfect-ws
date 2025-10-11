import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Response Test', () => {
  it('should track response', async () => {
    const port = 19106;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    wss.on('connection', (ws) => {
      const originalSend = ws.send.bind(ws);
      ws.send = ((data: any, callback?: any) => {
        console.log('[TEST] Server sending', data.length, 'bytes');
        try {
          const parsed = server['deserialize'](data);
          console.log('[TEST]   for requestId:', parsed.requestId?.substring(0, 40));
        } catch {}
        return originalSend(data, callback);
      }) as any;
      
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.syncRequestsTimeout = 2000;
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('message', (data) => {
      console.log('[TEST] Client received', data.length, 'bytes');
    });
    
    setServer(ws);
    
    await Promise.race([
      client.serverOpen.then(() => console.log('[TEST] serverOpen resolved!')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
    ]).catch(e => console.log('[TEST] Error:', e.message));
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
