import { MemoryWebSocket } from './MemoryWebSocket.ts';

export function createDuplexPair() {
    const a = new MemoryWebSocket();
    const b = new MemoryWebSocket();

    a.connect(b);
    b.connect(a);

    return { clientWs: a, serverWs: b };
}