import {
    ClientHost,
    type InitializedClient,
    type InitializedServer,
    type InitializeRemoteClient,
    type InitializeRemoteServer,
    PerfectWS,
    PerfectWSAdvanced,
    type PerfectWSRouter,
    RemoteClient,
    RemoteServer,
    ServerHost,
    TransformInstruction,
    type WSClientResult,
    type WSLike,
    type WSServerResult,
    type WSErrorShape,
    validateWithZod,
} from '../../src/index.js';
import { z } from 'zod';

const transform = {} as TransformInstruction<unknown>;
// @ts-expect-error Auth routers default to base PerfectWS, which has no transforms.
new ServerHost().router.transformers.push(transform);
// @ts-expect-error Auth routers default to base PerfectWS, which has no transforms.
new ClientHost().router.transformers.push(transform);
// @ts-expect-error Auth routers default to base PerfectWS, which has no transforms.
new RemoteClient({ url: 'ws://localhost' }).router.transformers.push(transform);
// @ts-expect-error Auth routers default to base PerfectWS, which has no transforms.
new RemoteServer().router.transformers.push(transform);

new ServerHost({ perfectWSConstructor: PerfectWSAdvanced }).router.transformers.push(transform);
new ClientHost({ perfectWSConstructor: PerfectWSAdvanced }).router.transformers.push(transform);
new RemoteClient({ url: 'ws://localhost', perfectWSConstructor: PerfectWSAdvanced }).router.transformers.push(transform);
new RemoteServer({ perfectWSConstructor: PerfectWSAdvanced }).router.transformers.push(transform);

const baseServerHost = new ServerHost({ perfectWSConstructor: PerfectWS });
const baseClientHost = new ClientHost({ perfectWSConstructor: PerfectWS });
const baseRemoteClient = new RemoteClient({ url: 'ws://localhost', perfectWSConstructor: PerfectWS });
const baseRemoteServer = new RemoteServer({ perfectWSConstructor: PerfectWS });
baseServerHost.router.on('base', () => undefined);
baseClientHost.router.on('base', () => undefined);
baseRemoteClient.router.on('base', () => undefined);
baseRemoteServer.router.on('base', () => undefined);
// @ts-expect-error Base PerfectWS routers do not have advanced transformers.
baseServerHost.router.transformers;
// @ts-expect-error Base PerfectWS routers do not have advanced transformers.
baseClientHost.router.transformers;
// @ts-expect-error Base PerfectWS routers do not have advanced transformers.
baseRemoteClient.router.transformers;
// @ts-expect-error Base PerfectWS routers do not have advanced transformers.
baseRemoteServer.router.transformers;

type CustomRouter<WSType extends WSLike> = PerfectWS<WSType> & {
    customMember: string;
};

class CustomPerfectWS<WSType extends WSLike = WSLike, ExtraConfig = { [key: string]: any }> extends PerfectWS<WSType, ExtraConfig> {
    static override client<WSType extends WSLike = WSLike>(config?: Parameters<typeof PerfectWS.client>[0]): WSClientResult<WSType, CustomRouter<WSType>>;
    static override client<WSType extends WSLike = WSLike>(server: WSType, config?: Parameters<typeof PerfectWS.client>[1]): WSClientResult<WSType, CustomRouter<WSType>>;
    static override client<WSType extends WSLike = WSLike>(serverOrConfig?: WSType | Parameters<typeof PerfectWS.client>[0], config?: Parameters<typeof PerfectWS.client>[1]): WSClientResult<WSType, CustomRouter<WSType>> {
        return super.client(serverOrConfig as any, config) as WSClientResult<WSType, CustomRouter<WSType>>;
    }

    static override server<WSType extends WSLike = WSLike>(): WSServerResult<WSType, CustomRouter<WSType>> {
        return super.server<WSType>() as WSServerResult<WSType, CustomRouter<WSType>>;
    }
}

new ServerHost({ perfectWSConstructor: CustomPerfectWS }).router.customMember;
new ClientHost({ perfectWSConstructor: CustomPerfectWS }).router.customMember;
new RemoteClient({ url: 'ws://localhost', perfectWSConstructor: CustomPerfectWS }).router.customMember;
new RemoteServer({ perfectWSConstructor: CustomPerfectWS }).router.customMember;

type HandshakeRouter = ReturnType<typeof PerfectWS.client>['router'];
type HandshakeServerRouter = ReturnType<typeof PerfectWS.server>['router'];

class Host extends ServerHost {
    protected override initializeClient(_router: HandshakeRouter, _options: InitializedClient): void { }
}

class Client extends ClientHost {
    protected override initializeServer(_router: HandshakeRouter, _options: InitializedServer): void { }
}

class Remote extends RemoteClient {
    protected override initializeMethods(_router: HandshakeServerRouter, _options: InitializeRemoteClient): Promise<void> {
        return Promise.resolve();
    }
}

class RemoteHost extends RemoteServer {
    protected override initializeMethods(_router: HandshakeServerRouter, _options: InitializeRemoteServer): void { }
}

void [Host, Client, Remote, RemoteHost];

PerfectWS.client().router.request('typed-callback', null, {
    callback(data: unknown | null, error: WSErrorShape | null, done: boolean) {
        if (error) console.log(error.code);
        if (data !== null) console.log(data);
        console.log(done);
    },
});

const typedValidationSchema = z.object({
    name: z.string(),
    count: z.coerce.number(),
    label: z.string().transform(value => value.trim()),
});

PerfectWS.server().router.on(
    'typed-validation',
    validateWithZod(typedValidationSchema, { stripUnknown: true }),
    data => {
        data.name.toUpperCase();
        data.count.toFixed();
        data.label.toLowerCase();
        // @ts-expect-error The handler data comes from the parsed schema output.
        data.missing;
        // @ts-expect-error z.coerce.number() produces a number, not a string.
        const invalidCount: string = data.count;
        return invalidCount;
    },
);

const typedSubRoute: PerfectWSRouter = PerfectWS.Router();
typedSubRoute.use(() => undefined).on(
    '/validation',
    validateWithZod(typedValidationSchema),
    data => data.count + data.name.length,
);
const typedMountTarget = PerfectWS.server().router;
typedMountTarget.mount('/typed', typedSubRoute).use(() => undefined);
// @ts-expect-error Router prefixes belong to mount(), not PerfectWS.Router().
PerfectWS.Router('/typed');
// @ts-expect-error use() accepts middleware only; child routers use mount().
typedMountTarget.use(PerfectWS.Router());
