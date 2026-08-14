import type { TestProject } from 'vitest/node';
import { startAcceptanceServer } from './node/server.js';

export default async function setup(project: TestProject) {
  const server = await startAcceptanceServer();
  project.provide('basePort', server.basePort);
  project.provide('advancedPort', server.advancedPort);
  return () => server.close();
}

declare module 'vitest' {
  export interface ProvidedContext {
    basePort: number;
    advancedPort: number;
  }
}
