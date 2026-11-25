/** AudioWorklet：把每个 128 样本块拷一份发到主线程，主线程攒够 960 样本再编码。 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0] && input[0].length) {
      const block = new Float32Array(input[0]);
      this.port.postMessage(block, [block.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
