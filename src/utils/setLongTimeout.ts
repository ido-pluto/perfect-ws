const MAX_TIMER_DELAY = 0x7fff_ffff;

export function isValidRequestTimeout(value: unknown): value is number {
    return typeof value === 'number' && value >= 0;
}

export function isFinitePositiveTimeout(delay: number): boolean {
    return delay > 0 && delay < Infinity;
}

export function setLongTimeout(callback: () => void, delay: number): () => void {
    if (!isFinitePositiveTimeout(delay)) return () => { };

    const deadline = Date.now() + delay;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const schedule = () => {
        if (cancelled) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            callback();
            return;
        }
        timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY));
    };
    schedule();
    return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
    };
}
