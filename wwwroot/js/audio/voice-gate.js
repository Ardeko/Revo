/* Audio-thread voice gate and peak protection. No UI timers or per-frame allocation. */
class RevoVoiceGate extends AudioWorkletProcessor {
    constructor() {
        super();
        this.threshold = 0.06;
        this.enabled = true;
        this.remaining = 0;
        this.gain = 0;
        this.levelEnergy = 0;
        this.levelSamples = 0;
        // 10 ms of pre-roll lets the gate open before a newly detected syllable
        // reaches the output. The same buffer gives peak protection lookahead.
        this.delaySamples = Math.max(1, Math.round(sampleRate * 0.01));
        this.delay = new Float32Array(this.delaySamples);
        this.delayCursor = 0;
        this.sampleIndex = 0;
        this.peakValues = new Float32Array(this.delaySamples + 2);
        this.peakIndices = new Float64Array(this.delaySamples + 2);
        this.peakHead = 0;
        this.peakTail = 0;
        this.limiterGain = 1;
        this.ceiling = Math.pow(10, -1 / 20); // -1 dBFS of headroom for encoding.
        this.limiterAttack = 1 - Math.exp(-1 / (sampleRate * 0.001));
        this.limiterRelease = 1 - Math.exp(-1 / (sampleRate * 0.06));
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
        if (!input) {
            output.fill(0);
            this.remaining = 0;
            this.gain = 0;
            this.delay.fill(0);
            this.peakHead = this.peakTail = 0;
            this.limiterGain = 1;
            this.levelEnergy = 0;
            this.levelSamples += output.length;
            if (this.levelSamples >= sampleRate / 20) {
                this.port.postMessage({ type: "level", level: 0, open: false });
                this.levelSamples = 0;
            }
            return true;
        }
        let energy = 0;
        for (let i = 0; i < input.length; i++) {
            const value = Number.isFinite(input[i]) ? input[i] : 0;
            energy += value * value;
        }
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
            const value = Number.isFinite(input[i]) ? input[i] : 0;
            const delayed = this.delay[this.delayCursor];
            this.delay[this.delayCursor] = value;
            this.delayCursor = (this.delayCursor + 1) % this.delaySamples;

            // Sliding maximum includes the delayed sample and its entire future
            // window. A monotonic queue keeps the work bounded per audio sample.
            const capacity = this.peakValues.length;
            const oldest = this.sampleIndex - this.delaySamples;
            while (this.peakHead !== this.peakTail && this.peakIndices[this.peakHead] < oldest) {
                this.peakHead = (this.peakHead + 1) % capacity;
            }
            const magnitude = Math.abs(value);
            while (this.peakHead !== this.peakTail) {
                const previous = (this.peakTail + capacity - 1) % capacity;
                if (this.peakValues[previous] > magnitude) break;
                this.peakTail = previous;
            }
            this.peakValues[this.peakTail] = magnitude;
            this.peakIndices[this.peakTail] = this.sampleIndex++;
            this.peakTail = (this.peakTail + 1) % capacity;
            const peak = this.peakValues[this.peakHead];
            const target = peak > this.ceiling ? this.ceiling / peak : 1;
            const smoothing = target < this.limiterGain ? this.limiterAttack : this.limiterRelease;
            this.limiterGain += (target - this.limiterGain) * smoothing;
            // Only a final numerical/transient guard: the lookahead envelope has
            // already reduced gain before the overload arrives. Never amplify.
            const safeGain = Math.abs(delayed) > this.ceiling ? this.ceiling / Math.abs(delayed) : 1;
            this.gain = open ? Math.min(1, this.gain + step) : Math.max(0, this.gain - step);
            output[i] = delayed * Math.min(this.limiterGain, safeGain) * this.gain;
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
