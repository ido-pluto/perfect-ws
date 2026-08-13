export function errorMessage(error: unknown): string {
    try {
        if (error && typeof error === 'object' && 'message' in error) {
            const message = (error as { message?: unknown; }).message;
            if (message !== undefined) return String(message);
        }
    } catch { }

    try {
        return String(error);
    } catch {
        return 'Unknown error';
    }
}

export function errorCode(error: unknown, fallback: string): string {
    try {
        if (error && typeof error === 'object' && 'code' in error) {
            const code = (error as { code?: unknown; }).code;
            if (code !== undefined) return String(code);
        }
    } catch { }
    return fallback;
}
