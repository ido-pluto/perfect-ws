import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('OnOpen Test', () => {
  it('should fire onOpen', async () => {
    const port = 19100;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    wss.on('connection', (ws) => {
      console.log('[TEST] Server connection, readyState=', ws.readyState);
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    console.log('[TEST] WebSocket created, readyState=', ws.readyState);
    
    ws.on('open', () => {
      console.log('[TEST] ws.open event fired, readyState=', ws.readyState);
    });
    
    console.log('[TEST] Calling setServer...');
    setServer(ws);
    console.log('[TEST] setServer returned');
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('[TEST] After 2 seconds, readyState=', ws.readyState);
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
