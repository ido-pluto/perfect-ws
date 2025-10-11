import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('SendJSON Test', () => {
  it('should send response', async () => {
    const port = 19098;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    server.on('test', async (data) => {
      console.log('[TEST] test handler called');
      return { echo: data };
    });
    
    wss.on('connection', (ws) => {
      console.log('[TEST] Server connection');
      
      // Patch ws.send to log
      const originalSend = ws.send.bind(ws);
      ws.send = ((data: any, callback?: any) => {
        console.log('[TEST] ws.send called with', data.length, 'bytes');
        return originalSend(data, callback);
      }) as any;
      
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('message', (data) => {
      const length = Buffer.isBuffer(data) ? data.length : data instanceof ArrayBuffer ? data.byteLength : String(data).length;
      console.log('[TEST] Client received message:', length, 'bytes');
    });
    
    setServer(ws);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('[TEST] Making test request...');
    const result = await client.request('test', { foo: 'bar' }, { timeout: 3000 }).catch((e: any) => {
      console.log('[TEST] Request error:', e.message);
      return null;
    });
    console.log('[TEST] Request result:', result);
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
