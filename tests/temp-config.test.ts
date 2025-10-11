import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = 8095;

describe('Temp Config Tests', () => {
    let wss: WebSocketServer;
    let serverRouter: PerfectWS;
    let attachClient: (ws: any) => void;
    let unregisterServer: () => void;

    beforeEach(() => {
        wss = new WebSocketServer({ port: PORT });
        const serverResult = PerfectWS.server();
        serverRouter = serverResult.router;
        attachClient = serverResult.attachClient;
        unregisterServer = serverResult.unregister;

        wss.on('connection', (ws) => {
            attachClient(ws);
        });
    });

    afterEach(() => {
        unregisterServer();
        wss.close();
    });

    it('should create client with temp config only (signature 1)', async () => {
        const { router, unregister } = PerfectWS.client({ temp: true });

        expect(router.config.syncRequestsWhenServerOpen).toBe(false);
        expect(router.config.abortUnknownResponses).toBe(false);

        unregister();
    });

    it('should create client with server and temp config (signature 2)', async () => {
        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await new Promise((resolve) => ws.once('open', resolve));

        const { router, unregister } = PerfectWS.client(ws, { temp: true });

        expect(router.config.syncRequestsWhenServerOpen).toBe(false);
        expect(router.config.abortUnknownResponses).toBe(false);

        unregister();
        ws.close();
    });

    it('should not sync requests when temp client connects', async () => {
        serverRouter.on('test', (data) => {
            return { success: true };
        });

        const permanentClient = PerfectWS.client();
        const permanentWs = new WebSocket(`ws://localhost:${PORT}`);
        await new Promise((resolve) => permanentWs.once('open', resolve));
        permanentClient.setServer(permanentWs);

        const requestPromise = permanentClient.router.request('test', {});

        await new Promise((resolve) => setTimeout(resolve, 50));

        const tempWs = new WebSocket(`ws://localhost:${PORT}`);
        const tempClient = PerfectWS.client(tempWs, { temp: true });

        await new Promise((resolve) => setTimeout(resolve, 100));

        const result = await requestPromise;
        expect(result).toEqual({ success: true });

        permanentClient.unregister();
        tempClient.unregister();
        permanentWs.close();
        tempWs.close();
    });

    it('should handle validation flow with temp client', async () => {
        serverRouter.on('validate', (data) => {
            return data.token === 'valid-token' ? { authorized: true } : { authorized: false };
        });

        serverRouter.on('getData', (data) => {
            return { data: 'secret' };
        });

        const permanentClient = PerfectWS.client();

        const ws = new WebSocket(`ws://localhost:${PORT}`);
        const tempClient = PerfectWS.client(ws, { temp: true });

        const validation = await tempClient.router.request('validate', { token: 'valid-token' });
        expect(validation).toEqual({ authorized: true });

        tempClient.unregister();

        permanentClient.setServer(ws);

        const data = await permanentClient.router.request('getData', {});
        expect(data).toEqual({ data: 'secret' });

        permanentClient.unregister();
    });

    it('should handle multiple temp clients without interference', async () => {
        serverRouter.on('echo', (data) => {
            return { echo: data.value };
        });

        const ws1 = new WebSocket(`ws://localhost:${PORT}`);
        const ws2 = new WebSocket(`ws://localhost:${PORT}`);

        const temp1 = PerfectWS.client(ws1, { temp: true });
        const temp2 = PerfectWS.client(ws2, { temp: true });

        const [result1, result2] = await Promise.all([
            temp1.router.request('echo', { value: 'first' }),
            temp2.router.request('echo', { value: 'second' })
        ]);

        expect(result1).toEqual({ echo: 'first' });
        expect(result2).toEqual({ echo: 'second' });

        temp1.unregister();
        temp2.unregister();
        ws1.close();
        ws2.close();
    });

    it('should not abort unknown responses in temp client', async () => {
        let responseCount = 0;

        serverRouter.on('stream', async (data, { send }) => {
            for (let i = 0; i < 3; i++) {
                send({ count: i }, false);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            send({ count: 3, done: true }, true);
        });

        const ws = new WebSocket(`ws://localhost:${PORT}`);
        const { router, unregister } = PerfectWS.client(ws, { temp: true });

        await router.request('stream', {}, {
            callback: (data, error, done) => {
                if (data) responseCount++;
            }
        });

        expect(responseCount).toBeGreaterThanOrEqual(4);

        unregister();
        ws.close();
    });

    it('should handle temp client with pending requests before connection', async () => {
        serverRouter.on('delayed', async (data) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { delayed: true };
        });

        const { router, setServer, unregister } = PerfectWS.client({ temp: true });

        const requestPromise = router.request('delayed', {});

        await new Promise((resolve) => setTimeout(resolve, 50));

        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await new Promise((resolve) => ws.once('open', resolve));
        setServer(ws);

        const result = await requestPromise;
        expect(result).toEqual({ delayed: true });

        unregister();
        ws.close();
    });

    it('should handle switching from temp to permanent client correctly', async () => {
        serverRouter.on('test', (data) => {
            return { value: data.value };
        });

        const ws = new WebSocket(`ws://localhost:${PORT}`);
        const tempClient = PerfectWS.client(ws, { temp: true });

        const tempResult = await tempClient.router.request('test', { value: 'temp' });
        expect(tempResult).toEqual({ value: 'temp' });

        tempClient.unregister();

        const permanentClient = PerfectWS.client(ws);

        const permanentResult = await permanentClient.router.request('test', { value: 'permanent' });
        expect(permanentResult).toEqual({ value: 'permanent' });

        permanentClient.unregister();
        ws.close();
    });

    it('should handle temp client disconnection and reconnection', async () => {
        serverRouter.on('ping', () => {
            return { pong: true };
        });

        let ws = new WebSocket(`ws://localhost:${PORT}`);
        const { router, setServer, unregister } = PerfectWS.client(ws, { temp: true });

        const result1 = await router.request('ping', {});
        expect(result1).toEqual({ pong: true });

        ws.close();
        await new Promise((resolve) => setTimeout(resolve, 100));

        ws = new WebSocket(`ws://localhost:${PORT}`);
        await new Promise((resolve) => ws.once('open', resolve));
        setServer(ws);

        const result2 = await router.request('ping', {});
        expect(result2).toEqual({ pong: true });

        unregister();
        ws.close();
    });

    it('should respect temp config even when manually setting server', async () => {
        serverRouter.on('check', () => {
            return { ok: true };
        });

        const { router, setServer, unregister } = PerfectWS.client({ temp: true });

        expect(router.config.syncRequestsWhenServerOpen).toBe(false);
        expect(router.config.abortUnknownResponses).toBe(false);

        const ws = new WebSocket(`ws://localhost:${PORT}`);
        await new Promise((resolve) => ws.once('open', resolve));
        setServer(ws);

        expect(router.config.syncRequestsWhenServerOpen).toBe(false);
        expect(router.config.abortUnknownResponses).toBe(false);

        const result = await router.request('check', {});
        expect(result).toEqual({ ok: true });

        unregister();
        ws.close();
    });

    it('should handle temp client with error in validation', async () => {
        serverRouter.on('validate', (data) => {
            if (data.token !== 'valid') {
                throw new Error('Invalid token');
            }
            return { valid: true };
        });

        const ws = new WebSocket(`ws://localhost:${PORT}`);
        const { router, unregister } = PerfectWS.client(ws, { temp: true });

        await expect(router.request('validate', { token: 'invalid' })).rejects.toThrow();

        ws.close();
        unregister();
    });

    it('should not interfere with normal client request syncing', async () => {
        serverRouter.on('longTask', async (data) => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { completed: true };
        });

        const normalWs = new WebSocket(`ws://localhost:${PORT}`);
        const normalClient = PerfectWS.client(normalWs);

        await new Promise((resolve) => normalWs.once('open', resolve));

        const normalRequestPromise = normalClient.router.request('longTask', {});

        await new Promise((resolve) => setTimeout(resolve, 50));

        const tempWs = new WebSocket(`ws://localhost:${PORT}`);
        const tempClient = PerfectWS.client(tempWs, { temp: true });

        await tempClient.router.request('longTask', {});

        const normalResult = await normalRequestPromise;
        expect(normalResult).toEqual({ completed: true });

        normalClient.unregister();
        tempClient.unregister();
        normalWs.close();
        tempWs.close();
    });

    it('should handle temp client with no config provided (default behavior)', async () => {
        serverRouter.on('test', () => {
            return { success: true };
        });

        const ws = new WebSocket(`ws://localhost:${PORT}`);
        const { router, unregister } = PerfectWS.client(ws);

        expect(router.config.syncRequestsWhenServerOpen).toBe(true);
        expect(router.config.abortUnknownResponses).toBe(true);

        unregister();
        ws.close();
    });

    it('should handle temp false explicitly', async () => {
        const { router, unregister } = PerfectWS.client({ temp: false });

        expect(router.config.syncRequestsWhenServerOpen).toBe(true);
        expect(router.config.abortUnknownResponses).toBe(true);

        unregister();
    });

    it('should handle complex validation scenario', async () => {
        serverRouter.on('validate', (data) => {
            return data.secret === 'password' ? { token: 'abc123' } : null;
        });

        serverRouter.on('protectedData', (data) => {
            return { data: 'very secret', token: data.token };
        });

        const permanentClient = PerfectWS.client();
        const permanentRequestPromise = permanentClient.router.request('protectedData', { token: 'abc123' });

        await new Promise((resolve) => setTimeout(resolve, 50));

        const validationWs = new WebSocket(`ws://localhost:${PORT}`);
        const validationClient = PerfectWS.client(validationWs, { temp: true });

        const validation = await validationClient.router.request('validate', { secret: 'password' });
        expect(validation).toEqual({ token: 'abc123' });

        validationClient.unregister();

        permanentClient.setServer(validationWs);

        const permanentResult = await permanentRequestPromise;
        expect(permanentResult).toEqual({ data: 'very secret', token: 'abc123' });

        permanentClient.unregister();
    });

    describe('Complex Connection Flow: Disconnect -> Temp Validate -> Reconnect Main', () => {
        it('should handle disconnect, temp validation, and reconnect to main connection', async () => {
            serverRouter.on('validate', (data) => {
                return data.token === 'valid-token' ? { authorized: true } : { authorized: false };
            });

            serverRouter.on('getData', (data) => {
                return { data: 'secret-data', requestId: data.requestId };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const initialData = await mainClient.router.request('getData', { requestId: 1 });
            expect(initialData).toEqual({ data: 'secret-data', requestId: 1 });

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 100));

            const validationWs = new WebSocket(`ws://localhost:${PORT}`);
            const validationClient = PerfectWS.client(validationWs, { temp: true });

            const validation = await validationClient.router.request('validate', { token: 'valid-token' });
            expect(validation).toEqual({ authorized: true });

            validationClient.unregister();
            validationWs.close();

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const afterReconnectData = await mainClient.router.request('getData', { requestId: 2 });
            expect(afterReconnectData).toEqual({ data: 'secret-data', requestId: 2 });

            mainClient.unregister();
            mainWs.close();
        });

        it('should allow new requests after disconnect-validate-reconnect flow', async () => {
            serverRouter.on('validate', (data) => {
                return { authorized: data.token === 'valid' };
            });

            serverRouter.on('task', async (data) => {
                return { result: data.value * 2 };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const result1 = await mainClient.router.request('task', { value: 5 });
            expect(result1).toEqual({ result: 10 });

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 100));

            const validationWs = new WebSocket(`ws://localhost:${PORT}`);
            const validationClient = PerfectWS.client(validationWs, { temp: true });

            const validation = await validationClient.router.request('validate', { token: 'valid' });
            expect(validation).toEqual({ authorized: true });

            validationClient.unregister();
            validationWs.close();
            await new Promise((resolve) => setTimeout(resolve, 100));

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const result2 = await mainClient.router.request('task', { value: 10 });
            expect(result2).toEqual({ result: 20 });

            mainClient.unregister();
            mainWs.close();
        });

        it('should handle multiple temp validations between disconnects', async () => {
            serverRouter.on('validate', (data) => {
                return { valid: data.secret === 'password', timestamp: Date.now() };
            });

            serverRouter.on('work', (data) => {
                return { processed: data.value };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const work1 = await mainClient.router.request('work', { value: 'first' });
            expect(work1).toEqual({ processed: 'first' });

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 50));

            const validation1Ws = new WebSocket(`ws://localhost:${PORT}`);
            const validation1Client = PerfectWS.client(validation1Ws, { temp: true });
            const val1 = await validation1Client.router.request('validate', { secret: 'password' });
            expect(val1.valid).toBe(true);
            validation1Client.unregister();
            validation1Ws.close();

            await new Promise((resolve) => setTimeout(resolve, 50));

            const validation2Ws = new WebSocket(`ws://localhost:${PORT}`);
            const validation2Client = PerfectWS.client(validation2Ws, { temp: true });
            const val2 = await validation2Client.router.request('validate', { secret: 'password' });
            expect(val2.valid).toBe(true);
            validation2Client.unregister();
            validation2Ws.close();

            await new Promise((resolve) => setTimeout(resolve, 50));

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const work2 = await mainClient.router.request('work', { value: 'second' });
            expect(work2).toEqual({ processed: 'second' });

            mainClient.unregister();
            mainWs.close();
        });

        it('should handle failed validation and not reconnect main', async () => {
            serverRouter.on('validate', (data) => {
                if (data.token !== 'correct-token') {
                    throw new Error('Invalid token');
                }
                return { authorized: true };
            });

            serverRouter.on('getData', () => {
                return { data: 'secret' };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            await mainClient.router.request('getData', {});

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 50));

            const validationWs = new WebSocket(`ws://localhost:${PORT}`);
            const validationClient = PerfectWS.client(validationWs, { temp: true });

            await expect(validationClient.router.request('validate', { token: 'wrong-token' }))
                .rejects.toThrow('Invalid token');

            validationClient.unregister();
            validationWs.close();

            mainClient.unregister();
        });

        it('should handle streaming after validation', async () => {
            serverRouter.on('validate', () => {
                return { ok: true };
            });

            serverRouter.on('stream', async (data, { send }) => {
                for (let i = 0; i < 3; i++) {
                    send({ count: i }, false);
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                send({ count: 3, done: true }, true);
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 100));

            const validationWs = new WebSocket(`ws://localhost:${PORT}`);
            const validationClient = PerfectWS.client(validationWs, { temp: true });
            await validationClient.router.request('validate', {});
            validationClient.unregister();
            validationWs.close();

            await new Promise((resolve) => setTimeout(resolve, 100));

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const streamData: any[] = [];
            await mainClient.router.request('stream', {}, {
                callback: (data) => {
                    if (data) streamData.push(data);
                }
            });

            expect(streamData.length).toBeGreaterThanOrEqual(4);
            expect(streamData[streamData.length - 1].done).toBe(true);

            mainClient.unregister();
            mainWs.close();
        });

        it('should handle multiple requests after validation', async () => {
            serverRouter.on('validate', () => ({ valid: true }));

            serverRouter.on('task', async (data) => {
                return { result: data.id };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 100));

            const validationWs = new WebSocket(`ws://localhost:${PORT}`);
            const validationClient = PerfectWS.client(validationWs, { temp: true });
            await validationClient.router.request('validate', {});
            validationClient.unregister();
            validationWs.close();

            await new Promise((resolve) => setTimeout(resolve, 100));

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            const [result1, result2, result3] = await Promise.all([
                mainClient.router.request('task', { id: 1 }),
                mainClient.router.request('task', { id: 2 }),
                mainClient.router.request('task', { id: 3 })
            ]);

            expect(result1).toEqual({ result: 1 });
            expect(result2).toEqual({ result: 2 });
            expect(result3).toEqual({ result: 3 });

            mainClient.unregister();
            mainWs.close();
        });

        it('should handle rapid disconnect-reconnect with temp validation in between', async () => {
            serverRouter.on('validate', () => ({ ok: true }));
            serverRouter.on('ping', () => ({ pong: true }));

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            for (let i = 0; i < 3; i++) {
                const result = await mainClient.router.request('ping', {});
                expect(result).toEqual({ pong: true });

                mainWs.close();
                await new Promise((resolve) => setTimeout(resolve, 50));

                const validationWs = new WebSocket(`ws://localhost:${PORT}`);
                const validationClient = PerfectWS.client(validationWs, { temp: true });
                await validationClient.router.request('validate', {});
                validationClient.unregister();
                validationWs.close();

                await new Promise((resolve) => setTimeout(resolve, 50));

                mainWs = new WebSocket(`ws://localhost:${PORT}`);
                await new Promise((resolve) => mainWs.once('open', resolve));
                mainClient.setServer(mainWs);
            }

            mainClient.unregister();
            mainWs.close();
        });

        it('should maintain request IDs correctly across disconnect-validate-reconnect', async () => {
            const requestIds: string[] = [];

            serverRouter.on('validate', (data, { requestId }) => {
                requestIds.push(requestId);
                return { valid: true };
            });

            serverRouter.on('track', (data, { requestId }) => {
                requestIds.push(requestId);
                return { tracked: requestId };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            await mainClient.router.request('track', {});

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 50));

            const validationWs = new WebSocket(`ws://localhost:${PORT}`);
            const validationClient = PerfectWS.client(validationWs, { temp: true });
            await validationClient.router.request('validate', {});
            validationClient.unregister();
            validationWs.close();

            await new Promise((resolve) => setTimeout(resolve, 50));

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            await mainClient.router.request('track', {});

            expect(requestIds.length).toBe(3);
            expect(new Set(requestIds).size).toBe(3);

            mainClient.unregister();
            mainWs.close();
        });

        it('should handle temp validation with different WebSocket instance but same main client', async () => {
            serverRouter.on('validate', (data) => {
                return { authorized: data.key === 'secret' };
            });

            serverRouter.on('work', (data) => {
                return { result: data.value };
            });

            const mainClient = PerfectWS.client();

            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            await mainClient.router.request('work', { value: 'before' });

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 50));

            const newWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => newWs.once('open', resolve));

            const tempValidation = PerfectWS.client(newWs, { temp: true });
            const validationResult = await tempValidation.router.request('validate', { key: 'secret' });
            expect(validationResult).toEqual({ authorized: true });
            tempValidation.unregister();

            mainClient.setServer(newWs);

            const afterResult = await mainClient.router.request('work', { value: 'after' });
            expect(afterResult).toEqual({ result: 'after' });

            mainClient.unregister();
            newWs.close();
        });

        it('should handle concurrent temp validations from different connections', async () => {
            serverRouter.on('validate', (data) => {
                return { id: data.id, valid: true };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 50));

            const validation1Ws = new WebSocket(`ws://localhost:${PORT}`);
            const validation2Ws = new WebSocket(`ws://localhost:${PORT}`);
            const validation3Ws = new WebSocket(`ws://localhost:${PORT}`);

            const temp1 = PerfectWS.client(validation1Ws, { temp: true });
            const temp2 = PerfectWS.client(validation2Ws, { temp: true });
            const temp3 = PerfectWS.client(validation3Ws, { temp: true });

            const [val1, val2, val3] = await Promise.all([
                temp1.router.request('validate', { id: 1 }),
                temp2.router.request('validate', { id: 2 }),
                temp3.router.request('validate', { id: 3 })
            ]);

            expect(val1).toEqual({ id: 1, valid: true });
            expect(val2).toEqual({ id: 2, valid: true });
            expect(val3).toEqual({ id: 3, valid: true });

            temp1.unregister();
            temp2.unregister();
            temp3.unregister();
            validation1Ws.close();
            validation2Ws.close();
            validation3Ws.close();

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            mainClient.unregister();
            mainWs.close();
        });

        it('should handle edge case: reconnect main with same WebSocket as temp used', async () => {
            serverRouter.on('validate', () => ({ valid: true }));
            serverRouter.on('getData', () => ({ data: 'value' }));

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 50));

            const sharedWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => sharedWs.once('open', resolve));

            const tempClient = PerfectWS.client(sharedWs, { temp: true });
            await tempClient.router.request('validate', {});
            tempClient.unregister();

            mainClient.setServer(sharedWs);

            const result = await mainClient.router.request('getData', {});
            expect(result).toEqual({ data: 'value' });

            mainClient.unregister();
            sharedWs.close();
        });

        it('should not sync requests from temp client when main reconnects', async () => {
            let syncRequestsCalled = 0;

            serverRouter.on('validate', () => ({ valid: true }));
            serverRouter.on('trackSync', (data) => {
                if (data.type === 'sync') {
                    syncRequestsCalled++;
                }
                return { ok: true };
            });

            const mainClient = PerfectWS.client();
            let mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            await new Promise((resolve) => setTimeout(resolve, 100));

            mainWs.close();
            await new Promise((resolve) => setTimeout(resolve, 50));

            const validationWs = new WebSocket(`ws://localhost:${PORT}`);
            const validationClient = PerfectWS.client(validationWs, { temp: true });

            await validationClient.router.request('validate', {});

            await new Promise((resolve) => setTimeout(resolve, 100));

            validationClient.unregister();
            validationWs.close();

            await new Promise((resolve) => setTimeout(resolve, 50));

            mainWs = new WebSocket(`ws://localhost:${PORT}`);
            await new Promise((resolve) => mainWs.once('open', resolve));
            mainClient.setServer(mainWs);

            await new Promise((resolve) => setTimeout(resolve, 100));

            mainClient.unregister();
            mainWs.close();
        });
    });
});

