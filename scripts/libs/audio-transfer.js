// Keep module socket messages small and JSON-safe, including on hosted relays.
export const AUDIO_CHUNK_BYTES = 32 * 1024;
const MAX_CHUNKS = 1024; // 32 MiB per utterance
const TRANSFER_TIMEOUT = 60_000;

export async function sendAudio(socket, channel, chunks, senderId) {
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    const total = Math.ceil(bytes.length / AUDIO_CHUNK_BYTES);
    if (!total || total > MAX_CHUNKS) throw new Error("Audio must be between 1 byte and 32 MiB.");
    // getRandomValues also works on self-hosted HTTP origins.
    const transferId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        byte => byte.toString(16).padStart(2, "0")).join("");
    for (let index = 0; index < total; index++) {
        const part = bytes.subarray(index * AUDIO_CHUNK_BYTES, (index + 1) * AUDIO_CHUNK_BYTES);
        socket.emit(channel, {
            type: "audio-chunk", transferId, senderId, index, total,
            data: btoa(String.fromCharCode(...part))
        });
        // Let the socket flush rather than queueing the entire recording in one burst.
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

export class AudioReceiver {
    pending = new Map();
    completed = new Set();

    receive(packet) {
        if (packet?.type !== "audio-chunk") return null;
        const { transferId, senderId, index, total, data } = packet;
        if (typeof transferId !== "string" || transferId.length > 128 ||
            typeof senderId !== "string" || senderId.length > 128 ||
            !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS ||
            !Number.isInteger(index) || index < 0 || index >= total ||
            typeof data !== "string" || !data.length || data.length > 4 * Math.ceil(AUDIO_CHUNK_BYTES / 3)) return null;
        const key = JSON.stringify([senderId, transferId]);
        if (this.completed.has(key)) return null;
        let binary;
        try { binary = atob(data); } catch { return null; }
        if (binary.length > AUDIO_CHUNK_BYTES) return null;
        let transfer = this.pending.get(key);
        if (!transfer) {
            if (this.pending.size >= 8) return null;
            transfer = { total, chunks: new Map(), timer: null };
            this.pending.set(key, transfer);
        }
        if (transfer.total !== total) return null;
        clearTimeout(transfer.timer);
        transfer.timer = setTimeout(() => this.pending.delete(key), TRANSFER_TIMEOUT);
        transfer.chunks.set(index, Uint8Array.from(binary, c => c.charCodeAt(0)));
        if (transfer.chunks.size !== total) return null;
        clearTimeout(transfer.timer);
        this.pending.delete(key);
        this.completed.add(key);
        if (this.completed.size > 128) this.completed.delete(this.completed.values().next().value);
        return Array.from({ length: total }, (_, i) => transfer.chunks.get(i));
    }
}
