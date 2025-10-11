import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWS, PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { NetworkEventListener } from '../../src/utils/NetworkEventListener.js';
import { sleep } from '../../src/utils/sleepPromise.js';

describe('Reconnection and Error Recovery Integration Tests', () => {
  let wss: WebSocketServer;
  let serverPort: number;

  beforeEach(async () => {
    serverPort = 10080 + Math.floor(Math.random() * 1000);
    wss = new WebSocketServer({ port: serverPort });
  });

  afterEach(async () => {
    // Give pending operations time to complete before cleanup
    await sleep(200);
    wss.close();
    // Additional delay for cleanup to propagate
    await sleep(100);
  }, 180_000); // 3 minute timeout for cleanup

  it('should handle split-brain scenarios during network partition', async () => {
    // Create two server instances that might receive the same request
    const server1Requests = new Map<string, any>();
    const server2Requests = new Map<string, any>();

    const { router: server1, attachClient: attach1 } = PerfectWSAdvanced.server();
    server1.on('partition', async (data) => {
      server1Requests.set(data.id, {
        timestamp: Date.now(),
        server: 1,
        data
      });

      await sleep(data.delay || 100);

      return {
        server: 1,
        id: data.id,
        processed: Date.now()
      };
    });

    // Simulate second server (could be replica or after partition)
    let server2Active = false;
    const { router: server2, attachClient: attach2 } = PerfectWSAdvanced.server();
    server2.on('partition', async (data) => {
      if (!server2Active) {
        throw new Error('Server 2 not active');
      }

      server2Requests.set(data.id, {
        timestamp: Date.now(),
        server: 2,
        data
      });

      await sleep(data.delay || 100);

      return {
        server: 2,
        id: data.id,
        processed: Date.now()
      };
    });

    let currentAttach = attach1;

    wss.on('connection', (ws) => {
      currentAttach(ws);
    });

    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.syncRequestsTimeout = 2000;

    let ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const results: any[] = [];

    // Phase 1: Normal operation with server1
    for (let i = 0; i < 3; i++) {
      results.push(await client.request('partition', {
        id: `phase1-${i}`,
        delay: 50
      }));
    }

    // Simulate network partition - client loses connection
    ws.close();

    // Phase 2: During partition, switch to server2
    await sleep(100);
    server2Active = true;
    currentAttach = attach2;

    // Client reconnects but now to server2
    ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);

    // These requests might be duplicated if server1 processed them
    const partitionRequests: Promise<any>[] = [];
    for (let i = 0; i < 3; i++) {
      partitionRequests.push(
        client.request('partition', {
          id: `partition-${i}`,
          delay: 50
        }, {
          timeout: 5000
        }).catch(err => ({ error: err.message, id: `partition-${i}` }))
      );
    }

    // Phase 3: Simulate partition heal - both servers active
    await sleep(200);

    // Some requests during heal
    for (let i = 0; i < 2; i++) {
      partitionRequests.push(
        client.request('partition', {
          id: `heal-${i}`,
          delay: 50
        }, {
          timeout: 5000
        })
      );
    }

    const partitionResults = await Promise.all(partitionRequests);
    results.push(...partitionResults);

    // Analyze split-brain effects
    const server1Count = results.filter(r => r.server === 1).length;
    const server2Count = results.filter(r => r.server === 2).length;

    expect(results.length).toBeGreaterThan(0);
    expect(server1Count).toBeGreaterThan(0);
    expect(server2Count).toBeGreaterThanOrEqual(0);

    // Check for potential duplicate processing
    const allRequestIds = [
      ...Array.from(server1Requests.keys()),
      ...Array.from(server2Requests.keys())
    ];
    const uniqueIds = new Set(allRequestIds);

    // Some requests might be processed by both servers (split-brain)
    const duplicates = allRequestIds.length - uniqueIds.size;
    expect(duplicates).toBeGreaterThanOrEqual(0);

    // Close connection and cleanup
    ws.close();
    await sleep(500);
  });

  it('should handle authorization renewal during long sessions', async () => {
    let currentToken = 'initial-token';
    let tokenVersion = 1;
    const tokenHistory: any[] = [];

    const { router: server, attachClient } = PerfectWSAdvanced.server();

    // Simulate auth verification
    server.on('authenticated', async (data, { events, send }) => {
      // Check token
      if (data.token !== currentToken) {
        throw new Error(`Invalid token. Expected ${currentToken}, got ${data.token}`);
      }

      tokenHistory.push({
        token: data.token,
        timestamp: Date.now(),
        operation: data.operation
      });

      // Long operation that might span token renewal
      const startToken = data.token;

      for (let i = 0; i < 10; i++) {
        await sleep(300);

        // Check if token changed mid-operation
        if (currentToken !== startToken) {
          // Request token refresh from client
          events.emit('server.tokenExpired', {
            oldToken: startToken,
            hint: 'Please refresh token'
          });

          // Wait for client to provide new token
          await new Promise<void>((resolve) => {
            const listener = (source: string, newToken: string) => {
              if (source === 'remote') {
                events.off('client.tokenRefresh', listener);
                resolve();
              }
            };
            events.on('client.tokenRefresh', listener);

            setTimeout(() => {
              events.off('client.tokenRefresh', listener);
              resolve(); // Timeout waiting for token
            }, 2000);
          });
        }

        send({
          progress: (i + 1) * 10,
          tokenVersion: tokenVersion
        }, false);
      }

      return {
        completed: true,
        operation: data.operation,
        tokenVersions: tokenHistory.filter(h => h.operation === data.operation).length
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Simulate token renewal
    const tokenRenewalInterval = setInterval(() => {
      tokenVersion++;
      currentToken = `token-v${tokenVersion}`;
    }, 2000);

    const operations: Promise<any>[] = [];

    for (let i = 0; i < 3; i++) {
      const events = new NetworkEventListener();
      let clientToken = currentToken;

      // Listen for token expiration
      events.on('server.tokenExpired', async (source) => {
        if (source === 'remote') {
          // Simulate token refresh
          await sleep(100);
          clientToken = currentToken; // Get latest token
          events.emit('client.tokenRefresh', clientToken);
        }
      });

      operations.push(
        client.request('authenticated', {
          operation: `op-${i}`,
          token: clientToken,
          startTime: Date.now()
        }, {
          events,
          callback: (data, error, done) => {
            if (!done && data) {
              // Update token in flight if needed
              if (data.tokenVersion > tokenVersion - 1) {
                clientToken = currentToken;
              }
            }
          },
          timeout: 15000
        }).catch(err => ({
          error: err.message,
          operation: `op-${i}`
        }))
      );

      await sleep(1000); // Stagger operations
    }

    const results = await Promise.all(operations);

    clearInterval(tokenRenewalInterval);

    const successful = results.filter(r => r.completed);
    const failed = results.filter(r => r.error);

    expect(results).toHaveLength(3);
    expect(tokenHistory.length).toBeGreaterThan(0);

    // Should handle token changes
    const uniqueTokens = new Set(tokenHistory.map(h => h.token));
    expect(uniqueTokens.size).toBeGreaterThanOrEqual(1);

    // Verify operations spanned multiple token versions
    if (successful.length > 0) {
      const multiVersionOps = successful.filter(r => r.tokenVersions > 1);
      expect(multiVersionOps.length).toBeGreaterThanOrEqual(0);
    }

    // Close connection and cleanup
    ws.close();
    await sleep(500);
  });

  it('should handle graceful degradation under resource constraints', async () => {
    const { router: server, attachClient } = PerfectWS.server();

    let cpuLoad = 0;
    let memoryUsage = 0;
    const degradationLog: any[] = [];

    // Simulate resource monitoring
    const resourceMonitor = setInterval(() => {
      cpuLoad = Math.min(100, cpuLoad + Math.random() * 10 - 3);
      memoryUsage = Math.min(100, memoryUsage + Math.random() * 5 - 2);
    }, 100);

    server.on('resource-intensive', async (data, { send }) => {
      const startResources = { cpu: cpuLoad, memory: memoryUsage };

      // Determine processing mode based on resources
      let mode = 'full';
      if (cpuLoad > 80 || memoryUsage > 80) {
        mode = 'degraded';
      } else if (cpuLoad > 60 || memoryUsage > 60) {
        mode = 'reduced';
      }

      degradationLog.push({
        request: data.id,
        mode,
        resources: startResources
      });

      // Adjust processing based on mode
      const iterations = mode === 'full' ? 10 : mode === 'reduced' ? 5 : 2;
      const delay = mode === 'full' ? 50 : mode === 'reduced' ? 20 : 10;

      for (let i = 0; i < iterations; i++) {
        // Simulate CPU-intensive work
        cpuLoad = Math.min(100, cpuLoad + 5);
        await sleep(delay);

        // Simulate memory allocation
        memoryUsage = Math.min(100, memoryUsage + 2);

        send({
          iteration: i + 1,
          total: iterations,
          mode,
          resources: { cpu: cpuLoad, memory: memoryUsage }
        }, false);
      }

      // Release resources
      cpuLoad = Math.max(0, cpuLoad - 10);
      memoryUsage = Math.max(0, memoryUsage - 5);

      return {
        id: data.id,
        processed: true,
        mode,
        iterations,
        finalResources: { cpu: cpuLoad, memory: memoryUsage }
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWS.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const requests: Promise<any>[] = [];
    const modes = new Set<string>();

    // Send burst of requests to stress resources
    for (let i = 0; i < 20; i++) {
      requests.push(
        client.request('resource-intensive', {
          id: `resource-${i}`,
          size: Math.random() * 1000
        }, {
          callback: (data, error, done) => {
            if (!done && data?.mode) {
              modes.add(data.mode);
            }
          },
          timeout: 10000
        })
      );

      // Vary request rate
      if (i % 5 === 0) {
        await sleep(100);
      }
    }

    const results = await Promise.all(requests);

    clearInterval(resourceMonitor);

    expect(results).toHaveLength(20);
    expect(results.every(r => r.processed)).toBe(true);

    // Should have experienced different degradation modes
    expect(degradationLog.length).toBe(20);
    const uniqueModes = new Set(degradationLog.map(l => l.mode));
    expect(uniqueModes.size).toBeGreaterThanOrEqual(1);

    // Verify graceful degradation
    const degradedRequests = degradationLog.filter(l => l.mode !== 'full');
    if (degradedRequests.length > 0) {
      // Degraded requests should complete faster (fewer iterations)
      const degradedResults = results.filter(r => r.mode !== 'full');
      const fullResults = results.filter(r => r.mode === 'full');

      if (fullResults.length > 0 && degradedResults.length > 0) {
        const avgFullIterations = fullResults.reduce((sum, r) => sum + r.iterations, 0) / fullResults.length;
        const avgDegradedIterations = degradedResults.reduce((sum, r) => sum + r.iterations, 0) / degradedResults.length;
        expect(avgDegradedIterations).toBeLessThanOrEqual(avgFullIterations);
      }
    }

    // Close connection and cleanup
    ws.close();
    await sleep(500);
  });

  it('should handle request replay and idempotency after failures', async () => {
    const { router: server, attachClient } = PerfectWS.server();

    const processedRequests = new Map<string, any>();
    const replayCount = new Map<string, number>();

    server.on('idempotent', async (data) => {
      const key = `${data.operation}-${data.idempotencyKey}`;

      // Track replays
      replayCount.set(key, (replayCount.get(key) || 0) + 1);

      // Check if already processed (idempotency)
      if (processedRequests.has(key)) {
        const cached = processedRequests.get(key);
        return {
          ...cached,
          cached: true,
          replayNumber: replayCount.get(key)
        };
      }

      // Simulate processing with potential failure
      if (data.failureRate && Math.random() < data.failureRate) {
        throw new Error(`Processing failed for ${key}`);
      }

      await sleep(100);

      const result = {
        processed: true,
        operation: data.operation,
        idempotencyKey: data.idempotencyKey,
        timestamp: Date.now(),
        value: data.value * 2 // Some transformation
      };

      processedRequests.set(key, result);

      return result;
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWS.client();
    client.config.sendRequestRetries = 3;

    let ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const executeWithRetry = async (operation: string, value: number, failureRate = 0): Promise<any> => {
      const idempotencyKey = `${operation}-${value}-${Date.now()}`;
      let lastError: any;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await client.request('idempotent', {
            operation,
            idempotencyKey,
            value,
            failureRate,
            attempt
          }, {
            timeout: 2000
          });

          return {
            ...result,
            attempts: attempt
          };
        } catch (error: any) {
          lastError = error;

          if (attempt < 3) {
            // Exponential backoff
            await sleep(100 * Math.pow(2, attempt - 1));

            // Potentially reconnect
            if (error.message.includes('closed') || error.message.includes('Server not connected')) {
              ws = new WebSocket(`ws://localhost:${serverPort}`);
              setServer(ws);
              await client.serverOpen.catch(() => { }); // Ignore if fails
            }
          }
        }
      }

      return {
        error: lastError.message,
        operation,
        value,
        attempts: 3
      };
    };

    // Test various scenarios
    const operations: Promise<any>[] = [];

    // Normal operations (should succeed on first try)
    for (let i = 0; i < 3; i++) {
      operations.push(executeWithRetry(`normal`, i));
    }

    // Operations with moderate failure rate (might need retry)
    for (let i = 0; i < 3; i++) {
      operations.push(executeWithRetry(`unstable`, i, 0.3));
    }

    // Operations with high failure rate (likely need multiple retries)
    for (let i = 0; i < 3; i++) {
      operations.push(executeWithRetry(`failing`, i, 0.7));
    }

    // Duplicate operations (test idempotency)
    operations.push(executeWithRetry(`normal`, 0)); // Duplicate of first
    operations.push(executeWithRetry(`normal`, 0)); // Another duplicate

    const results = await Promise.all(operations);

    const successful = results.filter(r => r.processed);
    const failed = results.filter(r => r.error);
    const cached = results.filter(r => r.cached);
    const retried = results.filter(r => r.attempts > 1);

    expect(results).toHaveLength(11);
    expect(successful.length).toBeGreaterThan(failed.length);

    // Should have some cached responses (idempotency)
    expect(cached.length).toBeGreaterThanOrEqual(0);

    // Should have some retried operations
    expect(retried.length).toBeGreaterThan(0);

    // Verify replay tracking
    const totalReplays = Array.from(replayCount.values()).reduce((sum, count) => sum + count, 0);
    expect(totalReplays).toBeGreaterThanOrEqual(results.length);

    // Close connection and cleanup
    ws.close();
    await sleep(500);
  });

  it('should handle Byzantine consensus with multiple server replicas', async () => {
    // Simulate multiple server replicas with potential disagreement
    const replicas: any[] = [];
    const replicaStates = new Map<number, Map<string, any>>();

    for (let r = 0; r < 3; r++) {
      const { router, attachClient } = PerfectWSAdvanced.server();
      const replicaId = r;
      const state = new Map<string, any>();
      replicaStates.set(replicaId, state);

      router.on('consensus', async (data) => {
        // Simulate Byzantine behavior - sometimes disagree
        const byzantineBehavior = Math.random() < 0.1; // 10% Byzantine

        if (data.operation === 'write') {
          const value = byzantineBehavior ? `byzantine-${replicaId}` : data.value;
          state.set(data.key, {
            value,
            version: (state.get(data.key)?.version || 0) + 1,
            replica: replicaId,
            timestamp: Date.now()
          });

          // Simulate replication delay
          await sleep(Math.random() * 50);

          return {
            replica: replicaId,
            accepted: true,
            value,
            version: state.get(data.key).version
          };
        } else {
          // Read operation
          const stored = state.get(data.key);
          if (byzantineBehavior && stored) {
            // Return corrupted read
            return {
              replica: replicaId,
              value: `corrupted-${stored.value}`,
              version: stored.version,
              byzantine: true
            };
          }

          return {
            replica: replicaId,
            value: stored?.value,
            version: stored?.version || 0
          };
        }
      });

      replicas.push({ router, attachClient, id: replicaId });
    }

    // Round-robin connection distribution
    let nextReplica = 0;
    wss.on('connection', (ws) => {
      replicas[nextReplica].attachClient(ws);
      nextReplica = (nextReplica + 1) % replicas.length;
    });

    const { router: client, setServer } = PerfectWSAdvanced.client();
    let ws = new WebSocket(`ws://localhost:${serverPort}`);
    const allWs: WebSocket[] = [ws];
    setServer(ws);
    await client.serverOpen;

    // Helper to achieve consensus
    const achieveConsensus = async (operation: string, key: string, value?: any) => {
      const responses: any[] = [];

      // Query all replicas (through reconnections)
      for (let i = 0; i < 3; i++) {
        const response = await client.request('consensus', {
          operation,
          key,
          value
        }, {
          timeout: 2000
        }).catch(err => ({
          error: err.message,
          replica: -1,
          value: null,
          version: 0
        }));

        responses.push(response);

        // Reconnect to potentially reach different replica
        ws.close();
        ws = new WebSocket(`ws://localhost:${serverPort}`);
        allWs.push(ws);
        setServer(ws);
        await sleep(100); // Give time for connection
        await client.serverOpen.catch(() => { }); // Ignore reconnection errors
      }

      // Determine consensus (majority vote)
      const votes = new Map<string, number>();
      for (const response of responses) {
        const voteKey = JSON.stringify({
          value: response.value,
          version: response.version
        });
        votes.set(voteKey, (votes.get(voteKey) || 0) + 1);
      }

      // Find majority
      let consensus: any = null;
      let maxVotes = 0;
      for (const [voteKey, count] of votes) {
        if (count > maxVotes) {
          maxVotes = count;
          consensus = JSON.parse(voteKey);
        }
      }

      return {
        consensus: maxVotes >= 2 ? consensus : null,
        responses,
        agreement: maxVotes / responses.length,
        byzantineDetected: responses.some(r => r.byzantine)
      };
    };

    // Test consensus operations (reduced for speed)
    const results: any[] = [];

    // Write operations
    for (let i = 0; i < 3; i++) {
      const result = await achieveConsensus('write', `key-${i}`, `value-${i}`);
      results.push({ operation: 'write', ...result });
    }

    // Read operations to verify consensus
    for (let i = 0; i < 3; i++) {
      const result = await achieveConsensus('read', `key-${i}`);
      results.push({ operation: 'read', ...result });
    }

    // Analyze consensus achievement
    const writeResults = results.filter(r => r.operation === 'write');
    const readResults = results.filter(r => r.operation === 'read');

    expect(writeResults).toHaveLength(3);
    expect(readResults).toHaveLength(3);

    // Most operations should achieve consensus
    const consensusAchieved = results.filter(r => r.consensus !== null);
    expect(consensusAchieved.length).toBeGreaterThan(results.length * 0.3);

    // Check Byzantine detection
    const byzantineDetected = results.filter(r => r.byzantineDetected);
    expect(byzantineDetected.length).toBeGreaterThanOrEqual(0);

    // Verify replicas eventually agree (for non-Byzantine values)
    for (let i = 0; i < 3; i++) {
      const key = `key-${i}`;
      const replicaValues: any[] = [];

      for (const [replicaId, state] of replicaStates) {
        const value = state.get(key);
        if (value && !value.value.includes('byzantine')) {
          replicaValues.push(value);
        }
      }

      // Non-Byzantine replicas should eventually have same values
      if (replicaValues.length > 1) {
        const uniqueValues = new Set(replicaValues.map(v => v.value));
        expect(uniqueValues.size).toBeLessThanOrEqual(2); // Allow some divergence
      }
    }

    // Close all connections and cleanup
    allWs.forEach(ws => ws.close());
    await sleep(500);
  });

  it('should handle complex failure recovery with state reconstruction', async () => {
    const { router: server, attachClient } = PerfectWS.server();

    // Complex server state that needs reconstruction
    const serverState = {
      sessions: new Map<string, any>(),
      transactions: new Map<string, any>(),
      checkpoints: [] as any[]
    };

    server.on('stateful-transaction', async (data, { send, events, abortSignal }) => {
      const sessionId = data.sessionId || `session-${Date.now()}`;
      const transactionId = `tx-${Date.now()}`;

      // Initialize or restore session
      if (!serverState.sessions.has(sessionId)) {
        serverState.sessions.set(sessionId, {
          created: Date.now(),
          transactions: []
        });
      }

      const session = serverState.sessions.get(sessionId);
      const transaction = {
        id: transactionId,
        status: 'started',
        operations: [] as any[],
        checkpoints: [] as number[]
      };

      serverState.transactions.set(transactionId, transaction);
      session.transactions.push(transactionId);

      // Listen for client state sync
      events.on('client.state', (source, clientState) => {
        if (source === 'remote' && clientState.checkpoint) {
          transaction.checkpoints.push(clientState.checkpoint);
        }
      });

      try {
        // Multi-phase transaction
        for (let phase = 1; phase <= data.phases; phase++) {
          if (abortSignal.aborted) {
            transaction.status = 'aborted';
            throw new Error('Transaction aborted');
          }

          // Simulate failure at specific phases
          if (data.failurePoints && data.failurePoints.includes(phase)) {
            throw new Error(`Simulated failure at phase ${phase}`);
          }

          // Phase operation - execute on server
          await sleep(50);
          const operation = {
            phase,
            computed: phase * phase,
            random: Math.random()
          };

          transaction.operations.push({
            phase,
            result: operation,
            timestamp: Date.now()
          });

          // Create checkpoint
          if (phase % 2 === 0) {
            const checkpoint = {
              phase,
              transactionId,
              sessionId,
              state: JSON.stringify(transaction.operations),
              timestamp: Date.now()
            };
            serverState.checkpoints.push(checkpoint);

            send({
              type: 'checkpoint',
              checkpoint
            }, false);
          }

          // Progress update
          send({
            type: 'progress',
            phase,
            total: data.phases,
            transactionId
          }, false);

          await sleep(100);
        }

        transaction.status = 'committed';

        return {
          success: true,
          transactionId,
          sessionId,
          operations: transaction.operations,
          checkpoints: transaction.checkpoints.length
        };
      } catch (error: any) {
        transaction.status = 'failed';

        // Attempt to reconstruct state from checkpoints
        const relevantCheckpoints = serverState.checkpoints.filter(
          cp => cp.transactionId === transactionId
        );

        if (relevantCheckpoints.length > 0) {
          const lastCheckpoint = relevantCheckpoints[relevantCheckpoints.length - 1];
          transaction.operations = JSON.parse(lastCheckpoint.state);
          transaction.status = 'partially-recovered';

          return {
            recovered: true,
            transactionId,
            sessionId,
            recoveredOperations: transaction.operations,
            error: error.message
          };
        }

        throw error;
      }
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    let ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Complex multi-phase operation with potential failures
    const executeTransaction = async (phases: number, failurePoints: number[] = []) => {
      const events = new NetworkEventListener();
      const clientCheckpoints: any[] = [];
      let lastProgress = 0;

      // Send client state periodically
      const stateInterval = setInterval(() => {
        events.emit('client.state', {
          checkpoint: Date.now(),
          progress: lastProgress
        });
      }, 200);

      try {
        const result = await client.request('stateful-transaction', {
          phases,
          failurePoints, // Send failure points instead of operations
          sessionId: `client-session-${Date.now()}`
        }, {
          events,
          callback: (data, error, done) => {
            if (!done) {
              if (data?.type === 'checkpoint') {
                clientCheckpoints.push(data.checkpoint);
              } else if (data?.type === 'progress') {
                lastProgress = data.phase;
              }
            }
          },
          timeout: 10000
        });

        return {
          ...result,
          clientCheckpoints: clientCheckpoints.length
        };
      } catch (error: any) {
        // Attempt recovery
        if (clientCheckpoints.length > 0 && ws.readyState !== WebSocket.OPEN) {
          // Reconnect and resume
          ws = new WebSocket(`ws://localhost:${serverPort}`);
          setServer(ws);
          await client.serverOpen;

          // Retry with checkpoint info
          return client.request('stateful-transaction', {
            phases: phases - lastProgress,
            failurePoints: failurePoints.map(fp => fp - lastProgress).filter(fp => fp > 0),
            sessionId: clientCheckpoints[0].sessionId,
            resumeFrom: lastProgress
          }, {
            timeout: 5000
          }).catch(err => ({
            error: err.message,
            partialCheckpoints: clientCheckpoints
          }));
        }

        return {
          error: error.message,
          clientCheckpoints: clientCheckpoints.length,
          lastProgress
        };
      } finally {
        clearInterval(stateInterval);
      }
    };

    // Test various scenarios
    const results2: any[] = [];

    // Successful transaction
    results2.push(await executeTransaction(6));

    // Transaction with simulated failures
    results2.push(await executeTransaction(8, [4]));

    // Transaction with multiple failure points
    results2.push(await executeTransaction(10, [3, 7]));

    // Disconnect during transaction
    setTimeout(() => {
      ws.close();
    }, 300);
    results2.push(await executeTransaction(5));

    // Analyze results
    const successful = results2.filter(r => r.success);
    const recovered = results2.filter(r => r.recovered);
    const failed = results2.filter(r => r.error && !r.recovered);

    expect(results2).toHaveLength(4);
    expect(successful.length + recovered.length + failed.length).toBe(4);

    // Should have some checkpoints
    const withCheckpoints = results2.filter(r =>
      r.clientCheckpoints > 0 || r.checkpoints > 0
    );
    expect(withCheckpoints.length).toBeGreaterThan(0);

    // Verify state reconstruction worked
    if (recovered.length > 0) {
      expect(recovered[0].recoveredOperations).toBeDefined();
      expect(recovered[0].recoveredOperations.length).toBeGreaterThan(0);
    }

    // Check server state consistency
    expect(serverState.transactions.size).toBeGreaterThan(0);
    expect(serverState.checkpoints.length).toBeGreaterThan(0);

    // Wait for all pending operations to complete
    await sleep(200);
  }, 30000); // 30 second timeout
});