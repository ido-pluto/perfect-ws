import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfectWS, PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { NetworkEventListener } from '../../src/utils/NetworkEventListener.js';
import { sleep } from '../../src/utils/sleepPromise.js';

describe('Data Streaming and Transformation Integration Tests', () => {
  let wss: WebSocketServer;
  let serverPort: number;

  beforeEach(async () => {
    serverPort = 9080 + Math.floor(Math.random() * 1000);
    wss = new WebSocketServer({ port: serverPort });
  });

  afterEach(async () => {
    // Give pending operations time to complete before cleanup
    await sleep(100);
    wss.close()
    // Additional delay for cleanup to propagate
    await sleep(50);
  });

  it('should handle complex nested function transformations across network', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    // Complex nested structure with functions
    server.on('executeComplex', async (data) => {
      const composed = await data.operations.compose(
        data.operations.map,
        data.operations.filter,
        data.operations.reduce
      );

      const results: {
        mapResult: any;
        filterResult: any;
        reduceResult: any;
        composedResult: any;
        asyncResult: any;
        generatorResult: any[];
      } = {
        mapResult: await data.operations.map(data.items),
        filterResult: await data.operations.filter(data.items),
        reduceResult: await data.operations.reduce(data.items),
        composedResult: await composed(data.items),
        asyncResult: await data.operations.asyncProcess(data.items),
        generatorResult: [] as any[]
      };

      // Handle generator function
      if (data.operations.generator) {
        const gen = await data.operations.generator();
        let result = await gen.next();
        while (!result.done) {
          results.generatorResult.push(result.value);
          result = await gen.next();
        }
      }

      return results;
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws as any);
    await client.serverOpen;

    const testData = {
      items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      operations: {
        map: (arr: number[]) => arr.map(x => x * 2),
        filter: (arr: number[]) => arr.filter(x => x % 2 === 0),
        reduce: (arr: number[]) => arr.reduce((a, b) => a + b, 0),
        compose: (...fns: Function[]) => async (input: any) => {
          let result = input;
          for (const fn of fns) {
            result = await fn(result);
          }
          return result;
        },
        asyncProcess: async (arr: number[]) => {
          await sleep(100);
          return arr.map(x => x * x);
        },
        generator: function* () {
          for (let i = 0; i < 5; i++) {
            yield i * i;
          }
        }
      }
    };

    const result = await client.request('executeComplex', testData);

    expect(result.mapResult).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(result.filterResult).toEqual([2, 4, 6, 8, 10]);
    expect(result.reduceResult).toBe(55);
    expect(result.asyncResult).toEqual([1, 4, 9, 16, 25, 36, 49, 64, 81, 100]);
    expect(result.generatorResult).toEqual([0, 1, 4, 9, 16]);
    expect(result.composedResult).toBe(110); // map -> filter -> reduce
  });

  it('should handle streaming with multiple custom class transformations', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();
    server.config.syncRequestsWhenServerOpen = false;

    // Custom classes
    class TimeSeries {
      constructor(public data: number[], public timestamps: number[]) { }

      average() {
        return this.data.reduce((a, b) => a + b, 0) / this.data.length;
      }

      interpolate(timestamp: number): number {
        // Simple linear interpolation
        for (let i = 1; i < this.timestamps.length; i++) {
          if (timestamp <= this.timestamps[i]) {
            const ratio = (timestamp - this.timestamps[i - 1]) /
              (this.timestamps[i] - this.timestamps[i - 1]);
            return this.data[i - 1] + ratio * (this.data[i] - this.data[i - 1]);
          }
        }
        return this.data[this.data.length - 1];
      }
    }

    class DataPoint {
      constructor(
        public value: number,
        public metadata: { source: string; quality: number; }
      ) { }

      validate(): boolean {
        return this.metadata.quality > 0.5 && this.value !== null;
      }
    }

    // Register transformations
    server.transformers = [
      {
        check: (data): data is TimeSeries => data instanceof TimeSeries,
        uniqueId: 'TimeSeries',
        serialize: (obj) => JSON.stringify({
          data: obj.data,
          timestamps: obj.timestamps
        }),
        deserialize: (str) => {
          const parsed = JSON.parse(str);
          return new TimeSeries(parsed.data, parsed.timestamps);
        }
      },
      {
        check: (data): data is DataPoint => data instanceof DataPoint,
        uniqueId: 'DataPoint',
        serialize: (obj) => JSON.stringify({
          value: obj.value,
          metadata: obj.metadata
        }),
        deserialize: (str) => {
          const parsed = JSON.parse(str);
          return new DataPoint(parsed.value, parsed.metadata);
        }
      }
    ];

    server.on('processTimeSeries', async (data, { send }) => {
      const { series, points } = data;

      // Validate all data points
      const validPoints = points.filter((p: DataPoint) => p.validate());

      // Process time series in chunks
      const chunkSize = 10;
      const results: any[] = [];

      for (let i = 0; i < series.data.length; i += chunkSize) {
        const chunk = series.data.slice(i, i + chunkSize);
        const chunkTimestamps = series.timestamps.slice(i, i + chunkSize);

        const chunkSeries = new TimeSeries(chunk, chunkTimestamps);
        const avg = chunkSeries.average();

        // Stream progress
        send({
          type: 'progress',
          processed: Math.min(i + chunkSize, series.data.length),
          total: series.data.length,
          chunkAverage: avg
        }, false);

        results.push({
          startIndex: i,
          average: avg,
          interpolated: chunkSeries.interpolate(
            (chunkTimestamps[0] + chunkTimestamps[chunkTimestamps.length - 1]) / 2
          )
        });

        await sleep(50); // Simulate processing time
      }

      return {
        processed: true,
        results,
        validPointsCount: validPoints.length,
        seriesAverage: series.average()
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();

    // Register same transformations on client
    client.transformers = server.transformers;

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws as any);
    await client.serverOpen;

    // Create test data
    const timestamps = Array.from({ length: 100 }, (_, i) => Date.now() + i * 1000);
    const data = Array.from({ length: 100 }, (_, i) => Math.sin(i / 10) * 100);
    const series = new TimeSeries(data, timestamps);

    const points = Array.from({ length: 20 }, (_, i) =>
      new DataPoint(
        Math.random() * 100,
        {
          source: `sensor-${i}`,
          quality: Math.random()
        }
      )
    );

    const progressUpdates: any[] = [];
    const result = await client.request('processTimeSeries',
      { series, points },
      {
        callback: (data, error, done) => {
          if (!done && data?.type === 'progress') {
            progressUpdates.push(data);
          }
        },
        timeout: 10000
      }
    );

    expect(result.processed).toBe(true);
    expect(result.results).toHaveLength(10); // 100 items in chunks of 10
    expect(progressUpdates).toHaveLength(10);
    expect(progressUpdates[progressUpdates.length - 1].processed).toBe(100);
    expect(typeof result.seriesAverage).toBe('number');
  });

  it('should handle bidirectional event streaming with complex data flow', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('collaborative', async (data, { events, send }) => {
      const serverState = {
        clients: new Set<string>(),
        operations: [] as any[],
        checkpoints: [] as number[]
      };

      // Listen for client events
      events.on('client.operation', (source, operation) => {
        if (source === 'remote') {
          serverState.operations.push(operation);

          // Broadcast to other clients (simulated)
          events.emit('server.broadcast', {
            from: operation.clientId,
            operation: operation.type,
            timestamp: Date.now()
          });

          // Send acknowledgment
          send({
            type: 'ack',
            operationId: operation.id,
            serverTimestamp: Date.now()
          }, false);
        }
      });

      events.on('client.checkpoint', (source, checkpoint) => {
        if (source === 'remote') {
          serverState.checkpoints.push(checkpoint.timestamp);

          // Validate checkpoint
          const isValid = serverState.operations.length >= checkpoint.operationCount;

          events.emit('server.checkpoint.result', {
            checkpointId: checkpoint.id,
            valid: isValid,
            serverOperationCount: serverState.operations.length
          });
        }
      });

      // Simulate server-side processing
      const processingInterval = setInterval(() => {
        events.emit('server.heartbeat', {
          timestamp: Date.now(),
          load: Math.random(),
          activeOperations: serverState.operations.length
        });
      }, 500);

      // Wait for collaboration session
      await sleep(data.duration);

      clearInterval(processingInterval);

      return {
        totalOperations: serverState.operations.length,
        checkpoints: serverState.checkpoints.length,
        summary: {
          operations: serverState.operations.slice(0, 10), // First 10
          avgOperationsPerSecond: serverState.operations.length / (data.duration / 1000)
        }
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const events = new NetworkEventListener();
    const clientState = {
      acknowledgments: [] as any[],
      broadcasts: [] as any[],
      heartbeats: [] as any[],
      checkpointResults: [] as any[]
    };

    // Set up client event listeners
    events.on('server.broadcast', (source, data) => {
      if (source === 'remote') {
        clientState.broadcasts.push(data);
      }
    });

    events.on('server.heartbeat', (source, data) => {
      if (source === 'remote') {
        clientState.heartbeats.push(data);
      }
    });

    events.on('server.checkpoint.result', (source, data) => {
      if (source === 'remote') {
        clientState.checkpointResults.push(data);
      }
    });

    // Start collaborative session
    const sessionPromise = client.request('collaborative',
      { duration: 3000 },
      {
        events,
        callback: (data, error, done) => {
          if (!done && data?.type === 'ack') {
            clientState.acknowledgments.push(data);
          }
        },
        timeout: 5000
      }
    );

    // Simulate client operations
    const clientId = 'client-' + Math.random().toString(36).substr(2, 9);

    for (let i = 0; i < 20; i++) {
      events.emit('client.operation', {
        id: `op-${i}`,
        clientId,
        type: i % 3 === 0 ? 'write' : 'read',
        data: `data-${i}`
      });
      await sleep(100);
    }

    // Create checkpoints
    events.emit('client.checkpoint', {
      id: 'checkpoint-1',
      timestamp: Date.now(),
      operationCount: 10
    });

    await sleep(500);

    events.emit('client.checkpoint', {
      id: 'checkpoint-2',
      timestamp: Date.now(),
      operationCount: 20
    });

    const result = await sessionPromise;

    expect(result.totalOperations).toBe(20);
    expect(result.checkpoints).toBe(2);
    expect(clientState.acknowledgments).toHaveLength(20);
    expect(clientState.broadcasts).toHaveLength(20);
    expect(clientState.heartbeats.length).toBeGreaterThan(0);
    expect(clientState.checkpointResults).toHaveLength(2);
    expect(clientState.checkpointResults.every(r => r.valid)).toBe(true);
  });

  it('should handle circular reference serialization with depth limits', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('circular', async (data) => {
      // Recreate circular structure on server
      const processedNodes = new Map<string, any>();

      const processNode = (node: any, depth = 0): any => {
        if (depth > 10) return { truncated: true };

        if (processedNodes.has(node.id)) {
          return { circular: node.id };
        }

        const processed: any = {
          id: node.id,
          value: node.value,
          depth
        };

        processedNodes.set(node.id, processed);

        if (node.children) {
          processed.children = node.children.map((child: any) =>
            processNode(child, depth + 1)
          );
        }

        if (node.parent && depth < 5) {
          processed.parent = processNode(node.parent, depth + 1);
        }

        if (node.siblings) {
          processed.siblings = node.siblings.map((sib: any) =>
            processNode(sib, depth + 1)
          );
        }

        return processed;
      };

      const result = processNode(data.root);

      return {
        processed: true,
        nodeCount: processedNodes.size,
        maxDepthReached: Math.max(...Array.from(processedNodes.values()).map(n => n.depth)),
        structure: result
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.maxTransformDepth = 15; // Set depth limit

    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Create complex circular structure
    type CircularNode = {
      id: string;
      value: any;
      children: CircularNode[];
      siblings: CircularNode[];
      parent: CircularNode | null;
    };
    const createNode = (id: string, value: any): CircularNode => ({ id, value, children: [], siblings: [], parent: null });

    const root = createNode('root', 'ROOT');
    const child1 = createNode('child1', 'C1');
    const child2 = createNode('child2', 'C2');
    const grandchild1 = createNode('gc1', 'GC1');
    const grandchild2 = createNode('gc2', 'GC2');

    // Build relationships
    root.children = [child1, child2];
    child1.parent = root;
    child2.parent = root;
    child1.siblings = [child2];
    child2.siblings = [child1];

    child1.children = [grandchild1];
    grandchild1.parent = child1;

    child2.children = [grandchild2];
    grandchild2.parent = child2;

    grandchild1.siblings = [grandchild2];
    grandchild2.siblings = [grandchild1];

    // Create circular reference
    grandchild1.children = [root]; // Circular!
    root.parent = grandchild1; // More circular!

    const result = await client.request('circular', { root });

    expect(result.processed).toBe(true);
    expect(result.nodeCount).toBeGreaterThan(0);
    expect(result.maxDepthReached).toBeLessThanOrEqual(10);
    expect(result.structure).toBeDefined();
  });

  it('should handle mixed binary and object streaming with compression', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('mixedStream', async (data, { send }) => {
      const chunks = data.chunks;
      const results: any[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let processed: any;

        if (chunk.type === 'binary') {
          // Process binary data
          const buffer = Buffer.from(chunk.data);
          const compressed = buffer.toString('base64');
          processed = {
            type: 'binary',
            original: buffer.length,
            compressed: compressed.length,
            ratio: compressed.length / buffer.length
          };
        } else if (chunk.type === 'object') {
          // Process object data with transformation
          processed = {
            type: 'object',
            keys: Object.keys(chunk.data).length,
            transformed: JSON.stringify(chunk.data).length
          };
        } else if (chunk.type === 'function') {
          // Execute function
          const result = await chunk.data(i);
          processed = {
            type: 'function',
            result,
            index: i
          };
        }

        results.push(processed);

        // Stream progress with mixed content
        send({
          progress: ((i + 1) / chunks.length) * 100,
          currentType: chunk.type,
          processed,
          stats: {
            binary: results.filter(r => r.type === 'binary').length,
            object: results.filter(r => r.type === 'object').length,
            function: results.filter(r => r.type === 'function').length
          }
        }, false);

        await sleep(20);
      }

      return {
        totalChunks: chunks.length,
        results,
        summary: {
          avgCompressionRatio: results
            .filter(r => r.type === 'binary')
            .reduce((sum, r) => sum + (r as any).ratio, 0) /
            results.filter(r => r.type === 'binary').length || 0
        }
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Create mixed content
    const chunks: any[] = [];

    // Binary chunks
    for (let i = 0; i < 5; i++) {
      const buffer = Buffer.alloc(1024 * (i + 1));
      buffer.fill(i);
      chunks.push({
        type: 'binary',
        data: Array.from(buffer)
      });
    }

    // Object chunks
    for (let i = 0; i < 5; i++) {
      chunks.push({
        type: 'object',
        data: {
          id: `obj-${i}`,
          nested: {
            value: Math.random(),
            array: Array(10).fill(i)
          }
        }
      });
    }

    // Function chunks
    for (let i = 0; i < 5; i++) {
      chunks.push({
        type: 'function',
        data: async (index: number) => {
          await sleep(10);
          return index * index;
        }
      });
    }

    const progressUpdates: any[] = [];
    const result = await client.request('mixedStream',
      { chunks },
      {
        callback: (data, error, done) => {
          if (!done && data) {
            progressUpdates.push(data);
          }
        },
        timeout: 10000
      }
    );

    expect(result.totalChunks).toBe(15);
    expect(result.results).toHaveLength(15);
    expect(progressUpdates).toHaveLength(15);
    expect(progressUpdates[progressUpdates.length - 1].progress).toBe(100);
    expect(result.summary.avgCompressionRatio).toBeGreaterThan(0);

    const stats = progressUpdates[progressUpdates.length - 1].stats;
    expect(stats.binary).toBe(5);
    expect(stats.object).toBe(5);
    expect(stats.function).toBe(5);
  });

  it('should handle recursive async operations with nested callbacks', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('recursive', async (data) => {
      const { depth, operation, accumulator } = data;

      const recurse = async (currentDepth: number, acc: any[]): Promise<any> => {
        if (currentDepth === 0) {
          return {
            final: true,
            accumulated: acc,
            depth: depth
          };
        }

        // Execute operation at this level
        const result = await operation(currentDepth, acc);
        acc.push(result);

        // Recursive call with transformed operation
        return recurse(currentDepth - 1, acc);
      };

      const finalResult = await recurse(depth, accumulator || []);

      // Post-process with another function if provided
      if (data.postProcess) {
        finalResult.postProcessed = await data.postProcess(finalResult.accumulated);
      }

      return finalResult;
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const result = await client.request('recursive', {
      depth: 10,
      operation: async (level: number, acc: number[]) => {
        // Fibonacci-like operation
        if (acc.length < 2) {
          return level;
        }
        const last = acc[acc.length - 1];
        const secondLast = acc[acc.length - 2];
        return last + secondLast + level;
      },
      postProcess: async (accumulated: number[]) => {
        return {
          sum: accumulated.reduce((a, b) => a + b, 0),
          max: Math.max(...accumulated),
          min: Math.min(...accumulated),
          average: accumulated.reduce((a, b) => a + b, 0) / accumulated.length
        };
      },
      accumulator: []
    });

    expect(result.final).toBe(true);
    expect(result.accumulated).toHaveLength(10);
    expect(result.depth).toBe(10);
    expect(result.postProcessed).toBeDefined();
    expect(result.postProcessed.sum).toBeGreaterThan(0);
    expect(result.postProcessed.average).toBeGreaterThan(0);
  });

  it('should handle parallel stream processing with fan-out/fan-in pattern', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('fanout', async (data, { send, events }) => {
      const { items, workers } = data;

      // Fan-out: distribute work to multiple workers
      const workerPromises: Promise<any>[] = [];
      const workerResults = new Map<number, any[]>();

      for (let w = 0; w < workers.length; w++) {
        const worker = workers[w];
        const workerItems = items.filter((_: any, i: number) => i % workers.length === w);

        workerPromises.push(
          (async () => {
            const results: any[] = [];
            for (let item of workerItems) {
              const result = await worker.process(item);
              results.push(result);

              // Emit worker progress
              events.emit('worker.progress', {
                workerId: w,
                processed: results.length,
                total: workerItems.length
              });
            }
            return { workerId: w, results };
          })()
        );
      }

      // Wait for all workers
      const workerOutputs = await Promise.all(workerPromises);

      // Fan-in: combine results
      if (data.combiner) {
        const combined = await data.combiner(workerOutputs);

        return {
          pattern: 'fan-out/fan-in',
          workerCount: workers.length,
          itemsProcessed: items.length,
          combined
        };
      }

      return {
        pattern: 'fan-out',
        workerCount: workers.length,
        itemsProcessed: items.length,
        workerOutputs
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Create test data
    const items = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      value: Math.random() * 100
    }));

    // Define workers with different processing strategies
    const workers = [
      {
        name: 'multiplier',
        process: async (item: any) => {
          await sleep(5);
          return { ...item, processed: item.value * 2 };
        }
      },
      {
        name: 'squarer',
        process: async (item: any) => {
          await sleep(5);
          return { ...item, processed: item.value * item.value };
        }
      },
      {
        name: 'rooter',
        process: async (item: any) => {
          await sleep(5);
          return { ...item, processed: Math.sqrt(item.value) };
        }
      }
    ];

    const events = new NetworkEventListener();
    const workerProgress = new Map<number, any[]>();

    events.on('worker.progress', (source, data) => {
      if (source === 'remote') {
        if (!workerProgress.has(data.workerId)) {
          workerProgress.set(data.workerId, []);
        }
        workerProgress.get(data.workerId)!.push(data);
      }
    });

    const result = await client.request('fanout',
      {
        items,
        workers,
        combiner: async (outputs: any[]) => {
          // Combine worker results
          const allResults = outputs.flatMap(o => o.results);

          return {
            totalProcessed: allResults.length,
            averageValue: allResults.reduce((sum, r) => sum + r.processed, 0) / allResults.length,
            workerStats: outputs.map(o => ({
              workerId: o.workerId,
              count: o.results.length
            }))
          };
        }
      },
      { events, timeout: 15000 }
    );

    expect(result.pattern).toBe('fan-out/fan-in');
    expect(result.workerCount).toBe(3);
    expect(result.itemsProcessed).toBe(100);
    expect(result.combined.totalProcessed).toBe(100);
    expect(result.combined.workerStats).toHaveLength(3);

    // Verify worker progress tracking
    expect(workerProgress.size).toBe(3);
    for (let [workerId, progress] of workerProgress) {
      expect(progress.length).toBeGreaterThan(0);
    }
  });

  it('should handle data pipeline with transformation stages', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('pipeline', async (data, { send }) => {
      const { input, stages } = data;
      let current = input;
      const stageResults: any[] = [];

      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];

        // Execute stage
        const stageStart = Date.now();
        current = await stage.transform(current);
        const stageDuration = Date.now() - stageStart;

        // Validate if validator provided
        if (stage.validate) {
          const isValid = await stage.validate(current);
          if (!isValid) {
            throw new Error(`Validation failed at stage ${i}: ${stage.name}`);
          }
        }

        stageResults.push({
          name: stage.name,
          duration: stageDuration,
          outputSize: JSON.stringify(current).length
        });

        // Stream stage completion
        send({
          type: 'stage-complete',
          stageIndex: i,
          stageName: stage.name,
          duration: stageDuration
        }, false);
      }

      return {
        success: true,
        output: current,
        stages: stageResults,
        totalDuration: stageResults.reduce((sum, s) => sum + s.duration, 0)
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    // Define complex pipeline
    const pipeline = {
      input: {
        raw: Array.from({ length: 1000 }, (_, i) => ({
          id: i,
          value: Math.random() * 100,
          timestamp: Date.now() + i * 1000
        }))
      },
      stages: [
        {
          name: 'filter',
          transform: async (data: any) => {
            await sleep(50);
            return {
              ...data,
              raw: data.raw.filter((item: any) => item.value > 50)
            };
          },
          validate: async (data: any) => data.raw.length > 0
        },
        {
          name: 'enrich',
          transform: async (data: any) => {
            await sleep(100);
            return {
              ...data,
              raw: data.raw.map((item: any) => ({
                ...item,
                category: item.value > 75 ? 'high' : 'medium',
                processed: true
              }))
            };
          }
        },
        {
          name: 'aggregate',
          transform: async (data: any) => {
            await sleep(50);
            const aggregated = {
              count: data.raw.length,
              sum: data.raw.reduce((sum: number, item: any) => sum + item.value, 0),
              categories: {} as any
            };

            data.raw.forEach((item: any) => {
              if (!aggregated.categories[item.category]) {
                aggregated.categories[item.category] = 0;
              }
              aggregated.categories[item.category]++;
            });

            return {
              ...data,
              aggregated
            };
          },
          validate: async (data: any) => data.aggregated.count === data.raw.length
        },
        {
          name: 'format',
          transform: async (data: any) => {
            await sleep(30);
            return {
              summary: {
                totalItems: data.aggregated.count,
                average: data.aggregated.sum / data.aggregated.count,
                distribution: data.aggregated.categories
              },
              samples: data.raw.slice(0, 5)
            };
          }
        }
      ]
    };

    const stageUpdates: any[] = [];
    const result = await client.request('pipeline', pipeline, {
      callback: (data, error, done) => {
        if (!done && data?.type === 'stage-complete') {
          stageUpdates.push(data);
        }
      },
      timeout: 10000
    });

    expect(result.success).toBe(true);
    expect(result.stages).toHaveLength(4);
    expect(stageUpdates).toHaveLength(4);
    expect(result.output.summary).toBeDefined();
    expect(result.output.summary.totalItems).toBeGreaterThan(0);
    expect(result.output.summary.average).toBeGreaterThan(50);
    expect(result.totalDuration).toBeGreaterThan(200);
  });

  it('should handle adaptive streaming with dynamic rate control', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('adaptiveStream', async (data, { send, events, abortSignal }) => {
      const { targetRate, duration, adaptive } = data;
      let currentRate = targetRate;
      let sentCount = 0;
      let droppedCount = 0;
      let rateAdjustments = 0;

      const startTime = Date.now();
      const metrics = {
        latencies: [] as number[],
        rates: [] as number[],
        bufferSizes: [] as number[]
      };

      // Listen for client feedback
      events.on('client.feedback', (source, feedback) => {
        if (source === 'remote' && adaptive) {
          // Adjust rate based on client feedback
          if (feedback.bufferSize > 100) {
            currentRate = Math.max(10, currentRate * 0.8); // Slow down
            rateAdjustments++;
          } else if (feedback.bufferSize < 20 && feedback.processingTime < 10) {
            currentRate = Math.min(1000, currentRate * 1.2); // Speed up
            rateAdjustments++;
          }

          metrics.latencies.push(feedback.latency);
          metrics.bufferSizes.push(feedback.bufferSize);
        }
      });

      while (Date.now() - startTime < duration && !abortSignal.aborted) {
        const intervalMs = 1000 / currentRate;

        const packet = {
          sequence: sentCount,
          timestamp: Date.now(),
          data: Buffer.alloc(1024).fill(sentCount % 256),
          rate: currentRate
        };

        const sendStart = Date.now();
        await send(packet, false, true); // Allow package loss; return value is not meaningful in loss mode
        sentCount++;

        metrics.rates.push(currentRate);

        // Dynamic sleep based on current rate
        const elapsed = Date.now() - sendStart;
        const sleepTime = Math.max(0, intervalMs - elapsed);

        if (sleepTime > 0) {
          await sleep(sleepTime);
        }
      }

      return {
        sent: sentCount,
        dropped: droppedCount,
        duration: Date.now() - startTime,
        averageRate: sentCount / ((Date.now() - startTime) / 1000),
        rateAdjustments,
        metrics: {
          avgLatency: metrics.latencies.length > 0
            ? metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length
            : 0,
          avgBufferSize: metrics.bufferSizes.length > 0
            ? metrics.bufferSizes.reduce((a, b) => a + b, 0) / metrics.bufferSizes.length
            : 0
        }
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const events = new NetworkEventListener();
    const clientBuffer: any[] = [];
    const receivedPackets: any[] = [];

    // Simulate client processing with variable speed
    let processingTime = 10;
    const processBuffer = setInterval(() => {
      if (clientBuffer.length > 0) {
        const packet = clientBuffer.shift();
        receivedPackets.push(packet);

        // Send feedback to server
        events.emit('client.feedback', {
          bufferSize: clientBuffer.length,
          latency: Date.now() - packet.timestamp,
          processingTime,
          sequence: packet.sequence
        });

        // Simulate variable processing speed
        processingTime = 5 + Math.random() * 20;
      }
    }, processingTime);

    const result = await client.request('adaptiveStream',
      {
        targetRate: 100, // 100 packets per second initially
        duration: 3000,
        adaptive: true
      },
      {
        events,
        callback: (data, error, done) => {
          if (!done && data) {
            clientBuffer.push(data);
          }
        },
        timeout: 5000
      }
    );

    clearInterval(processBuffer);

    expect(result.sent).toBeGreaterThan(0);
    expect(result.duration).toBeGreaterThanOrEqual(2900);
    expect(result.duration).toBeLessThanOrEqual(3100);
    expect(result.rateAdjustments).toBeGreaterThan(0); // Should have adapted
    expect(result.metrics.avgLatency).toBeGreaterThan(0);
    expect(receivedPackets.length).toBeGreaterThan(0);

    // Verify packet ordering (allowing for some drops)
    let lastSequence = -1;
    let outOfOrder = 0;
    for (const packet of receivedPackets) {
      if (packet.sequence <= lastSequence) {
        outOfOrder++;
      }
      lastSequence = packet.sequence;
    }
    expect(outOfOrder).toBeLessThan(receivedPackets.length * 0.1); // Less than 10% out of order
  });

  it('should handle complex error propagation in nested operations', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('errorPropagation', async (data) => {
      const errors: any[] = [];
      const results: any[] = [];

      const processWithErrorHandling = async (item: any, level: number): Promise<any> => {
        try {
          if (item.shouldError && item.errorLevel === level) {
            throw new Error(`Intentional error at level ${level}: ${item.errorMessage}`);
          }

          // Nested operation that might fail
          if (item.nested) {
            const nestedResults = await Promise.all(
              item.nested.map((n: any) => processWithErrorHandling(n, level + 1))
            );
            return {
              ...item,
              level,
              nestedResults
            };
          }

          // Async operation with potential failure
          if (item.asyncOp) {
            const result = await item.asyncOp();
            return {
              ...item,
              level,
              asyncResult: result
            };
          }

          return {
            ...item,
            level,
            processed: true
          };
        } catch (error: any) {
          errors.push({
            level,
            item: item.id,
            error: error.message,
            stack: error.stack?.split('\n').slice(0, 3)
          });

          if (item.propagateError) {
            throw error; // Propagate up
          }

          // Return error as result
          return {
            ...item,
            level,
            error: error.message,
            handled: true
          };
        }
      };

      try {
        for (const item of data.items) {
          const result = await processWithErrorHandling(item, 0);
          results.push(result);
        }
      } catch (topLevelError: any) {
        errors.push({
          level: -1,
          error: topLevelError.message,
          fatal: true
        });
      }

      return {
        results,
        errors,
        summary: {
          totalErrors: errors.length,
          fatalErrors: errors.filter(e => e.fatal).length,
          handledErrors: errors.filter(e => !e.fatal).length,
          errorLevels: [...new Set(errors.map(e => e.level))]
        }
      };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const testData = {
      items: [
        {
          id: 'item1',
          nested: [
            {
              id: 'nested1-1',
              shouldError: true,
              errorLevel: 1,
              errorMessage: 'Nested error 1',
              propagateError: false
            },
            {
              id: 'nested1-2',
              asyncOp: async () => {
                await sleep(10);
                return 'async-result';
              }
            }
          ]
        },
        {
          id: 'item2',
          shouldError: true,
          errorLevel: 0,
          errorMessage: 'Top level error',
          propagateError: false
        },
        {
          id: 'item3',
          nested: [
            {
              id: 'nested3-1',
              nested: [
                {
                  id: 'deep3-1-1',
                  shouldError: true,
                  errorLevel: 2,
                  errorMessage: 'Deep nested error',
                  propagateError: true // This will propagate up
                }
              ]
            }
          ]
        },
        {
          id: 'item4',
          asyncOp: async () => {
            await sleep(20);
            throw new Error('Async operation failed');
          },
          propagateError: false
        }
      ]
    };

    const result = await client.request('errorPropagation', testData);

    expect(result.results).toHaveLength(4);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.summary.totalErrors).toBeGreaterThan(0);
    expect(result.summary.errorLevels).toContain(0);
    expect(result.summary.errorLevels).toContain(1);

    // Verify error handling
    const item1Result = result.results.find((r: any) => r.id === 'item1');
    expect(item1Result).toBeDefined();
    expect(item1Result.nestedResults).toBeDefined();

    const item2Result = result.results.find((r: any) => r.id === 'item2');
    expect(item2Result.error).toBeDefined();
    expect(item2Result.handled).toBe(true);
  });

  it('should serialize and execute generator functions across the network', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('genTest', async (data) => {
      // data.generator is a generator function coming from client
      const gen = await data.generator(data.count);
      const out: number[] = [];
      // Using await on next() is fine for sync generators
      let r = await gen.next();
      while (!r.done) {
        out.push(r.value);
        r = await gen.next();
      }
      return { values: out };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    client.config.syncRequestsWhenServerOpen = false;
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const result = await client.request('genTest', {
      count: 5,
      generator: function* (n: number) {
        for (let i = 0; i < n; i++) {
          yield i * 2;
        }
      }
    });

    expect(result.values).toEqual([0, 2, 4, 6, 8]);
  });

  it('should serialize and execute async generator functions across the network', async () => {
    const { router: server, attachClient } = PerfectWSAdvanced.server();

    server.on('asyncGenTest', async (data) => {
      // data.asyncGenerator is an async generator function coming from client
      const agen = await data.asyncGenerator(data.count);
      const out: number[] = [];
      // Properly iterate async generator
      for await (const v of agen) {
        out.push(v);
      }
      return { values: out };
    });

    wss.on('connection', (ws) => attachClient(ws));

    const { router: client, setServer } = PerfectWSAdvanced.client();
    const ws = new WebSocket(`ws://localhost:${serverPort}`);
    setServer(ws);
    await client.serverOpen;

    const result = await client.request('asyncGenTest', {
      count: 5,
      asyncGenerator: async function* (n: number) {
        for (let i = 0; i < n; i++) {
          await sleep(5);
          yield i + 1;
        }
      }
    });

    expect(result.values).toEqual([1, 2, 3, 4, 5]);
  });
});