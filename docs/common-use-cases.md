# Common use cases

Start with the [README quick start](../README.md#quick-start). The examples below use the same `host` (`ServerHost`) and `remote` (`RemoteClient`) instances. Base request/response, errors, progress, middleware, and request cancellation work with the default `PerfectWS`. Examples that pass functions, preserve advanced value types, or use PureRPC require `perfectWSConstructor: PerfectWSAdvanced` on both peers, as shown in the README.

## Choose copied data or a live value

| What you send or return | Required protocol | What the other side receives |
|---|---|---|
| BSON-compatible object or array | Default `PerfectWS` | An independent value copy |
| `Map`, `Set`, preserved binary/native type, custom transformed class | `PerfectWSAdvanced` | An independent value copy |
| Function | `PerfectWSAdvanced` | A live async callback to the original function |
| `AbortSignal` inside data | `PerfectWSAdvanced` | A live signal linked to the original signal |
| `PureRPC` object | `PerfectWSAdvanced` plus `fullTrustedRPC` | A live handle to the owner-side object |

Use ordinary values for request data and results. Use a callback for one remote action. Use `PureRPC` when the caller needs several operations on the same stateful object.

## Return data from async work

A handler may return a value or a promise. The caller always receives a promise:

```typescript
// server
host.router.on('post.list', async ({ authorId }) => {
  return await database.posts.findByAuthor(authorId);
});

// client
const posts = await remote.router.request('post.list', { authorId: '42' });
```

## Return an application error

Call `reject(message, code)` when the caller needs a stable error code:

```typescript
// server
host.router.on('post.delete', async ({ id }, { reject }) => {
  const deleted = await database.posts.delete(id);

  if (!deleted) {
    reject('Post not found', 'postNotFound');
    return;
  }

  return { deleted: true };
});
```

```typescript
// client
import { PerfectWSError } from 'perfect-ws';

try {
  await remote.router.request('post.delete', { id: 'missing' });
} catch (error) {
  if (error instanceof PerfectWSError) {
    console.error(error.code, error.message);
  }
}
```

Thrown errors also reject the request, but an explicit code is easier for callers to handle reliably.

## Stream progress before the final result

Use `send(value, false)` for each non-final update. Return the final value from the handler:

```typescript
// server
host.router.on('archive.create', async ({ files }, { send }) => {
  for (let index = 0; index < files.length; index++) {
    await addToArchive(files[index]);
    await send({ completed: index + 1, total: files.length }, false);
  }

  return { downloadUrl: '/downloads/archive.zip' };
});
```

```typescript
// client
const result = await remote.router.request('archive.create', { files }, {
  callback: (update, error, done) => {
    if (error) console.error(error);
    if (!error && !done) console.log(`${update.completed}/${update.total}`);
  },
});

console.log(result.downloadUrl);
```

## Let the other side call a function

After explicitly selecting `PerfectWSAdvanced` on both authenticated peers, functions in request or response data become RPC callbacks automatically:

```typescript
// server
host.router.on('image.process', async ({ image, onProgress }) => {
  await onProgress(25);
  const result = await processImage(image);
  await onProgress(100);
  return result;
});

// client
const image = await remote.router.request('image.process', {
  image: inputBytes,
  onProgress: (percent: number) => console.log(`${percent}%`),
});
```

Handlers can return functions too. Returned and passed callbacks remain callable while your code can reach them; PerfectWS releases the corresponding resources automatically after garbage collection. Use [PureRPC](pure-rpc.md) when the peer needs a stateful object over several operations.

## Cancel a request

Pass an `AbortSignal` in the request options. The handler receives a linked signal:

```typescript
// server
host.router.on('search', async ({ query }, { abortSignal }) => {
  const response = await fetch(buildSearchUrl(query), {
    signal: abortSignal,
  });

  return await response.json();
});
```

```typescript
// client
const controller = new AbortController();

const search = remote.router.request('search', { query: 'websocket rpc' }, {
  abortSignal: controller.signal,
});

controller.abort();

try {
  await search;
} catch (error) {
  console.log('Search cancelled');
}
```

The request has a 15-minute maximum duration by default. Override it for one call with `{ timeout: 30 * 60_000 }`, or use `{ timeout: 0 }` to disable it. The linked handler signal fires on timeout even if the caller disconnected. This deadline ends with the final response; it does not expire callbacks, signals, or PureRPC handles returned by that response.

## Send binary data

With `PerfectWSAdvanced` selected on both peers, send typed arrays and buffers directly. They arrive with their original type:

```typescript
// server
host.router.on('file.upload', ({ bytes }: { bytes: Uint8Array }) => {
  return { received: bytes.byteLength };
});

// client
const result = await remote.router.request('file.upload', {
  bytes: new Uint8Array([1, 2, 3, 4]),
});

console.log(result.received); // 4
```

See [Serialization and transforms](serialization-and-transforms.md) for `Buffer`, `ArrayBuffer`, `Map`, `Set`, `BigInt`, errors, URLs, circular values, and custom classes.

## Control an owner-side resource

PureRPC can expose a resource without transferring its state or filesystem path to the caller. This writer always uses a server-selected file; do not accept an arbitrary client path unless the server validates it.

```typescript
// server
import { appendFile, readFile } from 'node:fs/promises';
import { PureRPC } from 'perfect-ws';

class RemoteFileWriter extends PureRPC {
  #path: string;

  constructor(path: string) {
    super();
    this.#path = path;
  }

  async append(
    chunks: Set<Uint8Array>,
    signal: AbortSignal,
    onProgress: (bytes: number) => Promise<void>,
  ) {
    let written = 0;

    for (const chunk of chunks) {
      if (signal.aborted) throw new Error('Write cancelled');
      await appendFile(this.#path, chunk);
      written += chunk.byteLength;
      await onProgress(written);
    }

    return { written };
  }

  async read() {
    return new Uint8Array(await readFile(this.#path));
  }
}

host.router.on('log.writer', () => new RemoteFileWriter('/var/app/current.log'));
```

```typescript
// Configure both peers with:
// perfectWSConstructor: PerfectWSAdvanced, fullTrustedRPC: true
const writer: any = await remote.router.request('log.writer');
const controller = new AbortController();

await writer.append(
  new Set([new TextEncoder().encode('hello\n')]),
  controller.signal,
  async (bytes: number) => console.log(`${bytes} bytes written`),
);

const contents = await writer.read();
```

The class instance, its private path, and all filesystem work remain on the server. Binary chunks and the `Set` are copied into the method call; the callback and signal stay live for that call. The handle is released automatically when it and every derived property handle become unreachable. See [PureRPC](pure-rpc.md) for trust and cleanup details.

## Add middleware to every request

Middleware runs before the matching route and may modify data or reject the request:

```typescript
host.router.use(async (data, { reject }) => {
  const user = await findUserByToken(data.token);

  if (!user) {
    reject('Invalid token', 'unauthorized');
    return;
  }

  data.user = user;
});

host.router.on('account.get', (data) => {
  return data.user;
});
```

See [Middleware and routing](middleware-and-routing.md) for per-route validation, Zod middleware, and nested route groups.

For a scoped route group, keep middleware and mounting explicit:

```typescript
const accounts = PerfectWS.Router();
accounts.use(requireUser);
accounts.on('/get', data => data.user);

host.router.mount('/accounts', accounts);
```

`use()` adds middleware to the current router scope. `mount()` attaches a child
router and owns its prefix.

## Stop cleanly

Long-running services normally stay started. Tests, scripts, and graceful-shutdown handlers should release their sockets and timers:

```typescript
remote.stop();
host.stop();
```

Returned callbacks, transferred signals, and PureRPC handles do not need manual cleanup. PerfectWS keeps their request channel while they are reachable and releases it automatically:

```typescript
const counter: any = await remote.router.request('counter');
console.log(await counter.increment());
```

Garbage collection is not immediate, so only use explicit disposal when an application must release a scarce remote resource at a precise time. See [PureRPC lifetime and cleanup](pure-rpc.md#lifetime-and-cleanup).

For deterministic transport cleanup at scope exit, use the optional `using` syntax:

```typescript
{
  using counter: any = await remote.router.request('counter');
  console.log(await counter.increment());
}
```

Raw `using` declarations require runtime support or TypeScript transpilation. Node.js 22 cannot parse this optional syntax; automatic cleanup remains the default.
