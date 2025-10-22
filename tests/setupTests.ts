import { beforeAll, beforeEach } from "vitest";
import { PerfectWS } from '../src/PerfectWS.js';
import { PerfectWSAdvanced } from "../src/index.js";

beforeAll(() => {
    process.on('unhandledRejection', () => { });
});

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
});