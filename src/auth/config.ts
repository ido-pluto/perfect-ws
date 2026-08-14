export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_PORT = 8080;
export const DEFAULT_MAX_MESSAGE_SIZE = 30 * 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT = 5000;
export const DEFAULT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS = 5;
export const DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_DELAY_BEFORE_RECONNECT = 1000 * 3;
export const AUTH_READY_MESSAGE = '___perfect_ws_auth_ready';

/** Close code for a wrong-password rejection. */
export const WRONG_PASSWORD_CLOSE_CODE = 3001;
/** Close code for a rate-limited rejection (too many recent failed attempts). */
export const RATE_LIMITED_CLOSE_CODE = 3002;
export const DEFAULT_PASSWORD_FAILURE_RECONNECT_DELAY = Math.ceil(DEFAULT_PASSWORD_RATE_LIMIT_WINDOW_MS / DEFAULT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS) + 100;

/** Either password-rejection close code - both get the same (longer) reconnect backoff. */
export function isPasswordRejectionCloseCode(code: number | undefined): boolean {
    return code === WRONG_PASSWORD_CLOSE_CODE || code === RATE_LIMITED_CLOSE_CODE;
}
