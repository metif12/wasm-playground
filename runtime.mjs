// WASI runtime for V programs compiled to wasm.
//
// The V wasm backend imports `wasi_snapshot_preview1` functions on demand: the
// driver emits an import only for a call that is actually reachable, so a
// program that never calls exit() carries no proc_exit import. Extra keys in
// this object are therefore harmless, and each is implemented here.
//
// Invariants that every function below must keep:
//
//   - `memory.buffer` is re-read on each call. The guest allocator grows
//     memory, which detaches the previous ArrayBuffer, so a cached view would
//     read and write a detached buffer.
//   - Every i32 parameter is coerced with `>>> 0` before any bounds check. WASM
//     i32 arrives in JS signed, so an out-of-range pointer is negative; without
//     the coercion it reaches the DataView and throws a RangeError instead of
//     returning WASI EFAULT.
//   - `inBounds` is written so it never computes `ptr + size`, which would wrap.
//   - Linear address 0 is writable. The backend stores its fd_write byte count
//     there, so a NULL-pointer guard would break V-generated modules.
//   - Validate everything before performing any visible side effect.

export class WasiExit extends Error {
	constructor(code) {
		super(`the program called exit with code ${code}`);
		this.name = 'WasiExit';
		this.code = code;
	}
}

// WASI errno values used below.
const EBADF = 8;
const EFAULT = 21;
const EINVAL = 28;

// random_get fills at most this many bytes per call; the WASI spec caps a
// single call, so larger requests are served as several fill calls.
const random_fill_max = 65536;

// The default argv. V's own wasi_api fixture asserts argc >= 1, so a host with
// no arguments at all would read as a failure rather than as a plain program.
const default_argv = ['main.wasm'];

// Realtime and monotonic are the two clock ids worth supporting; the CPU-time
// ids describe a thread this runtime does not model.
const CLOCK_REALTIME = 0;
const CLOCK_MONOTONIC = 1;

// guest exposes the guest's linear memory for one import call.
function guest(instance) {
	const memory = instance.exports.memory.buffer;
	const view = new DataView(memory);
	const inBounds = (ptr, size) => ptr <= memory.byteLength && size <= memory.byteLength - ptr;
	return { view, inBounds };
}

// readIovecs parses the iovec array the guest built: 8 bytes per entry, with a
// u32 LE buffer pointer then a u32 LE length. Every pointer is validated before
// the caller acts on it.
function readIovecs(g, iovs, count) {
	const out = [];
	for (let i = 0; i < count; i++) {
		const at = iovs + i * 8;
		if (!g.inBounds(at, 8)) return null;
		out.push({
			buf: g.view.getUint32(at, true),
			len: g.view.getUint32(at + 4, true),
		});
	}
	for (const io of out) {
		if (!g.inBounds(io.buf, io.len)) return null;
	}
	return out;
}

// writeGuest writes the little-endian u32 the WASI ABI uses for sizes and
// counts, tolerating an out-param of 0 because V names address 0 for its
// fd_write byte count.
function writeU32(g, ptr, value) {
	g.view.setUint32(ptr >>> 0, value >>> 0, true);
}

export async function runWasm(bytes, onOutput, options = {}) {
	const argv = options.argv ?? default_argv;
	const stdin = options.stdin ?? [];

	const decoders = new Map([[1, new TextDecoder()], [2, new TextDecoder()]]);
	let instance;
	let outputBytes = 0;
	let stdinPos = 0;
	const imports = {
		wasi_snapshot_preview1: {
			fd_write(fd, iovs, count, written) {
				if (!decoders.has(fd)) return EBADF;
				const g = guest(instance);
				iovs >>>= 0;
				count >>>= 0;
				written >>>= 0;
				if (!g.inBounds(written, 4)) return EFAULT;
				const iovecs = readIovecs(g, iovs, count);
				if (iovecs === null) return EFAULT;
				const chunks = [];
				let total = 0;
				for (const io of iovecs) {
					total += io.len;
					chunks.push(new Uint8Array(g.view.buffer, io.buf, io.len));
				}
				outputBytes += total;
				if (outputBytes > 1024 * 1024) {
					throw new Error('Output exceeded 1 MiB. Stop or shorten the program.');
				}
				for (const chunk of chunks) {
					const text = decoders.get(fd).decode(chunk, { stream: true });
					if (text) onOutput(text);
				}
				writeU32(g, written, total);
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
				const g = guest(instance);
				buf >>>= 0;
				buf_len >>>= 0;
				if (!g.inBounds(buf, buf_len)) return EFAULT;
				const bytes = new Uint8Array(g.view.buffer, buf, buf_len);
				let filled = 0;
				while (filled < buf_len) {
					const can = Math.min(random_fill_max, buf_len - filled);
					crypto.getRandomValues(bytes.subarray(filled, filled + can));
					filled += can;
				}
				return 0;
			},
			// Both halves answer from one immutable snapshot of argv, so a
			// program that queries the sizes and then asks for the pointers
			// cannot observe a list that changed underneath it.
			args_sizes_get(argc_ptr, argv_buf_size_ptr) {
				const g = guest(instance);
				argc_ptr >>>= 0;
				argv_buf_size_ptr >>>= 0;
				if (!g.inBounds(argc_ptr, 4) || !g.inBounds(argv_buf_size_ptr, 4)) return EFAULT;
				// The buffer holds every argument plus its NUL terminator.
				const encoded = argv.map((a) => new TextEncoder().encode(a));
				const bufSize = encoded.reduce((n, e) => n + e.length + 1, 0);
				writeU32(g, argc_ptr, argv.length);
				writeU32(g, argv_buf_size_ptr, bufSize);
				return 0;
			},
			args_get(argv_ptr, argv_buf_ptr) {
				const g = guest(instance);
				argv_ptr >>>= 0;
				argv_buf_ptr >>>= 0;
				const encoded = argv.map((a) => new TextEncoder().encode(a));
				const bufSize = encoded.reduce((n, e) => n + e.length + 1, 0);
				// argc + 1 pointers, the last one 0 as the terminator.
				if (!g.inBounds(argv_ptr, (argv.length + 1) * 4)) return EFAULT;
				if (!g.inBounds(argv_buf_ptr, bufSize)) return EFAULT;
				let at = argv_buf_ptr;
				for (let i = 0; i < encoded.length; i++) {
					writeU32(g, argv_ptr + i * 4, at);
					const bytes = encoded[i];
					new Uint8Array(g.view.buffer, at, bytes.length).set(bytes);
					g.view.setUint8(at + bytes.length, 0);
					at += bytes.length + 1;
				}
				writeU32(g, argv_ptr + encoded.length * 4, 0);
				return 0;
			},
			// Stdin only; the guest reads the buffered input and then sees EOF.
			// The stream has to be drained from memory before _start runs,
			// because _start is one synchronous call and cannot wait for a
			// postMessage.
			fd_read(fd, iovs, iovs_len, nread) {
				if (fd !== 0) return EBADF;
				const g = guest(instance);
				iovs >>>= 0;
				iovs_len >>>= 0;
				nread >>>= 0;
				if (!g.inBounds(nread, 4)) return EFAULT;
				const iovecs = readIovecs(g, iovs, iovs_len);
				if (iovecs === null) return EFAULT;
				let read = 0;
				for (const io of iovecs) {
					const can = Math.min(io.len, stdin.length - stdinPos);
					if (can > 0) {
						new Uint8Array(g.view.buffer, io.buf, can).set(stdin.subarray(stdinPos, stdinPos + can));
						stdinPos += can;
						read += can;
					}
					if (stdinPos >= stdin.length) break;
				}
				writeU32(g, nread, read);
				return 0;
			},
			clock_time_get(clock_id, precision, time_ptr) {
				const g = guest(instance);
				time_ptr >>>= 0;
				if (!g.inBounds(time_ptr, 8)) return EFAULT;
				if (clock_id === CLOCK_REALTIME) {
					const ns = BigInt(Math.round(Date.now() * 1e6));
					g.view.setBigUint64(time_ptr, ns, true);
					return 0;
				}
				if (clock_id === CLOCK_MONOTONIC) {
					const ns = BigInt(Math.round(performance.timeOrigin * 1e6 + performance.now() * 1e6));
					g.view.setBigUint64(time_ptr, ns, true);
					return 0;
				}
				return EINVAL;
			},
		},
	};
	({ instance } = await WebAssembly.instantiate(bytes, imports));
	if (!(instance.exports.memory instanceof WebAssembly.Memory)
		|| typeof instance.exports._start !== 'function') {
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