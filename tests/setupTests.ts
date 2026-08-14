import { afterEach, beforeEach } from "vitest";
import { PerfectWS } from '../src/PerfectWS.js';
import { PerfectWSAdvanced } from "../src/index.js";

const createPerfectWS = PerfectWS._newInstance;
const createPerfectWSAdvanced = PerfectWSAdvanced._newInstance;
const createClient = PerfectWS.client;
const createServer = PerfectWS.server;
const createAdvancedClient = PerfectWSAdvanced.client;
const createAdvancedServer = PerfectWSAdvanced.server;
const routerCleanups = new Set<() => void>();

beforeEach(() => {

    PerfectWS._newInstance = function <WSType>() {
        const result = new PerfectWS<WSType>();
        result.config.enableAckSystem = false;
        return result;
    };

    PerfectWSAdvanced._newInstance = function <WSType>() {
        const result = new PerfectWSAdvanced<WSType>();
        result.config.enableAckSystem = false;
        return result;
    };

    PerfectWS.client = function (...args: any[]) {
        const result = Reflect.apply(createClient, this, args);
        routerCleanups.add(result.unregister);
        return result;
    } as typeof PerfectWS.client;

    PerfectWS.server = function (...args: any[]) {
        const result = Reflect.apply(createServer, this, args);
        routerCleanups.add(result.unregister);
        return result;
    } as typeof PerfectWS.server;

    PerfectWSAdvanced.client = function (...args: any[]) {
        const result = Reflect.apply(createAdvancedClient, this, args);
        routerCleanups.add(result.unregister);
        return result;
    } as typeof PerfectWSAdvanced.client;

    PerfectWSAdvanced.server = function (...args: any[]) {
        const result = Reflect.apply(createAdvancedServer, this, args);
        routerCleanups.add(result.unregister);
        return result;
    } as typeof PerfectWSAdvanced.server;
});

afterEach(() => {
    for (const cleanup of routerCleanups) {
        try { cleanup(); } catch { }
    }
    routerCleanups.clear();
    PerfectWS._newInstance = createPerfectWS;
    PerfectWSAdvanced._newInstance = createPerfectWSAdvanced;
    PerfectWS.client = createClient;
    PerfectWS.server = createServer;
    PerfectWSAdvanced.client = createAdvancedClient;
    PerfectWSAdvanced.server = createAdvancedServer;
});
