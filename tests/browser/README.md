# PerfectWS browser acceptance project

This standalone Vite/Vitest acceptance fixture installs the repository package as a consumer. Its tests run in real headless Chromium while two Node `ServerHost` instances own the base and Advanced listeners through Vitest global setup. The fixture does not construct a raw WebSocket server or implement the authentication handshake itself.

```bash
npm install
npx playwright install chromium
npm test
```

The gate checks the conditional and explicit browser imports, the browser-safe `RemoteClient` auth wrapper against a Node `ServerHost`, production bundling, base routing and streaming, cancellation, advanced native/custom serialization, callbacks, PureRPC, transferred `AbortSignal`s, and reconnect continuity.
