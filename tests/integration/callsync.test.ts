import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('CallSync Test', () => {
  it('should call _syncRequests', async () => {
    const port = 19101;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    wss.on('connection', (ws) => {
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    
    // Patch _syncRequests
    const originalSync = (client as any)._syncRequests.bind(client);
    (client as any)._syncRequests = async (server: any) => {
      console.log('[TEST] _syncRequests called, server.readyState=', server?.readyState);
      try {
        const result = await originalSync(server);
        console.log('[TEST] _syncRequests returned:', result);
        return result;
      } catch (e: any) {
        console.log('[TEST] _syncRequests error:', e.message, e.code);
        throw e;
      }
    };
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    console.log('[TEST] Calling setServer...');
    setServer(ws);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
