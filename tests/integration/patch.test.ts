import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Patch Test', () => {
  it('should call handler', async () => {
    const port = 19097;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    // Patch the handler to add logging
    const originalHandler = (server as any)._listenForRequests.get('___syncRequests').callback;
    (server as any)._listenForRequests.set('___syncRequests', {
      method: '___syncRequests',
      callback: async (data: any, options: any) => {
        console.log('[TEST] ___syncRequests handler called with data:', data);
        try {
          const result = await originalHandler(data, options);
          console.log('[TEST] Handler returned:', result);
          return result;
        } catch (e: any) {
          console.log('[TEST] Handler error:', e.message);
          throw e;
        }
      }
    });
    
    wss.on('connection', (ws) => {
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${port}`);
    setServer(ws);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
