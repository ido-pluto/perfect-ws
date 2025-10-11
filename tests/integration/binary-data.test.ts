import { describe, it, expect } from 'vitest';
import { PerfectWSAdvanced } from '../../src/index.js';
import { WebSocketServer, WebSocket } from 'ws';

describe('Binary Data Integration Tests with PerfectWSAdvanced', () => {
    it('should handle Buffer through PerfectWSAdvanced', async () => {
        const port = 19201;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('sendBuffer', async (data: { buffer: Buffer; }) => {
            expect(Buffer.isBuffer(data.buffer)).toBe(true);
            expect(data.buffer.length).toBe(5);
            expect(Array.from(data.buffer)).toEqual([1, 2, 3, 4, 5]);
            return { buffer: Buffer.from([10, 20, 30]) };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const result = await client.request('sendBuffer', {
            buffer: Buffer.from([1, 2, 3, 4, 5])
        });

        expect(Buffer.isBuffer(result.buffer)).toBe(true);
        expect(Array.from(result.buffer)).toEqual([10, 20, 30]);

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should handle TypedArrays through PerfectWSAdvanced', async () => {
        const port = 19202;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('sendTypedArrays', async (data: any) => {
            expect(data.uint8).toBeInstanceOf(Uint8Array);
            expect(data.int16).toBeInstanceOf(Int16Array);
            expect(data.float32).toBeInstanceOf(Float32Array);

            expect(Array.from(data.uint8)).toEqual([1, 2, 3]);
            expect(Array.from(data.int16)).toEqual([-100, 0, 100]);
            expect(Array.from(data.float32)).toEqual([1.5, 2.5, 3.5]);

            return {
                uint16: new Uint16Array([1000, 2000, 3000]),
                int32: new Int32Array([-50000, 0, 50000]),
                float64: new Float64Array([Math.PI, Math.E])
            };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const result = await client.request('sendTypedArrays', {
            uint8: new Uint8Array([1, 2, 3]),
            int16: new Int16Array([-100, 0, 100]),
            float32: new Float32Array([1.5, 2.5, 3.5])
        });

        expect(result.uint16).toBeInstanceOf(Uint16Array);
        expect(result.int32).toBeInstanceOf(Int32Array);
        expect(result.float64).toBeInstanceOf(Float64Array);

        expect(Array.from(result.uint16)).toEqual([1000, 2000, 3000]);
        expect(Array.from(result.int32)).toEqual([-50000, 0, 50000]);
        expect(Array.from(result.float64)).toEqual([Math.PI, Math.E]);

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should handle ArrayBuffer and DataView through PerfectWSAdvanced', async () => {
        const port = 19203;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('sendBinaryViews', async (data: any) => {
            expect(data.arrayBuffer).toBeInstanceOf(ArrayBuffer);
            expect(data.dataView).toBeInstanceOf(DataView);

            const view = new Uint8Array(data.arrayBuffer);
            expect(Array.from(view)).toEqual([255, 128, 64]);

            expect(data.dataView.getUint8(0)).toBe(10);
            expect(data.dataView.getUint16(1, true)).toBe(256);

            const responseBuffer = new ArrayBuffer(4);
            const responseView = new DataView(responseBuffer);
            responseView.setUint32(0, 0xDEADBEEF, false);

            return {
                arrayBuffer: new ArrayBuffer(8),
                dataView: responseView
            };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const sendBuffer = new ArrayBuffer(3);
        const sendView = new Uint8Array(sendBuffer);
        sendView.set([255, 128, 64]);

        const dataViewBuffer = new ArrayBuffer(4);
        const dataView = new DataView(dataViewBuffer);
        dataView.setUint8(0, 10);
        dataView.setUint16(1, 256, true);

        const result = await client.request('sendBinaryViews', {
            arrayBuffer: sendBuffer,
            dataView: dataView
        });

        expect(result.arrayBuffer).toBeInstanceOf(ArrayBuffer);
        expect(result.dataView).toBeInstanceOf(DataView);
        expect(result.arrayBuffer.byteLength).toBe(8);
        expect(result.dataView.getUint32(0, false)).toBe(0xDEADBEEF);

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should handle nested objects with binary data', async () => {
        const port = 19204;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('sendNested', async (data: any) => {
            expect(Buffer.isBuffer(data.metadata.buffer)).toBe(true);
            expect(data.arrays.uint8).toBeInstanceOf(Uint8Array);
            expect(data.arrays.float32).toBeInstanceOf(Float32Array);
            expect(Array.from(data.metadata.buffer)).toEqual([1, 2, 3, 4]);

            return {
                response: {
                    data: {
                        buffer: Buffer.from([10, 20]),
                        array: new Uint16Array([100, 200, 300])
                    },
                    status: 'ok'
                }
            };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const result = await client.request('sendNested', {
            metadata: {
                buffer: Buffer.from([1, 2, 3, 4]),
                name: 'test'
            },
            arrays: {
                uint8: new Uint8Array([5, 6, 7]),
                float32: new Float32Array([1.1, 2.2])
            }
        });

        expect(Buffer.isBuffer(result.response.data.buffer)).toBe(true);
        expect(result.response.data.array).toBeInstanceOf(Uint16Array);
        expect(Array.from(result.response.data.buffer)).toEqual([10, 20]);
        expect(Array.from(result.response.data.array)).toEqual([100, 200, 300]);
        expect(result.response.status).toBe('ok');

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should handle arrays of binary data', async () => {
        const port = 19205;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('sendArrays', async (data: any) => {
            expect(Array.isArray(data.buffers)).toBe(true);
            expect(data.buffers.length).toBe(3);
            data.buffers.forEach((buf: Buffer) => {
                expect(Buffer.isBuffer(buf)).toBe(true);
            });

            return {
                results: [
                    new Uint8Array([1, 2]),
                    new Uint16Array([100, 200]),
                    Buffer.from([255])
                ]
            };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const result = await client.request('sendArrays', {
            buffers: [
                Buffer.from([1, 2, 3]),
                Buffer.from([4, 5]),
                Buffer.from([6])
            ]
        });

        expect(Array.isArray(result.results)).toBe(true);
        expect(result.results[0]).toBeInstanceOf(Uint8Array);
        expect(result.results[1]).toBeInstanceOf(Uint16Array);
        expect(Buffer.isBuffer(result.results[2])).toBe(true);

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should handle large binary data', async () => {
        const port = 19206;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('sendLarge', async (data: any) => {
            expect(Buffer.isBuffer(data.largeBuffer)).toBe(true);
            expect(data.largeBuffer.length).toBe(1024 * 100);
            expect(data.largeBuffer[0]).toBe(255);
            expect(data.largeBuffer[data.largeBuffer.length - 1]).toBe(128);

            const response = Buffer.alloc(1024 * 50);
            response.fill(42);
            return { largeBuffer: response };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const largeBuffer = Buffer.alloc(1024 * 100);
        largeBuffer.fill(255);
        largeBuffer[largeBuffer.length - 1] = 128;

        const result = await client.request('sendLarge', { largeBuffer });

        expect(Buffer.isBuffer(result.largeBuffer)).toBe(true);
        expect(result.largeBuffer.length).toBe(1024 * 50);
        expect(result.largeBuffer.every((byte: number) => byte === 42)).toBe(true);

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should handle mixed binary and regular data', async () => {
        const port = 19207;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('sendMixed', async (data: any) => {
            expect(data.string).toBe('hello');
            expect(data.number).toBe(42);
            expect(Buffer.isBuffer(data.buffer)).toBe(true);
            expect(data.array).toEqual([1, 2, 3]);
            expect(data.object.nested).toBe(true);

            return {
                message: 'received',
                count: 100,
                data: Buffer.from([10, 20, 30]),
                typed: new Float32Array([1.1, 2.2, 3.3]),
                meta: { success: true }
            };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const result = await client.request('sendMixed', {
            string: 'hello',
            number: 42,
            buffer: Buffer.from([1, 2, 3]),
            array: [1, 2, 3],
            object: { nested: true }
        });

        expect(result.message).toBe('received');
        expect(result.count).toBe(100);
        expect(Buffer.isBuffer(result.data)).toBe(true);
        expect(result.typed).toBeInstanceOf(Float32Array);
        expect(result.meta.success).toBe(true);

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should preserve binary data integrity through multiple round trips', async () => {
        const port = 19208;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('echo', async (data: any) => {
            return data;
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const originalData = {
            buffer: Buffer.from([1, 2, 3, 4, 5]),
            uint8: new Uint8Array([10, 20, 30]),
            int16: new Int16Array([-100, 0, 100]),
            float32: new Float32Array([1.5, 2.5]),
            arrayBuffer: new Uint8Array([255, 128, 64]).buffer,
            dataView: new DataView(new Uint16Array([1000, 2000]).buffer)
        };

        let result = originalData;
        for (let i = 0; i < 3; i++) {
            result = await client.request('echo', result);
        }

        expect(Buffer.isBuffer(result.buffer)).toBe(true);
        expect(Array.from(result.buffer)).toEqual([1, 2, 3, 4, 5]);
        expect(Array.from(result.uint8)).toEqual([10, 20, 30]);
        expect(Array.from(result.int16)).toEqual([-100, 0, 100]);
        expect(Array.from(result.float32)).toEqual([1.5, 2.5]);
        expect(result.arrayBuffer).toBeInstanceOf(ArrayBuffer);
        expect(result.dataView).toBeInstanceOf(DataView);

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);

    it('should handle binary data through request with event handler', async () => {
        const port = 19209;
        const wss = new WebSocketServer({ port });

        const { router: server, attachClient } = PerfectWSAdvanced.server();

        server.on('getBinaryData', async () => {
            return {
                buffer: Buffer.from([100, 101, 102]),
                typed: new Uint32Array([1000, 2000, 3000]),
                message: 'binary event'
            };
        });

        wss.on('connection', (ws) => {
            attachClient(ws);
        });

        const { router: client, setServer } = PerfectWSAdvanced.client();
        const ws = new WebSocket(`ws://localhost:${port}`);
        setServer(ws);

        await client.serverOpen;

        const eventData = await client.request('getBinaryData', {});

        expect(Buffer.isBuffer(eventData.buffer)).toBe(true);
        expect(Array.from(eventData.buffer)).toEqual([100, 101, 102]);
        expect(eventData.typed).toBeInstanceOf(Uint32Array);
        expect(Array.from(eventData.typed)).toEqual([1000, 2000, 3000]);
        expect(eventData.message).toBe('binary event');

        ws.close();
        await new Promise((resolve) => wss.close(resolve));
    }, 10000);
});

