// @ts-nocheck
// Yoinked from https://github.com/SteveSanderson/xzwasm/blob/main/src/xzwasm.js

import xzwasmBytes from './xzwasm_bytes';

const XZ_OK = 0;
const XZ_STREAM_END = 1;

class XzContext {
    constructor(moduleInstance : any) {
        this.exports = moduleInstance.exports;
        this.memory = this.exports.memory;
        this.ptr = this.exports.create_context();
        this._refresh();
        this.bufSize = this.mem32[0];
        this.inStart = this.mem32[1] - this.ptr;
        this.inEnd = this.inStart + this.bufSize;
        this.outStart = this.mem32[4] - this.ptr;
    }

    supplyInput(sourceDataUint8Array : Uint8Array) {
        const inBuffer = this.mem8.subarray(this.inStart, this.inEnd);
        inBuffer.set(sourceDataUint8Array, 0);
        this.exports.supply_input(this.ptr, sourceDataUint8Array.byteLength);
        this._refresh();
    }

    getNextOutput() {
        const result = this.exports.get_next_output(this.ptr);
        this._refresh();
        if (result !== XZ_OK && result !== XZ_STREAM_END) {
            throw new Error(`get_next_output failed with error code ${result}`);
        }
        const outChunk = this.mem8.slice(this.outStart, this.outStart + /* outPos */ this.mem32[5]);
        return { outChunk, finished: result === XZ_STREAM_END };
    }

    needsMoreInput() {
        return /* inPos */ this.mem32[2] === /* inSize */ this.mem32[3];
    }

    outputBufferIsFull() {
        return /* outPos */ this.mem32[5] === this.bufSize;
    }

    resetOutputBuffer() {
        this.outPos = this.mem32[5] = 0;
    }

    dispose() {
        this.exports.destroy_context(this.ptr);
        this.exports = null;
    }

    _refresh() {
        if (this.memory.buffer !== this.mem8?.buffer) {
            this.mem8 = new Uint8Array(this.memory.buffer, this.ptr);
            this.mem32 = new Uint32Array(this.memory.buffer, this.ptr);
        }
    }
}

export class XzReadableStream extends ReadableStream<Uint8Array> {
    static _moduleInstancePromise;
    static _moduleInstance;
    static async _getModuleInstance() {
        const wasmBytes = await (await fetch(xzwasmBytes)).arrayBuffer();
        const wasmResponse = new Response(wasmBytes, { headers: { 'Content-Type': 'application/wasm' } });
        const wasmOptions = {};
        const module = typeof WebAssembly.instantiateStreaming === 'function'
            ? await WebAssembly.instantiateStreaming(wasmResponse, wasmOptions)
            : await WebAssembly.instantiate(await wasmResponse.arrayBuffer(), wasmOptions);
        XzReadableStream._moduleInstance = module.instance;
    }

    constructor(compressedStream : ReadableStream<Uint8Array>) {
        let xzContext;
        let unconsumedInput = null;
        const compressedReader = compressedStream.getReader();

        super({
            async start(controller) {
                if (!XzReadableStream._moduleInstance) {
                    await (XzReadableStream._moduleInstancePromise || (XzReadableStream._moduleInstancePromise = XzReadableStream._getModuleInstance()));
                }
                xzContext = new XzContext(XzReadableStream._moduleInstance);
            },

            async pull(controller) {
                if (xzContext.needsMoreInput()) {
                    if (unconsumedInput === null || unconsumedInput.byteLength === 0) {
                        const { done, value } = await compressedReader.read();
                        if (!done) {
                            unconsumedInput = value;
                        }
                    }
                    const nextInputLength = Math.min(xzContext.bufSize, unconsumedInput.byteLength);
                    xzContext.supplyInput(unconsumedInput.subarray(0, nextInputLength));
                    unconsumedInput = unconsumedInput.subarray(nextInputLength);
                }

                const nextOutputResult = xzContext.getNextOutput();
                controller.enqueue(nextOutputResult.outChunk);
                xzContext.resetOutputBuffer();

                if (nextOutputResult.finished) {
                    xzContext.dispose(); // Not sure if this always happens
                    controller.close();
                }
            },
            cancel() {
                xzContext.dispose(); // Not sure if this always happens
                return compressedReader.cancel();
            }
        });
    }
}