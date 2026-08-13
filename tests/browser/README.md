# PerfectWS browser acceptance project

This standalone Vite/Vitest acceptance fixture installs the repository package as a consumer. Its tests run in real headless Chromium while a separate Node WebSocket server runs through Vitest global setup.

```bash
npm install
npx playwright install chromium
npm test
```

The gate checks the conditional and explicit browser imports, production bundling, base routing and streaming, cancellation, advanced native/custom serialization, callbacks, PureRPC, transferred `AbortSignal`s, and reconnect continuity.
