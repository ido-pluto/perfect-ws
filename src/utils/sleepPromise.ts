export async function sleep(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) return;

    return new Promise<void>(resolve => {
        const finish = () => {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timeout = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}
