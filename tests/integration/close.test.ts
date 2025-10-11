import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Close Test', () => {
  it('should track close events', async () => {
    const port = 19103;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    let serverWs: any;
    wss.on('connection', (ws) => {
      console.log('[TEST] Server connection event');
      serverWs = ws;
      ws.on('close', () => {
        console.log('[TEST] Server WebSocket closed');
      });
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('open', () => {
      console.log('[TEST] Client WebSocket open');
    });
    
    ws.on('close', () => {
      console.log('[TEST] Client WebSocket closed');
    });
    
    setServer(ws);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('[TEST] Client readyState=', ws.readyState);
    console.log('[TEST] Server readyState=', serverWs?.readyState);
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
