import { describe, it } from 'vitest';
import { PerfectWS } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Basic Protocol Test', () => {
  it('should work with basic PerfectWS', async () => {
    const port = 19107;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWS.server();
    
    server.on('test', async (data) => {
      return { echo: data };
    });
    
    wss.on('connection', (ws) => {
      attachClient(ws);
    });
    
    const { router: client, setServer } = PerfectWS.client();
    
    const ws = new WebSocket(`ws://localhost:${port}`);
    setServer(ws);
    
    console.log('[TEST] Waiting for serverOpen...');
    await Promise.race([
      client.serverOpen.then(() => console.log('[TEST] serverOpen resolved!')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
    ]).catch(e => console.log('[TEST] Error:', e.message));
    
    if (await client.serverOpen) {
      console.log('[TEST] Making request...');
      const result = await client.request('test', { foo: 'bar' });
      console.log('[TEST] Result:', result);
    }
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
