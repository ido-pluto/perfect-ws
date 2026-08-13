import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const consumer = mkdtempSync(join(tmpdir(), 'perfect-ws-consumer-'));
let archive;

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json'], {
    cwd: repository,
    encoding: 'utf8',
  }));
  archive = join(repository, packed[0].filename);

  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', archive], {
    cwd: consumer,
    stdio: 'pipe',
  });
  execFileSync(process.execPath, ['--input-type=module', '--eval', "await import('perfect-ws')"], {
    cwd: consumer,
    stdio: 'pipe',
  });

  writeFileSync(join(consumer, 'fixture.ts'), `
import { PerfectWS, ServerHost, validateWithZod } from 'perfect-ws';
import type { PerfectWSRouter, WSRequestOptions } from 'perfect-ws';
const client = PerfectWS.client();
const host = new ServerHost({ password: 'secret' });
const options: WSRequestOptions<string> = {
  callback(data, error, done) {
    if (done && error === null) data?.toUpperCase();
  },
};
void client.router.request('echo', 'hello', options);
const schema = {
  safeParse(_data: unknown): { success: true; data: { count: number } } {
    return { success: true, data: { count: 1 } };
  },
};
host.router.on('validated', validateWithZod(schema), data => data.count.toFixed());
const child: PerfectWSRouter = PerfectWS.Router();
child.use(() => undefined).on('/value', () => 1);
host.router.mount('/api', child);
host.stop();
client.unregister();
`);
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      skipLibCheck: false,
    },
    files: ['fixture.ts'],
  }));
  execFileSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd: consumer,
    stdio: 'pipe',
  });

  const installed = join(consumer, 'node_modules/perfect-ws');
  const listenerDeclaration = readFileSync(join(installed, 'dist/utils/NetworkEventListener.d.ts'), 'utf8');
  if (listenerDeclaration.includes('_emitWithSource')) {
    throw new Error('Internal event-source method leaked into the public declarations');
  }
  if (packed[0].files.some(file => file.path.endsWith('.tsbuildinfo'))) {
    throw new Error('The package contains a TypeScript build-info cache');
  }

  process.stdout.write(`Verified ${basename(archive)} in a clean runtime and TypeScript consumer.\n`);
} finally {
  if (archive) rmSync(archive, { force: true });
  rmSync(consumer, { recursive: true, force: true });
}
