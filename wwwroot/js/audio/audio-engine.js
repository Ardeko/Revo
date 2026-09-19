/* Locally hosted RNNoise -> voice gate -> WebRTC, with an explicit browser fallback. */
export function finiteNumber(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

let noiseAssets;
async function loadNoiseAssets() {
    if (!noiseAssets) {
        noiseAssets = (async () => {
            const module = await import("../noise-suppressor/index.js");
            const wasmBinary = await module.loadRnnoise({
                url: "/js/noise-suppressor/rnnoise.wasm",
                simdUrl: "/js/noise-suppressor/rnnoise_simd.wasm",
            });
            if (!WebAssembly.validate(wasmBinary)) throw new Error("RNNoise dosyası geçersiz.");
            return { ...module, wasmBinary };
        })().catch((error) => { noiseAssets = null; throw error; });
    }
    return noiseAssets;
}

function waitForWorklet(node, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("RNNoise hazırlanamadı.")), timeoutMs);
        const finish = (error) => {
            clearTimeout(timer);
            node.port.removeEventListener("message", receive);
            node.removeEventListener("processorerror", failed);
            if (error) reject(error); else resolve();
        };
        const failed = () => finish(new Error("RNNoise ses işlemcisi başlatılamadı."));
        const receive = ({ data }) => {
            if (data?.type === "ready") finish();
            if (data?.type === "error") finish(new Error(data.message || "RNNoise başlatılamadı."));
        };
        node.port.addEventListener("message", receive);
        node.addEventListener("processorerror", failed);
        node.port.start();
    });
}

export async function createAudioPipeline(rawStream, options = {}) {
    const { noiseSuppression = true, onLevel = () => {}, onStatus = () => {} } = options;
    const track = rawStream.getAudioTracks()[0];
    if (!track) throw new Error("Mikrofon ses kanalı bulunamadı.");
    let ctx, source, gain, gate, denoiser, destination, analyser;
    let meterTimer, closed = false, mode = "off", fallingBack = false;
    const nodes = [];

    async function browserSuppression() {
        if (!noiseSuppression) return "off";
        try {
            if (typeof track.applyConstraints === "function") {
                await track.applyConstraints({ noiseSuppression: true });
            }
            const settings = track.getSettings?.() || {};
            if ("noiseSuppression" in settings || typeof HTMLMediaElement !== "undefined") {
                return "browser";
            }
            return "unavailable";
        } catch { return "unavailable"; }
    }

    const pipeline = {
        stream: null,
        monitorStream: null,
        rawStream,
        get context() { return ctx; },
        get mode() { return mode; },
        get supportsGain() { return !!gain; },
        get supportsGate() { return !!gate; },
        configure({ inputGain = 1, threshold = 0.06, voiceActivity = true } = {}) {
            if (gain) gain.gain.setTargetAtTime(finiteNumber(inputGain, 1, 0, 2), ctx.currentTime, 0.015);
            gate?.port.postMessage({ type: "configure", threshold, enabled: voiceActivity });
        },
        resume() {
            if (ctx?.state === "suspended") ctx.resume().catch(() => {});
        },
        async close() {
            if (closed) return;
            closed = true;
            clearInterval(meterTimer);
            denoiser?.destroy();
            for (const node of nodes) { try { node.disconnect(); } catch { /* already detached */ } }
            gate?.port.close();
            denoiser?.port.close();
            pipeline.stream?.getTracks().forEach((t) => t.stop());
            pipeline.monitorStream?.getTracks().forEach((t) => t.stop());
            if (ctx && ctx.state !== "closed") await ctx.close().catch(() => {});
        },
    };

    try {
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) throw new Error("Web Audio desteklenmiyor.");
        ctx = new Context({ sampleRate: 48000, latencyHint: "interactive" });
        source = ctx.createMediaStreamSource(rawStream);
        const filter = ctx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = 70;
        filter.Q.value = 0.707;
        gain = ctx.createGain();
        source.connect(filter).connect(gain);
        nodes.push(source, filter, gain);
        destination = ctx.createMediaStreamDestination();
        destination.channelCount = 1;
        nodes.push(destination);
        let tail = gain;

        if (ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
            try {
                await ctx.audioWorklet.addModule("/js/audio/voice-gate.js");
                gate = new AudioWorkletNode(ctx, "revo-voice-gate", { outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
                gate.port.onmessage = ({ data }) => { if (!closed && data?.type === "level") onLevel(data.level, data.open); };
                nodes.push(gate);
            } catch (error) { console.warn("Ses etkinliği işleme kullanılamıyor:", error); }

            if (noiseSuppression && ctx.sampleRate === 48000) {
                try {
                    const assets = await loadNoiseAssets();
                    await ctx.audioWorklet.addModule("/js/noise-suppressor/rnnoise/workletProcessor.js");
                    denoiser = new assets.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: assets.wasmBinary });
                    nodes.push(denoiser);
                    await waitForWorklet(denoiser);
                    gain.connect(denoiser);
                    tail = denoiser;
                    mode = "rnnoise";
                } catch (error) {
                    console.warn("RNNoise yerine tarayıcı gürültü engellemesi kullanılacak:", error);
                    denoiser?.destroy();
                    denoiser?.disconnect();
                    mode = await browserSuppression();
                }
            } else mode = await browserSuppression();
        } else mode = await browserSuppression();

        const output = gate || destination;
        tail.connect(output);
        if (gate) gate.connect(destination);
        if (mode === "rnnoise") {
            denoiser.addEventListener("processorerror", async () => {
                if (closed || fallingBack) return;
                fallingBack = true;
                try { gain.disconnect(denoiser); denoiser.disconnect(); } catch { /* failed graph */ }
                gain.connect(output);
                mode = await browserSuppression();
                if (!closed) onStatus(mode);
            });
        }
        if (gate) {
            gate.addEventListener("processorerror", () => {
                if (closed || !gate) return;
                try { tail.disconnect(gate); gate.disconnect(); } catch { /* failed graph */ }
                tail.connect(destination);
                gate = null;
                onStatus(mode);
            });
        } else {
            // Metering only: a throttled UI timer must never control outgoing speech.
            analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            tail.connect(analyser);
            nodes.push(analyser);
            const samples = new Float32Array(analyser.fftSize);
            meterTimer = setInterval(() => {
                analyser.getFloatTimeDomainData(samples);
                let energy = 0;
                for (const sample of samples) energy += sample * sample;
                onLevel(Math.min(1, Math.sqrt(energy / samples.length) * 5), true);
            }, 50);
        }
        pipeline.monitorStream = destination.stream;
        pipeline.stream = new MediaStream(destination.stream.getAudioTracks().map((t) => t.clone()));
        // Sender track is always closed until the caller applies its mute/PTT state.
        pipeline.stream.getAudioTracks().forEach((t) => { t.enabled = false; t.contentHint = "speech"; });
        pipeline.configure(options);
        pipeline.resume();
        return pipeline;
    } catch (error) {
        await pipeline.close();
        console.warn("İşlenmiş ses kullanılamıyor; mikrofon doğrudan aktarılacak:", error);
        mode = await browserSuppression();
        const stream = new MediaStream(rawStream.getAudioTracks().map((t) => t.clone()));
        stream.getAudioTracks().forEach((t) => { t.enabled = false; });
        return {
            stream, rawStream, monitorStream: rawStream, mode, supportsGain: false, supportsGate: false,
            configure() {}, resume() {},
            async close() { stream.getTracks().forEach((t) => t.stop()); },
        };
    }
}
