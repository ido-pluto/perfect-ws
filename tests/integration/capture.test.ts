import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Capture Test', () => {
  it('should capture messages', async () => {
    const port = 19095;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    let serverWs: any;
    wss.on('connection', (ws) => {
      console.log('[TEST] Server connection event');
      serverWs = ws;
      
      ws.on('message', (data) => {
        console.log('[TEST] Server received raw message:', data.length, 'bytes');
      });
      
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('message', (data) => {
      console.log('[TEST] Client received raw message:', data.length, 'bytes');
    });
    
    ws.on('open', () => {
      console.log('[TEST] Client open event, readyState=', ws.readyState);
    });
    
    setServer(ws);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('[TEST] After 2 seconds');
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
