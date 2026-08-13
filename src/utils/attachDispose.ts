export function attachDispose<T>(data: T, dispose: () => void): T {
    if (typeof data !== 'object' && typeof data !== 'function' || data === null) {
        throw new TypeError('Symbol.dispose can only be attached to an object or function response');
    }

    const existingDispose = (data as any)[Symbol.dispose];
    const existingAsyncDispose = (data as any)[Symbol.asyncDispose];
    let disposed = false;

    const runDispose = () => {
        if (disposed) return;
        disposed = true;
        try {
            if (typeof existingDispose === 'function') existingDispose.call(data);
        } finally {
            dispose();
        }
    };
    const runAsyncDispose = async () => {
        if (disposed) return;
        disposed = true;
        try {
            if (typeof existingAsyncDispose === 'function') {
                await existingAsyncDispose.call(data);
            } else if (typeof existingDispose === 'function') {
                existingDispose.call(data);
            }
        } finally {
            dispose();
        }
    };

    const proto = Object.getPrototypeOf(data);
    if (!Array.isArray(data) && (proto === Object.prototype || proto === null)) {
        return {
            ...(data as any),
            [Symbol.dispose]: runDispose,
            [Symbol.asyncDispose]: runAsyncDispose
        };
    }

    try {
        Object.defineProperties(data, {
            [Symbol.dispose]: { value: runDispose, enumerable: false, configurable: true },
            [Symbol.asyncDispose]: { value: runAsyncDispose, enumerable: false, configurable: true }
        });
    } catch (error) {
        throw new TypeError('Could not attach Symbol.dispose to the response', { cause: error });
    }

    return data;
}
