import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Deserialize Test', () => {
  it('should deserialize messages', async () => {
    const port = 19096;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        try {
          const parsed = server['deserialize'](data);
          console.log('[TEST] Deserialized:', JSON.stringify(parsed).substring(0, 200));
        } catch (e: any) {
          console.log('[TEST] Deserialize error:', e.message);
        }
      });
      
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
