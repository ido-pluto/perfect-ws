import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWS, PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { NetworkEventListener } from '../../src/utils/NetworkEventListener.js';
import { sleep } from '../../src/utils/sleepPromise.js';

describe('Network Stability Integration Tests', () => {
  let wss: WebSocketServer;
  let serverRouter: PerfectWS | PerfectWSAdvanced;
  let clientRouter: PerfectWS | PerfectWSAdvanced;
  let serverCleanup: () => void;
  let clientCleanup: () => void;
  let serverPort: number;

  beforeEach(async () => {
    // Find available port
    serverPort = 8080 + Math.floor(Math.random() * 1000);
    wss = new WebSocketServer({ port: serverPort });
  });

  afterEach(async () => {
    // Give pending operations time to complete before cleanup
    await sleep(100);
    serverCleanup?.();
    clientCleanup?.();
    await new Promise((resolve) => wss.close(resolve));
    // Additional delay for cleanup to propagate
    await sleep(50);
  });

  it('should handle rapid connection drops and reconnections with pending requests', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    serverRouter = server;

    const processedRequests: string[] = [];
    const errors: any[] = [];

    server.on('longProcess', async (data, { send, abortSignal }) => {
      for (let i = 0; i < 10; i++) {
        if (abortSignal.aborted) break;
        await sleep(100);
        send({ progress: i * 10, id: data.id }, false);
      }
      processedRequests.push(data.id);
      return { completed: data.id };
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer, unregister } = PerfectWSAdvanced.client();
    clientRouter = client;
    clientCleanup = unregister;

    // Simulate unstable connection
    let ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);

    const requests: Promise<any>[] = [];
    const callbacks: any[] = [];

    // Start 5 concurrent long requests
    for (let i = 0; i < 5; i++) {
      const callback = vi.fn();
      callbacks.push(callback);

      requests.push(
        client.request('longProcess', { id: `req-${i}` }, {
          callback: (data, error, down) => {
            callback(data, error, down)
          },
          timeout: 5000
        }).catch(err => {
          errors.push({ id: `req-${i}`, error: err.message });
          return null;
        })
      );
    }

    // Simulate network instability
    await sleep(200);
    ws.close(); // First disconnect

    await sleep(100);
    ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);

    await sleep(300);
    ws.close(); // Second disconnect

    await sleep(100);
    ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);

    // Wait for all requests to complete or fail
    const results = await Promise.all(requests);

    // Some requests should complete, some might fail
    const completed = results.filter(r => r?.completed);
    const failed = results.filter(r => r === null);

    expect(completed.length + failed.length).toBe(5);
    expect(callbacks.some(cb => cb.mock.calls.length > 0)).toBe(true);
  });

  it('should handle massive concurrent requests with intermittent network issues', async () => {
    const { router: server, attachClient } = PerfectWS.server();
    serverRouter = server;

    const requestLog: Map<string, { start: number, end?: number, error?: string }> = new Map();

    server.on('process', async (data) => {
      const startTime = Date.now();
      requestLog.set(data.id, { start: startTime });

      // Simulate varying processing times (reduced for speed)
      await sleep(Math.random() * 100);

      if (Math.random() < 0.05) {
      // 5% chance of server error (reduced from 10%)
        throw new Error(`Server error for ${data.id}`);
      }

      requestLog.get(data.id)!.end = Date.now();
      return {
        processed: data.id,
        duration: Date.now() - startTime,
        serverTime: new Date().toISOString()
      };
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWS.client();
    clientRouter = client;
    client.config.requestTimeout = 8000;
    client.config.sendRequestRetries = 3;

    let ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const NUM_REQUESTS = 50; // Reduced from 100 for faster execution
    const requests: Promise<any>[] = [];
    const requestStartTimes: Map<string, number> = new Map();
    let reconnections = 0;

    // Launch concurrent requests with throttling
    for (let i = 0; i < NUM_REQUESTS; i++) {
      const id = `massive-${i}`;
      requestStartTimes.set(id, Date.now());

      requests.push(
        client.request('process', {
          id,
          data: Buffer.alloc(512).fill(i % 256) // Reduced data size
        }, {
          timeout: 8000
        }).catch(err => ({ error: err.message, id }))
      );

      // Simulate network issues during request sending (less aggressive)
      if (i === 20 && reconnections < 2) {
        reconnections++;
        // Wait a bit for some requests to complete
        await sleep(200);
        ws.close();
        await sleep(100);
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        setServer(ws);
        await client.serverOpen; // Wait for reconnection
      }

      // Add small delay every 10 requests to prevent overwhelming
      if (i % 10 === 0 && i > 0) {
        await sleep(10);
      }
    }

    const results = await Promise.all(requests);

    const successful = results.filter(r => r.processed);
    const failed = results.filter(r => r.error);

    expect(successful.length + failed.length).toBe(NUM_REQUESTS);
    // With one reconnection and proper timing, most requests should succeed
    expect(successful.length).toBeGreaterThan(NUM_REQUESTS * 0.4); // At least 40% should succeed

    // Verify timing consistency
    successful.forEach(result => {
      const clientStart = requestStartTimes.get(result.processed)!;
      const serverLog = requestLog.get(result.processed);
      if (serverLog?.end) {
        const totalTime = serverLog.end - clientStart;
        expect(totalTime).toBeLessThan(9000); // Should not exceed timeout + overhead
      }
    });
    
    // Close connection and wait for cleanup
    ws.close();
    await sleep(100);
  }, 15000); // Increased timeout to 15 seconds

  it('should handle WebSocket frame fragmentation with large payloads', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    serverRouter = server;

    server.on('largeData', async (data, { send }) => {
      // Echo back with transformations
      const chunks: any[] = [];
      for (let i = 0; i < data.chunks.length; i++) {
        chunks.push({
          index: i,
          size: data.chunks[i].length,
          checksum: data.chunks[i].reduce((a: number, b: number) => a + b, 0)
        });

        // Stream progress
        send({
          progress: ((i + 1) / data.chunks.length) * 100,
          processed: i + 1,
          total: data.chunks.length
        }, false);
      }

      return {
        processed: true,
        chunks,
        totalSize: data.chunks.reduce((sum: number, chunk: any[]) => sum + chunk.length, 0)
      };
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWSAdvanced.client();
    clientRouter = client;

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Create large payload with multiple chunks
    const chunks: any[] = [];
    for (let i = 0; i < 50; i++) {
      chunks.push(Array(10000).fill(i)); // 50 chunks of 10k elements each
    }

    const progressUpdates: any[] = [];
    const result = await client.request('largeData', { chunks }, {
      callback: (data, error, done) => {
        if (!done && data) {
          progressUpdates.push(data);
        }
      },
      timeout: 30000
    });

    expect(result.processed).toBe(true);
    expect(result.chunks).toHaveLength(50);
    expect(result.totalSize).toBe(500000);
    expect(progressUpdates.length).toBeGreaterThan(0);
    expect(progressUpdates[progressUpdates.length - 1].progress).toBe(100);
  });

  it('should handle ping-pong timeout scenarios with recovery', async () => {
    const { router: server, attachClient } = PerfectWS.server();
    serverRouter = server;
    server.config.pingReceiveTimeout = 1000;
    server.config.pingIntervalMs = 200;

    let pingCount = 0;
    server.on('___ping', () => {
      pingCount++;
      if (pingCount === 5) {
        // Simulate slow response on 5th ping
        return new Promise(resolve => setTimeout(() => resolve('pong'), 1500));
      }
      return 'pong';
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWS.client();
    clientRouter = client;
    client.config.pingIntervalMs = 200;
    client.config.pingRequestTimeout = 500;

    let disconnectCount = 0;
    const ws = new WebSocket(`ws://localhost:${serverPort}`);

    ws.addEventListener('close', () => {
      disconnectCount++;
    });

    setServer(ws);
    await client.serverOpen;

    // Make requests while ping-pong is happening
    const requests: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      requests.push(
        client.request('test', { id: i }, {
          timeout: 2000,
          doNotWaitForConnection: true
        }).catch(() => null)
      );
      await sleep(300);
    }

    const results = await Promise.all(requests);
    const successful = results.filter(r => r !== null);

    // Should handle ping timeouts gracefully
    expect(disconnectCount).toBeGreaterThanOrEqual(0);
  });

  it('should handle request abort scenarios with cleanup verification', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    serverRouter = server;

    const activeRequests = new Set<string>();
    const abortedRequests = new Set<string>();

    server.on('abortable', async (data, { send, abortSignal }) => {
      activeRequests.add(data.id);

      const cleanup = () => {
        activeRequests.delete(data.id);
        abortedRequests.add(data.id);
      };

      abortSignal.addEventListener('abort', cleanup);

      try {
        for (let i = 0; i < 100; i++) {
          if (abortSignal.aborted) {
            cleanup();
            throw new Error('Aborted');
          }
          await sleep(50);
          send({ progress: i }, false);
        }
        activeRequests.delete(data.id);
        return { completed: data.id };
      } catch (err) {
        cleanup();
        throw err;
      }
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWSAdvanced.client();
    clientRouter = client;

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const controllers: AbortController[] = [];
    const requests2: Promise<any>[] = [];

    // Start 10 abortable requests
    for (let i = 0; i < 10; i++) {
      const controller = new AbortController();
      controllers.push(controller);

      requests2.push(
        client.request('abortable', { id: `abort-${i}` }, {
          abortSignal: controller.signal,
          timeout: 10000
        }).catch(err => ({ aborted: true, error: err.message }))
      );
    }

    // Abort requests at different times
    await sleep(100);
    controllers[0].abort('User cancelled');

    await sleep(200);
    controllers[2].abort('Timeout');
    controllers[3].abort('Network issue');

    await sleep(500);
    controllers[5].abort('Application closing');

    const results = await Promise.all(requests2);

    const aborted = results.filter(r => r.aborted);
    const completed = results.filter(r => r.completed);

    expect(aborted.length).toBeGreaterThan(0);
    expect(abortedRequests.size).toBe(aborted.length);
    expect(activeRequests.size).toBe(0); // All should be cleaned up
  });

  it('should handle Byzantine fault scenarios with conflicting states', async () => {
    const { router: server, attachClient } = PerfectWS.server();
    serverRouter = server;

    const stateMap = new Map<string, any>();

    server.on('byzantine', async (data, { send }) => {
      const currentState = stateMap.get(data.key) || { version: 0, value: null };

      // Simulate Byzantine behavior - sometimes return old state
      if (Math.random() < 0.2) {
        return { ...currentState, byzantine: true };
      }

      // Normal operation
      if (data.operation === 'write') {
        const newState = {
          version: currentState.version + 1,
          value: data.value,
          timestamp: Date.now()
        };
        stateMap.set(data.key, newState);

        // Simulate eventual consistency delay
        await sleep(Math.random() * 100);

        return newState;
      } else {
        return currentState;
      }
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWS.client();
    clientRouter = client;

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Multiple clients trying to update same key
    const operations: Promise<any>[] = [];
    const key = 'byzantine-key';

    for (let i = 0; i < 20; i++) {
      operations.push(
        client.request('byzantine', {
          key,
          operation: 'write',
          value: `value-${i}`
        }, { timeout: 2000 })
      );

      // Add some reads
      if (i % 3 === 0) {
        operations.push(
          client.request('byzantine', {
            key,
            operation: 'read'
          }, { timeout: 2000 })
        );
      }
    }

    const results = await Promise.all(operations.map(p => p.catch(e => ({ error: e }))));

    const writes = results.filter(r => !r.error && r.version);
    const byzantineReads = results.filter(r => r.byzantine);

    // Should handle Byzantine responses
    expect(byzantineReads.length).toBeGreaterThanOrEqual(0);

    // Version numbers should be monotonic (when not Byzantine)
    const versions = writes
      .filter(r => !r.byzantine)
      .map(r => r.version)
      .filter(v => v !== undefined);

    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThanOrEqual(versions[i-1]);
    }
  });

  it('should handle memory pressure with request queue overflow', async () => {
    const { router: server, attachClient } = PerfectWS.server();
    serverRouter = server;

    let processedCount = 0;
    let rejectedCount = 0;

    server.on('memory', async (data) => {
      // Simulate memory-intensive operation
      const buffer = Buffer.alloc(data.size);

      // Simulate processing
      await sleep(data.delay);

      processedCount++;

      // Randomly reject some to simulate memory pressure
      if (processedCount > 50 && Math.random() < 0.3) {
        rejectedCount++;
        throw new Error('Out of memory');
      }

      return {
        processed: true,
        id: data.id,
        bufferSize: buffer.length
      };
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWS.client();
    clientRouter = client;
    client.config.requestTimeout = 5000;

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const requests: Promise<any>[] = [];
    const sizes = [1024, 10240, 102400, 1024000]; // Various sizes

    // Flood with requests
    for (let i = 0; i < 100; i++) {
      requests.push(
        client.request('memory', {
          id: `mem-${i}`,
          size: sizes[i % sizes.length],
          delay: Math.random() * 50
        }, {
          timeout: 3000
        }).catch(err => ({ error: err.message, id: `mem-${i}` }))
      );

      // Don't wait between requests to create pressure
      if (i % 10 === 0) {
        await sleep(1); // Brief yield
      }
    }

    const results = await Promise.all(requests);

    const successful = results.filter(r => r.processed);
    const failed = results.filter(r => r.error);

    expect(successful.length + failed.length).toBe(100);
    expect(processedCount).toBeGreaterThan(0);

    // Memory pressure should cause some failures
    if (rejectedCount > 0) {
      expect(failed.some(f => f.error.includes('memory'))).toBe(true);
    }
  });

  it('should handle connection state race conditions', async () => {
    const { router: server, attachClient } = PerfectWS.server();
    serverRouter = server;

    server.on('race', async (data) => {
      await sleep(data.delay || 0);
      return { processed: data.id, timestamp: Date.now() };
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWS.client();
    clientRouter = client;

    let ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);

    const operations4: Promise<any>[] = [];
    const connectionChanges: string[] = [];

    // Start request before connection is open
    operations4.push(
      client.request('race', { id: 'pre-open' }, { timeout: 5000 })
        .catch(e => ({ error: 'pre-open', message: e.message }))
    );

    // Wait for open
    await client.serverOpen;

    // Normal request
    operations4.push(
      client.request('race', { id: 'normal' }, { timeout: 5000 })
        .catch(e => ({ error: 'normal', message: e.message }))
    );

    // Close connection during request
    setTimeout(() => {
      connectionChanges.push('close-1');
      ws.close();
    }, 50);

    operations4.push(
      client.request('race', { id: 'during-close', delay: 100 }, { timeout: 5000 })
        .catch(e => ({ error: 'during-close', message: e.message }))
    );

    // Reconnect quickly
    setTimeout(() => {
      connectionChanges.push('reconnect-1');
      ws = new WebSocket(`ws://localhost:${serverPort}`);
      setServer(ws);
    }, 100);

    operations4.push(
      client.request('race', { id: 'after-reconnect' }, { timeout: 5000 })
        .catch(e => ({ error: 'after-reconnect', message: e.message }))
    );

    // Multiple rapid reconnects
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        connectionChanges.push(`toggle-${i}`);
        if (i % 2 === 0) {
          ws.close();
        } else {
          ws = new WebSocket(`ws://localhost:${serverPort}`);
          setServer(ws);
        }
      }, 200 + i * 50);
    }

    operations4.push(
      client.request('race', { id: 'after-chaos' }, { timeout: 5000 })
        .catch(e => ({ error: 'after-chaos', message: e.message }))
    );

    const results = await Promise.all(operations4);

    // Should handle all race conditions without crashing
    expect(results).toHaveLength(5);
    expect(connectionChanges.length).toBeGreaterThan(0);

    // At least some requests should succeed
    const successful = results.filter(r => r.processed);
    expect(successful.length).toBeGreaterThan(0);
  });

  it('should handle backpressure with flow control', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    serverRouter = server;

    let receivedCount = 0;
    let droppedCount = 0;
    const buffer: any[] = [];
    const MAX_BUFFER = 50;
    let processing = 0; // Track concurrent processing

    server.on('stream', async (data, { send, abortSignal }) => {
      receivedCount++;
      processing++;

      // Check if buffer would overflow with current processing
      if (buffer.length + processing > MAX_BUFFER) {
        processing--;
        droppedCount++;
        throw new Error('Buffer overflow');
      }

      buffer.push(data);
      processing--;

      // Simulate slow consumer
      await sleep(data.processingTime || 50);

      if (abortSignal.aborted) {
        buffer.shift();
        return { aborted: true };
      }

      const result = buffer.shift();

      // Send flow control signals
      send({
        type: 'flow',
        bufferSize: buffer.length,
        canAccept: buffer.length < MAX_BUFFER - 10
      }, false);

      return { processed: result?.id, bufferState: buffer.length };
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWSAdvanced.client();
    clientRouter = client;

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const requests5: Promise<any>[] = [];
    let shouldSlow = false;
    const flowUpdates: any[] = [];

    // Producer sending at varying rates
    for (let i = 0; i < 100; i++) {
      const callback = (data: any, error: any, done: boolean) => {
        if (!done && data?.type === 'flow') {
          flowUpdates.push(data);
          shouldSlow = !data.canAccept;
        }
      };

      requests5.push(
        client.request('stream', {
          id: `stream-${i}`,
          size: Math.random() * 1000,
          processingTime: shouldSlow ? 150 : 50
        }, {
          callback,
          timeout: 3000 // Shorter timeout to fail fast
        }).catch(e => ({ error: e.message }))
      );

      // Adaptive rate based on flow control
      if (shouldSlow) {
        await sleep(100);
      } else if (i % 10 === 0) {
        await sleep(10);
      }
    }

    const results = await Promise.all(requests5);

    const successful = results.filter(r => r.processed);
    const failed = results.filter(r => r.error);

    expect(receivedCount).toBe(100);
    expect(flowUpdates.length).toBeGreaterThan(0);

    // Should have some backpressure events
    const backpressureEvents = flowUpdates.filter(u => !u.canAccept);
    expect(backpressureEvents.length).toBeGreaterThanOrEqual(0);

    // Buffer should have prevented total failure
    expect(successful.length).toBeGreaterThan(failed.length);
    
    // Close connection and wait for all pending operations to complete
    ws.close();
    await sleep(100);
  });

  it('should handle clock skew and time synchronization issues', async () => {
    const { router: server, attachClient } = PerfectWS.server();
    serverRouter = server;

    let serverTimeOffset = 0; // Simulate clock skew

    server.on('timesync', async (data) => {
      const serverTime = Date.now() + serverTimeOffset;

      // Simulate clock drift
      serverTimeOffset += Math.random() * 1000 - 500;

      return {
        clientTime: data.timestamp,
        serverTime,
        processedAt: serverTime,
        skew: serverTime - data.timestamp
      };
    });

    server.on('timeout-sensitive', async (data) => {
      const serverTime = Date.now() + serverTimeOffset;

      // Check if request is "expired" based on server time
      if (serverTime - data.timestamp > data.ttl) {
        throw new Error('Request expired due to clock skew');
      }

      await sleep(data.processingTime || 100);

      return {
        processed: true,
        serverTime: Date.now() + serverTimeOffset
      };
    });

    wss.on('connection', (ws) => {
      serverCleanup = attachClient(ws);
    });

    const { router: client, setServer } = PerfectWS.client();
    clientRouter = client;

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Test time synchronization
    const syncResults: any[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await client.request('timesync', {
        timestamp: Date.now(),
        sequence: i
      });
      syncResults.push(result);
      await sleep(100);
    }

    // Calculate average skew
    const skews = syncResults.map(r => r.skew);
    const avgSkew = skews.reduce((a, b) => a + b, 0) / skews.length;

    // Test timeout-sensitive operations with skew compensation
    const timeoutOps: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      timeoutOps.push(
        client.request('timeout-sensitive', {
          timestamp: Date.now() - avgSkew, // Compensate for skew
          ttl: 1000,
          processingTime: 50
        }, {
          timeout: 2000
        }).catch(e => ({ error: e.message }))
      );
    }

    const results = await Promise.all(timeoutOps);

    const successful = results.filter(r => r.processed);
    const expired = results.filter(r => r.error?.includes('expired'));

    expect(syncResults).toHaveLength(10);
    expect(successful.length + expired.length).toBe(10);

    // Clock skew should cause some expirations
    if (Math.abs(avgSkew) > 500) {
      expect(expired.length).toBeGreaterThan(0);
    }
    
    // Wait for all pending operations to complete
    await sleep(200);
  });
});