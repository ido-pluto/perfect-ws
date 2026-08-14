/** Tracks failed password attempts per key (e.g. remote IP) to throttle brute-force guessing. */
export class PasswordRateLimiter {
    private _attempts: Map<string, { count: number; resetAt: number; }> = new Map();
    private _sweepTimer?: ReturnType<typeof setInterval>;

    public constructor(private _maxAttempts: number, private _windowMs: number, private _maxTrackedKeys = 50_000) { }

    private _startSweepIfNeeded(): void {
        if (this._sweepTimer) {
            return;
        }

        this._sweepTimer = setInterval(() => this._sweep(), this._windowMs);
        this._sweepTimer.unref?.();
    }

    private _stopSweepIfIdle(): void {
        if (this._attempts.size === 0 && this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = undefined;
        }
    }

    private _sweep(): void {
        const now = Date.now();
        for (const [key, entry] of this._attempts) {
            if (now >= entry.resetAt) {
                this._attempts.delete(key);
            }
        }

        this._stopSweepIfIdle();
    }

    public isBlocked(key: string): boolean {
        const entry = this._attempts.get(key);
        if (!entry) {
            return false;
        }

        if (Date.now() >= entry.resetAt) {
            this._attempts.delete(key);
            this._stopSweepIfIdle();
            return false;
        }

        return entry.count >= this._maxAttempts;
    }

    public recordFailure(key: string): void {
        const now = Date.now();
        const entry = this._attempts.get(key);

        if (!entry || now >= entry.resetAt) {
            if (!this._attempts.has(key) && this._attempts.size >= this._maxTrackedKeys) {
                // cap guards against a burst of distinct keys filling the map faster than the sweep runs
                const oldestKey = this._attempts.keys().next().value;
                if (oldestKey !== undefined) {
                    this._attempts.delete(oldestKey);
                }
            }
            this._attempts.set(key, { count: 1, resetAt: now + this._windowMs });
            this._startSweepIfNeeded();
        } else {
            entry.count++;
        }
    }

    public reset(key: string): void {
        this._attempts.delete(key);
        this._stopSweepIfIdle();
    }

    public stop(): void {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = undefined;
        }

        this._attempts.clear();
    }
}


