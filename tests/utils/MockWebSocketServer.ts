import { EventEmitter } from 'node:events';
import { MemoryWebSocket } from './MemoryWebSocket.ts';

export class MockWebSocketServer extends EventEmitter {
    close() {
        this.removeAllListeners();
    }

    emitConnection(ws: MemoryWebSocket) {
        this.emit('connection', ws);
    }
}