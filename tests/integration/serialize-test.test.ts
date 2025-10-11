import { describe, it } from 'vitest';
import { PerfectWS } from '../../src/index.js';

describe('Serialize Test', () => {
  it('should serialize data quickly', () => {
    const { router } = PerfectWS.server();
    
    const data = { requestId: 'test123', data: [], down: true };
    
    console.log('[TEST] Serializing...');
    const start = Date.now();
    const serialized = (router as any).serialize(data);
    const elapsed = Date.now() - start;
    
    console.log('[TEST] Serialized in', elapsed, 'ms, size=', serialized.length);
  });
});
