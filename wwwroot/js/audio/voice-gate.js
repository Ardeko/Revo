/* Audio-thread voice activity gate. It keeps working when the tab is hidden. */
class RevoVoiceGate extends AudioWorkletProcessor {
    constructor() {
        super();
        this.threshold = 0.06;
        this.enabled = true;
        this.remaining = 0;
        this.gain = 0;
        this.levelEnergy = 0;
        this.levelSamples = 0;
        this.port.onmessage = ({ data }) => {
            if (!data || data.type !== "configure") return;
            if (Number.isFinite(data.threshold)) this.threshold = Math.max(0, Math.min(0.4, data.threshold));
            this.enabled = data.enabled !== false;
        };
    }

    process(inputs, outputs) {
        const input = inputs[0]?.[0];
        const output = outputs[0]?.[0];
        if (!output) return true;
        if (!input) { output.fill(0); return true; }
        let energy = 0;
        for (let i = 0; i < input.length; i++) energy += input[i] * input[i];
        const level = Math.min(1, Math.sqrt(energy / input.length) * 5);
        // Lower closing threshold and 250 ms hold preserve word endings.
        const threshold = this.remaining > 0 ? this.threshold * 0.65 : this.threshold;
        if (!this.enabled || this.threshold === 0 || level >= threshold) {
            this.remaining = Math.round(sampleRate * 0.25);
        } else {
            this.remaining = Math.max(0, this.remaining - input.length);
        }
        const open = !this.enabled || this.threshold === 0 || this.remaining > 0;
        const step = 1 / (sampleRate * (open ? 0.002 : 0.012));
        for (let i = 0; i < output.length; i++) {
            this.gain = open ? Math.min(1, this.gain + step) : Math.max(0, this.gain - step);
            output[i] = (input[i] || 0) * this.gain;
        }
        this.levelEnergy += energy;
        this.levelSamples += input.length;
        if (this.levelSamples >= sampleRate / 20) {
            this.port.postMessage({ type: "level", level: Math.min(1, Math.sqrt(this.levelEnergy / this.levelSamples) * 5), open });
            this.levelEnergy = 0;
            this.levelSamples = 0;
        }
        return true;
    }
}

registerProcessor("revo-voice-gate", RevoVoiceGate);
