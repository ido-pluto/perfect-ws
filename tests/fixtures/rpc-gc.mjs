import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
import { PerfectWSAdvanced, PureRPC } from '../../dist/index.js';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixtureStartedAt = Date.now();
const progress = stage => process.stderr.write(`[rpc-gc +${ Date.now() - fixtureStartedAt }ms] ${stage}\n`);

async function collect(rounds = 60) {
    for (let index = 0; index < rounds; index++) {
        global.gc();
        await sleep(5);
    }
}

async function eventually(check, message, timeout = 3000) {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeout) throw new Error(message);
        await sleep(10);
    }
}

const wss = new WebSocketServer({ port: 0 });
await new Promise(resolve => wss.once('listening', resolve));
const address = wss.address();
if (typeof address === 'string' || address === null) throw new Error('Missing WebSocket address');

const serverResult = PerfectWSAdvanced.server();
serverResult.router.config.fullTrustedRPC = true;
serverResult.router.config.runPingLoop = false;
serverResult.router.config.ackTimeout = 5000;
serverResult.router.config.ackRetryDelays = [5000];
wss.on('connection', socket => serverResult.attachClient(socket));

const clientResult = PerfectWSAdvanced.client();
clientResult.router.config.fullTrustedRPC = true;
clientResult.router.config.runPingLoop = false;
clientResult.router.config.ackTimeout = 5000;
clientResult.router.config.ackRetryDelays = [5000];
clientResult.router.config.reconnectTimeout = 2000;
const clientSockets = [];

async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    clientSockets.push(socket);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    return socket;
}

let currentSocket = await connect();
clientResult.setServer(currentSocket);
await clientResult.router.serverOpen;

const channelCounts = () => ({
    client: clientResult.router._activeRequests.size,
    server: serverResult.router._activeResponses.size,
});
const channelsAreEmpty = () => channelCounts().client === 0 && channelCounts().server === 0;

class Counter {
    count = 0;
    nested = {
        count: 0,
        increment() { return ++this.count; },
    };
    increment() { return ++this.count; }
}

let rootOwner = new Counter();
const rootOwnerRef = new WeakRef(rootOwner);
serverResult.router.on('gc.root', () => new PureRPC(rootOwner));

async function useAndDropRoot() {
    let remote = await clientResult.router.request('gc.root');
    assert.equal(await remote.increment(), 1);
    const ref = new WeakRef(remote);
    remote = undefined;
    return ref;
}

const rootRef = await useAndDropRoot();
rootOwner = undefined;
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
await collect();
await eventually(channelsAreEmpty, 'Root PureRPC channel was not released');
await collect(10);
assert.equal(rootRef.deref(), undefined);
assert.equal(rootOwnerRef.deref(), undefined);
progress('root');

let childOwner = new Counter();
const childOwnerRef = new WeakRef(childOwner);
serverResult.router.on('gc.child', () => new PureRPC(childOwner));

let childRoot = await clientResult.router.request('gc.child');
let retainedChild = childRoot.nested;
const childRootRef = new WeakRef(childRoot);
childRoot = undefined;
childOwner = undefined;
await collect(30);
assert.notEqual(childRootRef.deref(), undefined);
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
assert.equal(await retainedChild.increment(), 1);
retainedChild = undefined;
await collect();
await eventually(channelsAreEmpty, 'A dropped child proxy kept its channel alive');
await collect(10);
assert.equal(childRootRef.deref(), undefined);
assert.equal(childOwnerRef.deref(), undefined);
progress('child');

class AliasRoot extends PureRPC {
    count = 0;
    nested = {
        owner: this,
        increment() { return ++this.owner.count; },
        getRoot() { return this.owner; },
    };
}

let aliasOwner = new AliasRoot();
const aliasOwnerRef = new WeakRef(aliasOwner);
serverResult.router.on('gc.alias', () => aliasOwner);

let aliasRoot = await clientResult.router.request('gc.alias');
let aliasChild = aliasRoot.nested;
const aliasRootRef = new WeakRef(aliasRoot);
aliasRoot = undefined;
await collect(30);
assert.notEqual(aliasRootRef.deref(), undefined);

let reacquiredRoot = await aliasChild.getRoot();
assert.equal(reacquiredRoot, aliasRootRef.deref());
reacquiredRoot = undefined;
await collect(20);
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
assert.equal(await aliasChild.increment(), 1);

aliasChild = undefined;
aliasOwner = undefined;
await collect();
await eventually(channelsAreEmpty, 'A reacquired root released a retained derived proxy');
await collect(10);
assert.equal(aliasRootRef.deref(), undefined);
assert.equal(aliasOwnerRef.deref(), undefined);
progress('alias lease');

let returnedCallback = value => value * 2;
const returnedCallbackOwnerRef = new WeakRef(returnedCallback);
serverResult.router.on('gc.returnedCallback', () => returnedCallback);

async function useAndDropCallback() {
    let callback = await clientResult.router.request('gc.returnedCallback');
    assert.equal(await callback(4), 8);
    const ref = new WeakRef(callback);
    callback = undefined;
    return ref;
}

const returnedCallbackRef = await useAndDropCallback();
returnedCallback = undefined;
await collect();
await eventually(channelsAreEmpty, 'Returned callback channel was not released');
await collect(10);
assert.equal(returnedCallbackRef.deref(), undefined);
assert.equal(returnedCallbackOwnerRef.deref(), undefined);
progress('returned callback');

let retainedRemoteCallback;
serverResult.router.on('gc.registerCallback', ({ callback }) => {
    retainedRemoteCallback = callback;
    return 'registered';
});

let localCallback = value => value + 1;
const localCallbackRef = new WeakRef(localCallback);
assert.equal(await clientResult.router.request('gc.registerCallback', { callback: localCallback }), 'registered');
localCallback = undefined;
await collect(20);
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
assert.equal(localCallbackRef.deref() !== undefined, true);
assert.equal(await retainedRemoteCallback(4), 5);
retainedRemoteCallback = undefined;
await collect();
await eventually(channelsAreEmpty, 'Callback passed to the server was not released');
await collect(10);
assert.equal(localCallbackRef.deref(), undefined);
progress('passed callback');

serverResult.router.on('gc.finishedPayload', () => value => value + 2);
const finishedPayloadRequestId = 'gc-finished-payload';
async function finishPayloadRequest() {
    let payload = { bytes: Buffer.alloc(5 * 1024 * 1024, 7) };
    const payloadRef = new WeakRef(payload);
    const callback = await clientResult.router.request('gc.finishedPayload', payload, { requestId: finishedPayloadRequestId });
    payload = undefined;
    return { payloadRef, callback };
}

let finishedPayload = await finishPayloadRequest();
await eventually(() => channelCounts().client === 1
    && channelCounts().server === 1
    && clientResult.router._activeRequests.has(finishedPayloadRequestId)
    && serverResult.router._activeResponses.has(finishedPayloadRequestId), 'Previous callback cleanup overlapped the next request');
await collect();
await eventually(() => finishedPayload.payloadRef.deref() === undefined, 'A finished live request retained its original payload');
assert.equal(await finishedPayload.callback(3), 5);
finishedPayload = undefined;
await collect();
await eventually(channelsAreEmpty, 'Finished-payload callback channel was not released');
progress('finished payload');

let signalOwner = new AbortController();
const signalOwnerRef = new WeakRef(signalOwner.signal);
serverResult.router.on('gc.signal', () => signalOwner.signal);

let receivedSignal = await clientResult.router.request('gc.signal');
const receivedSignalRef = new WeakRef(receivedSignal);
signalOwner = undefined;
await collect(20);
assert.equal(receivedSignal.aborted, false);
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
assert.notEqual(signalOwnerRef.deref(), undefined);

receivedSignal = undefined;
await collect();
await eventually(channelsAreEmpty, 'Collected AbortSignal kept its callback subscription alive');
await collect(10);
assert.equal(receivedSignalRef.deref(), undefined);
assert.equal(signalOwnerRef.deref(), undefined);
progress('abort signal');

let offlineSignalOwner = new AbortController();
const offlineSignalOwnerRef = new WeakRef(offlineSignalOwner.signal);
serverResult.router.on('gc.offlineSignal', () => offlineSignalOwner.signal);

let offlineReceivedSignal = await clientResult.router.request('gc.offlineSignal');
const offlineReceivedSignalRef = new WeakRef(offlineReceivedSignal);
await new Promise(resolve => {
    currentSocket.once('close', resolve);
    currentSocket.terminate();
});
offlineReceivedSignal = undefined;
offlineSignalOwner = undefined;
await collect();
assert.equal(offlineReceivedSignalRef.deref(), undefined);
assert.deepEqual(channelCounts(), { client: 1, server: 1 });

currentSocket = await connect();
clientResult.setServer(currentSocket);
await clientResult.router.serverOpen;
await eventually(channelsAreEmpty, 'Collected offline AbortSignal was not released after reconnect');
await collect(10);
assert.equal(offlineSignalOwnerRef.deref(), undefined);
progress('offline abort signal');

class CallbackConsumer {
    async use(callback, value) { return await callback(value); }
    readSignal(signal) { return { aborted: signal.aborted, reason: signal.reason }; }
    accept(_resources) { return 'accepted'; }
    ping() { return 'pong'; }
}
serverResult.router.on('gc.callbackStress', () => new PureRPC(new CallbackConsumer()));

let callbackConsumer = await clientResult.router.request('gc.callbackStress');
for (let index = 0; index < 50; index++) {
    assert.equal(await callbackConsumer.use(value => value + index, 1), index + 1);
}

const stressRequest = [...clientResult.router._activeRequests.values()][0];
const stressTransforms = clientResult.router._callbacks.get(stressRequest.events);
assert.equal(stressTransforms._callbacks._functions.size, 50);
await collect();
await eventually(
    () => (stressTransforms._callbacks._functions?.size ?? 0) === 0,
    'Temporary PureRPC method callbacks accumulated'
);

for (let index = 0; index < 25; index++) {
    const controller = new AbortController();
    assert.deepEqual(await callbackConsumer.readSignal(controller.signal), { aborted: false, reason: undefined });
}
await collect();
await eventually(
    () => (stressTransforms._callbacks._functions?.size ?? 0) === 0,
    'Temporary PureRPC method AbortSignals accumulated'
);

function queueResourcesWhileOffline() {
    let callback = value => value;
    let controller = new AbortController();
    let handleOwner = { value: 1 };
    let handle = new PureRPC(handleOwner);
    const refs = {
        callback: new WeakRef(callback),
        signal: new WeakRef(controller.signal),
        handle: new WeakRef(handle),
        handleOwner: new WeakRef(handleOwner),
    };

    const pending = callbackConsumer.accept({ callback, signal: controller.signal, handle });
    return {
        pending,
        refs,
        release() {
            callback = undefined;
            controller = undefined;
            handle = undefined;
            handleOwner = undefined;
        },
    };
}

await new Promise(resolve => {
    currentSocket.once('close', resolve);
    currentSocket.terminate();
});
clientResult.router.config.reconnectTimeout = 25;
const queuedResources = queueResourcesWhileOffline();
await collect(5);
assert.ok(Object.values(queuedResources.refs).every(ref => ref.deref() !== undefined));
currentSocket = await connect();
clientResult.setServer(currentSocket);
await clientResult.router.serverOpen;
assert.equal(await queuedResources.pending, 'accepted');
queuedResources.release();
await collect();
await eventually(
    () => Object.values(queuedResources.refs).every(ref => ref.deref() === undefined),
    'Resources from a resumed PureRPC operation were retained'
);
assert.equal(stressTransforms._callbacks._functions?.size ?? 0, 0);
assert.equal(stressTransforms._pureRPC._registry.size, 0);

clientResult.router.config.reconnectTimeout = 2000;
assert.equal(await callbackConsumer.ping(), 'pong');
callbackConsumer = undefined;
await collect();
await eventually(channelsAreEmpty, 'Callback stress channel was not released');
progress('callback stress');

class MixedResources extends PureRPC {
    constructor(signal, callback) {
        super();
        this.signal = signal;
        this.callback = callback;
        this.resources = new Map([
            ['signal', signal],
            ['callback', callback],
        ]);
    }

    getSignal() { return this.signal; }
    getCallback() { return this.callback; }
}

let mixedController = new AbortController();
let mixedCallback = value => value * 4;
let mixedOwner = new MixedResources(mixedController.signal, mixedCallback);
const mixedOwnerRef = new WeakRef(mixedOwner);
const mixedCallbackOwnerRef = new WeakRef(mixedCallback);
const mixedSignalOwnerRef = new WeakRef(mixedController.signal);
serverResult.router.on('gc.mixed', () => mixedOwner);

let mixedRemote = await clientResult.router.request('gc.mixed');
let mixedPath = mixedRemote.resources;
let mixedSignal = await mixedRemote.getSignal();
let mixedSignalAlias = await mixedPath.get('signal');
let mixedRemoteCallback = await mixedRemote.getCallback();
let mixedRemoteCallbackAlias = await mixedPath.get('callback');
assert.equal(mixedSignalAlias, mixedSignal);
assert.equal(mixedRemoteCallbackAlias, mixedRemoteCallback);
assert.equal(await mixedRemoteCallback(3), 12);

mixedRemote = undefined;
mixedPath = undefined;
mixedOwner = undefined;
mixedCallback = undefined;
await collect();
await eventually(() => mixedOwnerRef.deref() === undefined, 'Mixed owner was retained after its PureRPC handle disappeared');
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
assert.notEqual(mixedCallbackOwnerRef.deref(), undefined);
assert.notEqual(mixedSignalOwnerRef.deref(), undefined);
assert.equal(await mixedRemoteCallbackAlias(4), 16);

mixedController.abort('mixed complete');
await eventually(() => mixedSignal.aborted, 'Mixed signal did not abort');
assert.equal(mixedSignal.reason, 'mixed complete');
mixedSignal = undefined;
mixedSignalAlias = undefined;
mixedController = undefined;
await collect(20);
assert.deepEqual(channelCounts(), { client: 1, server: 1 });

mixedRemoteCallback = undefined;
mixedRemoteCallbackAlias = undefined;
await collect();
await eventually(channelsAreEmpty, 'Mixed callback and signal resources were not released');
await collect(10);
assert.equal(mixedCallbackOwnerRef.deref(), undefined);
assert.equal(mixedSignalOwnerRef.deref(), undefined);
progress('mixed resources');

let offlineMixedOwner = new Counter();
const offlineMixedOwnerRef = new WeakRef(offlineMixedOwner);
serverResult.router.on('gc.offlineMixed', () => ({
    handle: new PureRPC(offlineMixedOwner),
    keep: value => value + 10,
}));
let offlineMixed = await clientResult.router.request('gc.offlineMixed');
let offlineMixedHandle = offlineMixed.handle;
let offlineMixedKeep = offlineMixed.keep;
assert.equal(await offlineMixedHandle.increment(), 1);
const offlineMixedHandleRef = new WeakRef(offlineMixedHandle);
const offlineMixedResponse = [...serverResult.router._activeResponses.values()][0];
const offlineMixedTransforms = serverResult.router._callbacks.get(offlineMixedResponse.events);
assert.equal(offlineMixedTransforms._pureRPC._registry.size, 1);

await new Promise(resolve => {
    currentSocket.once('close', resolve);
    currentSocket.terminate();
});
clientResult.router.config.reconnectTimeout = 25;
offlineMixed = undefined;
offlineMixedHandle = undefined;
offlineMixedOwner = undefined;
await collect();
assert.equal(offlineMixedHandleRef.deref(), undefined);
assert.equal(offlineMixedTransforms._pureRPC._registry.size, 1);

currentSocket = await connect();
clientResult.setServer(currentSocket);
await clientResult.router.serverOpen;
await eventually(
    () => offlineMixedTransforms._pureRPC._registry.size === 0,
    'Collected mixed handle release expired while disconnected'
);
assert.equal(await offlineMixedKeep(2), 12);
await collect(10);
assert.equal(offlineMixedOwnerRef.deref(), undefined);
offlineMixedKeep = undefined;
await collect();
await eventually(channelsAreEmpty, 'Offline mixed callback channel was not released');
clientResult.router.config.reconnectTimeout = 2000;
progress('offline mixed resources');

let reconnectOwner = new Counter();
const reconnectOwnerRef = new WeakRef(reconnectOwner);
serverResult.router.on('gc.reconnect', () => new PureRPC(reconnectOwner));
let reconnectRemote = await clientResult.router.request('gc.reconnect');
assert.equal(await reconnectRemote.increment(), 1);
progress('reconnect acquired');

await new Promise(resolve => {
    currentSocket.once('close', resolve);
    currentSocket.terminate();
});
await collect(20);
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
progress('reconnect first disconnect');

currentSocket = await connect();
clientResult.setServer(currentSocket);
await clientResult.router.serverOpen;
assert.equal(await reconnectRemote.increment(), 2);
progress('reconnect resumed');

await new Promise(resolve => {
    currentSocket.once('close', resolve);
    currentSocket.terminate();
});
progress('reconnect second disconnect');
const reconnectRemoteRef = new WeakRef(reconnectRemote);
reconnectRemote = undefined;
reconnectOwner = undefined;
await collect();
assert.deepEqual(channelCounts(), { client: 1, server: 1 });
progress('reconnect local collected');

currentSocket = await connect();
clientResult.setServer(currentSocket);
await clientResult.router.serverOpen;
progress('reconnect replacement open');
await eventually(channelsAreEmpty, 'Reconnect did not reconcile a collected offline handle');
await collect(10);
assert.equal(reconnectRemoteRef.deref(), undefined);
assert.equal(reconnectOwnerRef.deref(), undefined);
progress('reconnect');

clientResult.unregister();
serverResult.unregister();
for (const socket of clientSockets) {
    try { socket.terminate(); } catch { }
}
for (const socket of wss.clients) {
    try { socket.terminate(); } catch { }
}
await new Promise(resolve => wss.close(resolve));
console.log(JSON.stringify({ ok: true, scenarios: 13, callbackStress: 50, signalStress: 25 }));
