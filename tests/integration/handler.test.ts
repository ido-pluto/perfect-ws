import { describe, it } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';

describe('Handler Test', () => {
  it('should have internal handlers registered', () => {
    const { router: server } = PerfectWSAdvanced.server();
    const { router: client } = PerfectWSAdvanced.client();
    
    console.log('[TEST] Server handlers:', Array.from((server as any)._listenForRequests.keys()));
    console.log('[TEST] Client handlers:', Array.from((client as any)._listenForRequests.keys()));
    console.log('[TEST] Server _isClient:', (server as any)._isClient);
    console.log('[TEST] Client _isClient:', (client as any)._isClient);
  });
});
