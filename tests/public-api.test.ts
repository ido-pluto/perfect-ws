import { describe, expect, it } from 'vitest';
import {
    ClientHost,
    PerfectWS,
    PerfectWSAdvanced,
    PureRPC,
    RemoteClient,
    RemoteServer,
    ServerHost,
    TransformInstruction,
    clientHost,
    serverHost,
} from '../src/index.js';
import * as browserEntry from '../src/browser.js';

describe('public auth and PureRPC exports', () => {
    it('exports every auth class directly and through the documented role namespaces', () => {
        expect(clientHost.Client).toBe(ClientHost);
        expect(clientHost.Server).toBe(RemoteServer);
        expect(serverHost.Client).toBe(RemoteClient);
        expect(serverHost.Server).toBe(ServerHost);
    });

    it('exports the PureRPC wrapper from the package root', () => {
        const target = { value: 1 };
        expect(new PureRPC(target).root).toBe(target);
    });

    it('exports TransformInstruction as a runtime base class', () => {
        expect(typeof TransformInstruction).toBe('function');
    });

    it('keeps the browser entry limited to browser-safe exports', () => {
        expect(browserEntry.PerfectWS).toBe(PerfectWS);
        expect(browserEntry.PerfectWSAdvanced).toBe(PerfectWSAdvanced);
        expect(browserEntry.RemoteClient).toBe(RemoteClient);
        expect(browserEntry.RemoteServer).toBe(RemoteServer);
        expect('ServerHost' in browserEntry).toBe(false);
        expect('ClientHost' in browserEntry).toBe(false);
    });

    it('uses the base protocol by default and requires an explicit advanced constructor', () => {
        const base = new ServerHost();
        const advanced = new ServerHost({ perfectWSConstructor: PerfectWSAdvanced });
        expect(base.router).toBeInstanceOf(PerfectWS);
        expect(base.router).not.toBeInstanceOf(PerfectWSAdvanced);
        expect(base.router).not.toHaveProperty('transformers');
        expect(advanced.router).toBeInstanceOf(PerfectWSAdvanced);
        expect(advanced.router.config.maxMessageSize).toBe(Infinity);
        expect(advanced.router.config.maxPureRPCHandles).toBe(10_000);
        expect(advanced.router.config.autoWrapUnknownClasses).toBe(false);
        base.stop();
        advanced.stop();
    });

    it('rejects primitive wrapper roots at runtime', () => {
        expect(() => new PureRPC(1 as any)).toThrow(/object or function/);
    });
});
