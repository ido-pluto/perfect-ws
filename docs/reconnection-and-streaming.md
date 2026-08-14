# Reconnection & Streaming Continuity

Every client-role router carries a persistent `clientId` (auto-generated, or supplied explicitly): `PerfectWS.client()`, `RemoteClient.router`, and `ClientHost.router`. `ServerHost.router` and `RemoteServer.router` are the matching server role. When the connection drops and a new socket takes over, the client and server resynchronize - and if a request was mid-stream when the connection dropped, **it keeps streaming to the new socket instead of being lost, duplicated, or silently restarted.**

## How it works

1. On every request, the client sends its `clientId` alongside the usual `method`/`requestId`/`data`.
2. Whenever a client (re)connects, it automatically calls the internal `___syncRequests` method with the request ids it still owns: unfinished requests and completed channels that still contain a reachable callback, transferred signal, or PureRPC handle.
3. The server looks up its own active responses for that `clientId`. For each one:
   - If the response's live socket doesn't match the incoming connection, it's rewired onto the new socket.
   - If the client's list doesn't mention that requestId anymore, the server aborts it.
4. A handler that's mid-stream (looping and calling `send(data, false)`, or emitting custom `events`) never restarts - it's the exact same server-side function execution the whole time. It just resumes delivering to whichever socket is currently registered for that `clientId`.

This is automatic - it's what `RemoteClient`/`RemoteServer`'s built-in reconnect loop (see [Authentication](authentication.md#auto-reconnect-and-backoff)) already gives you for free, and it applies to any `PerfectWS`/`PerfectWSAdvanced` router as long as it isn't a `temp` one.

Live values use the same mechanism. A callback or PureRPC handle remains usable after the same client instance reconnects. A completed live channel has no idle or disconnection timeout; `requestTimeout` only limits the request before its final response. The channel is released when its resources are collected or explicitly disposed, a router stops, or synchronization reports that the peer no longer knows the request.

## Example

```typescript
import { ServerHost, RemoteClient } from 'perfect-ws';

// Server: a long-running streaming handler
const host = new ServerHost({ password: 'shared-secret', port: 8080 });
host.router.on('export', async (data, { send }) => {
  for (let i = 0; i < 100; i++) {
    await doWork(i);
    await send({ progress: i }, false);
  }
  return { done: true };
});
host.start();

// Client
const remote = new RemoteClient({ password: 'shared-secret', url: 'ws://localhost:8080' });
remote.start();

const result = await remote.router.request('export', {}, {
  callback: (data, error, down) => {
    if (!down) console.log('progress:', data.progress);
  },
});
```

If the connection drops partway through - a network blip, a proxy restart, `remote`'s socket getting force-closed - `RemoteClient`'s reconnect loop redials automatically. The `export` handler, still running server-side the whole time, keeps calling `send()`, and those calls now reach the new socket once it's up. The `callback` above keeps receiving `progress` events picking up roughly where they left off (any `send()` calls made while disconnected are simply delayed until the socket is available again, not dropped), and `result` resolves normally.

This all happens because `remote` is the *same running instance* across the reconnect - `RemoteClient` reuses its own `router` and only swaps the underlying socket. Nothing about this is specific to `RemoteClient`; it's exactly as true if you call `setServer(newWs)` yourself on any non-`temp` `PerfectWS.client()`.

## What actually makes this work: the *instance*, not just the id

The resync only reports requestIds the client **currently has in memory**. That's the crux: reconnecting the *same running instance* works, because it still remembers `export` was in flight. A **brand-new instance** - even sharing the exact same `id`/`clientId` (e.g. after a real page reload, where the whole JS heap was thrown away) - starts with an empty list of active requests. Its first sync reports nothing, so the server correctly treats the old stream as abandoned and aborts it, rather than trying to guess it should keep going:

```typescript
// Old instance (e.g. before a page reload) - the `export` request above is still
// in-flight from its perspective. It's simply gone now, along with the whole process.

// A brand-new instance, same id, but no memory of `export`:
const freshRemote = new RemoteClient({ password: 'shared-secret', url: 'ws://localhost:8080', id: sameIdAsBefore });
freshRemote.start();
// -> the server sees this clientId's first sync has an empty active-request list,
//    and aborts the orphaned `export` response server-side instead of leaking it.
```

So `clientId`/`id` is about **identity** - it's what lets the server recognize "this is the same logical client reconnecting" (used for handoff - see [Authentication](authentication.md#reconnecting-with-the-same-id) - and for isolating clients from each other, below). It is *not* a way to resume arbitrary requests across a full process restart. If you need that, persist whatever state you need at the application level and re-issue a fresh request after reconnecting.

## Isolation between clients

The resync is scoped per `clientId` - one client reconnecting never touches another client's active responses, even on the same server, even if both happen to reconnect around the same time. Each request handler also receives the requesting client's id directly, so you don't need to track sockets yourself to tell clients apart:

```typescript
host.router.on('export', async (data, { send, clientId }) => {
  console.log('exporting for', clientId);
  // ...
});
```

## Explicit id

```typescript
new RemoteClient({ password: 'shared-secret', url: 'ws://localhost:8080', id: 'worker-7' });
```

Omit it and one is generated per instance. Supply a stable one when you want the server to recognize reconnects from the same logical client across socket changes within that process's lifetime, or across restarts if you persist it yourself.
