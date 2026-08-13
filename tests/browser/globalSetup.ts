import type { TestProject } from 'vitest/node';
import { startAcceptanceServer } from './node/server.js';

export default async function setup(project: TestProject) {
  const server = await startAcceptanceServer();
  project.provide('rpcPort', server.port);
  return () => server.close();
}

declare module 'vitest' {
  export interface ProvidedContext {
    rpcPort: number;
  }
}
