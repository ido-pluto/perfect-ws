import { describe, it, expect } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Minimal Test', () => {
  it('should create server and client', async () => {
    const port = 19080;
    const wss = new WebSocketServer({ port });
    
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    server.on('test', async (data) => {
      return { echo: data };
    });
    
    wss.on('connection', (ws) => attachClient(ws));
    
    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${port}`);
    setServer(ws);
    
    await client.serverOpen;
    
    const result = await client.request('test', { msg: 'hello' });
    expect(result.echo.msg).toBe('hello');
    
    ws.close();
    await new Promise((resolve) => wss.close(resolve));
  }, 10000);
});
