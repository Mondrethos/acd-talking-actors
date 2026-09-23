import { Server } from 'socket.io';
import { io } from 'socket.io-client';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { sendAudio, AudioReceiver } from '../scripts/libs/audio-transfer.js';
const server = new Server(0, { maxHttpBufferSize: 1_000_000 });
await once(server.httpServer, 'listening');
server.on('connection', socket => socket.on('module.test', packet => socket.broadcast.emit('module.test', packet)));
const address = `http://127.0.0.1:${server.httpServer.address().port}`;
const gm = io(address, { transports: ['websocket'] });
const player = io(address, { transports: ['websocket'] });
try {
    await Promise.all([once(gm, 'connect'), once(player, 'connect')]);
    const original = Uint8Array.from({ length: 2_500_017 }, (_, i) => i % 251);
    const receiver = new AudioReceiver();
    let timer;
    const received = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for player audio')), 10_000);
        player.on('module.test', packet => {
            const chunks = receiver.receive(packet);
            if (chunks) { clearTimeout(timer); resolve(chunks); }
        });
    });
    await sendAudio(gm, 'module.test', [original], 'gm');
    const chunks = await received;
    assert.deepEqual(new Uint8Array(await new Blob(chunks).arrayBuffer()), original);
    assert.ok(gm.connected && player.connected);
    console.log('PASS: 2,500,017 audio bytes relayed exactly to a separate player over Socket.IO with a 1 MB message limit; both clients stayed connected.');
} finally {
    gm.disconnect(); player.disconnect(); await server.close();
}
