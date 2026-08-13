import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('RPC garbage collection', () => {
    it('releases distributed resources while preserving retained and reconnecting handles', async () => {
        const fixture = resolve(process.cwd(), 'tests/fixtures/rpc-gc.mjs');
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string; }>((resolve, reject) => {
            const child = spawn(process.execPath, ['--expose-gc', fixture], {
                cwd: process.cwd(),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
            child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error(`GC fixture did not exit naturally.\n${ stderr || stdout }`));
            }, 25_000);
            child.once('error', reject);
            child.once('close', code => {
                clearTimeout(timeout);
                resolve({ code, stdout, stderr });
            });
        });

        expect(result.code, result.stderr || result.stdout).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual({
            ok: true,
            scenarios: 13,
            callbackStress: 50,
            signalStress: 25,
        });
    }, 30_000);
});
