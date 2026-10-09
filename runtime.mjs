// The current V wasm backend imports only WASI fd_write for stdout and stderr,
// plus proc_exit (emitted whenever panic or exit is reachable) and random_get.
export class WasiExit extends Error {
	constructor(code) {
		super(`the program called exit with code ${code}`);
		this.name = 'WasiExit';
		this.code = code;
	}
}

// random_get fills at most this many bytes per call; the WASI spec caps a
// single call, so larger requests are served as several fill calls.
const random_fill_max = 65536;

export async function runWasm(bytes, onOutput) {
	const decoders = new Map([[1, new TextDecoder()], [2, new TextDecoder()]]);
	let instance;
	let outputBytes = 0;
	const imports = {
		wasi_snapshot_preview1: {
			fd_write(fd, iovs, count, written) {
				if (!decoders.has(fd)) return 8; // WASI EBADF
				const memory = instance.exports.memory.buffer;
				const view = new DataView(memory);
				// Reject invalid guest pointers with WASI EFAULT before writing output.
				const inBounds = (ptr, size) => ptr <= memory.byteLength && size <= memory.byteLength - ptr;
				iovs >>>= 0;
				count >>>= 0;
				written >>>= 0;
				if (!inBounds(iovs, count * 8) || !inBounds(written, 4)) return 21;
				const chunks = [];
				let total = 0;
				for (let i = 0; i < count; i++) {
					const ptr = view.getUint32(iovs + i * 8, true);
					const length = view.getUint32(iovs + i * 8 + 4, true);
					if (!inBounds(ptr, length)) return 21;
					total += length;
					chunks.push(new Uint8Array(memory, ptr, length));
				}
				outputBytes += total;
				if (outputBytes > 1024 * 1024) throw new Error('Output exceeded 1 MiB. Stop or shorten the program.');
				for (const chunk of chunks) {
					const text = decoders.get(fd).decode(chunk, { stream: true });
					if (text) onOutput(text);
				}
				view.setUint32(written, total, true);
				return 0;
			},
			// Without this the module cannot be linked at all when a panic or
			// an exit() is reachable, because the backend emits the import for
			// both and WebAssembly fails on a missing import. Throwing unwinds
			// _start; runWasm turns code 0 into success and anything else into
			// an error, so a panic message written just before still surfaces.
			proc_exit(rval) {
				throw new WasiExit(rval | 0);
			},
			random_get(buf, buf_len) {
				const memory = instance.exports.memory.buffer;
				const inBounds = (ptr, size) => ptr <= memory.byteLength && size <= memory.byteLength - ptr;
				buf >>>= 0;
				buf_len >>>= 0;
				if (!inBounds(buf, buf_len)) return 21;
				const bytes = new Uint8Array(memory, buf, buf_len);
				// Fill in chunks small enough for the implementation, and reread
				// the buffer each round: a view into memory stays valid here
				// only because random_get cannot grow it, but the subarray does.
				let filled = 0;
				while (filled < buf_len) {
					const can = Math.min(random_fill_max, buf_len - filled);
					crypto.getRandomValues(bytes.subarray(filled, filled + can));
					filled += can;
				}
				return 0;
			},
		},
	};
	({ instance } = await WebAssembly.instantiate(bytes, imports));
	if (!(instance.exports.memory instanceof WebAssembly.Memory) || typeof instance.exports._start !== 'function') {
		throw new Error('The compiled program must export memory and a _start function.');
	}
	try {
		instance.exports._start();
	} catch (error) {
		// A clean exit is not a failure; anything else was already reported as
		// output or is a genuine trap.
		if (error instanceof WasiExit && error.code === 0) {
			return;
		}
		throw error;
	}
	for (const decoder of decoders.values()) {
		const text = decoder.decode();
		if (text) onOutput(text);
	}
}
