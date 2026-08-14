import { ClientHost, ClientHostOptions, InitializedServer } from "./ClientHost/ClientHost.js"
import { InitializeRemoteServer, RemoteServer, RemoteServerOptions } from "./ClientHost/RemoteServer.js"
import { RemoteClient, InitializeRemoteClient, RemoteClientOptions } from "./ServerHost/RemoteClient.js";
import { InitializedClient, ServerHost, ServerHostOptions } from "./ServerHost/ServerHost.js";

const clientHost = {
    Client: ClientHost,
    Server: RemoteServer
};

const serverHost = {
    Client: RemoteClient,
    Server: ServerHost
};

export type {
    ClientHostOptions,
    InitializedServer,
    RemoteClientOptions,
    InitializeRemoteServer,
    InitializeRemoteClient,
    ServerHostOptions,
    InitializedClient,
    RemoteServerOptions
}

export { ClientHost, RemoteClient, RemoteServer, ServerHost, clientHost, serverHost };
