import { beforeEach } from 'vitest';
import { PerfectWS } from '../src/PerfectWS.js';

// Disable ACK system for all existing tests by default
// This ensures backward compatibility while new tests can opt-in
beforeEach(() => {
    const originalClient = PerfectWS.client.bind(PerfectWS);
    const originalServer = PerfectWS.server.bind(PerfectWS);

    // Override client() to disable ACK by default in tests
    (PerfectWS as any).client = function<WSType>() {
        const result = originalClient<WSType>();
        result.router.config.enableAckSystem = false;
        result.router.config.ackTimeout = 100; // Shorter timeout for tests
        result.router.config.ackRetryDelays = [50, 100]; // Shorter delays for tests
        return result;
    };

    // Override server() to disable ACK by default in tests
    (PerfectWS as any).server = function<WSType>() {
        const result = originalServer<WSType>();
        result.router.config.enableAckSystem = false;
        result.router.config.ackTimeout = 100; // Shorter timeout for tests
        result.router.config.ackRetryDelays = [50, 100]; // Shorter delays for tests
        return result;
    };
});
