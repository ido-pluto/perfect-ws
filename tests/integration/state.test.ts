import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { WebSocketForce } from '../../src/utils/WebSocketForce.ts';

describe('State Test', () => {
  it('should check readyState', async () => {
    const port = 19102;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    wss.on('connection', (ws) => {
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    
    // Patch request to log readyState check
    const originalRequest = (client as any).request.bind(client);
    (client as any).request = function(method: string, data: any, options: any = {}) {
      const useServer = options.useServer ?? (this as any)._server;
      const ws = (this as any)._server;
      
      console.log('[TEST] request called, method=', method);
      console.log('[TEST]   options.useServer=', options.useServer?.readyState);
      console.log('[TEST]   this._server=', ws?.readyState);
      console.log('[TEST]   useServer=', useServer?.readyState);
      console.log('[TEST]   WebSocketForce.OPEN=', WebSocketForce.OPEN);
      console.log('[TEST]   Check result:', useServer?.readyState !== WebSocketForce.OPEN);
      
      return originalRequest.call(this, method, data, options);
    };
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    setServer(ws);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
