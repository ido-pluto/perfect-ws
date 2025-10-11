export class PerfectWSError extends Error {
    constructor(message: string, public code?: string, public requestId?: string) {
        super(message);
        this.name = 'PerfectWSError';
    }
}
