/* Capture -> high-pass -> RNNoise -> user gain -> protected voice gate -> WebRTC. */
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
    if (track.readyState === "ended") throw new Error("Mikrofon bağlantısı kesildi.");
    let ctx, source, filter, gain, gate, denoiser, destination, analyser;
    let meterTimer, closed = false, mode = "off", fallingBack = false;
    const nodes = [];

    async function browserSuppression() {
        if (!noiseSuppression) return "off";
        try {
            if (typeof track.applyConstraints === "function") {
                await track.applyConstraints({ ...track.getConstraints?.(), noiseSuppression: true });
            }
            const settings = track.getSettings?.() || {};
            return settings.noiseSuppression === true ? "browser" : "unavailable";
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
            try { denoiser?.destroy(); } catch { /* failed processor */ }
            for (const node of nodes) {
                try { node.disconnect(); } catch { /* already detached */ }
                try { node.port?.close(); } catch { /* already closed */ }
            }
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
        filter = ctx.createBiquadFilter();
        filter.type = "highpass";
        filter.frequency.value = 70;
        filter.Q.value = 0.707;
        gain = ctx.createGain();
        source.connect(filter);
        nodes.push(source, filter, gain);
        destination = ctx.createMediaStreamDestination();
        destination.channelCount = 1;
        nodes.push(destination);
        let tail = filter;

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
                    filter.connect(denoiser);
                    tail = denoiser;
                    mode = "rnnoise";
                } catch (error) {
                    console.warn("RNNoise yerine tarayıcı gürültü engellemesi kullanılacak:", error);
                    try { denoiser?.destroy(); } catch { /* failed processor */ }
                    try { denoiser?.disconnect(); denoiser?.port.close(); } catch { /* failed processor */ }
                    denoiser = null;
                    mode = await browserSuppression();
                }
            } else mode = await browserSuppression();
        } else mode = await browserSuppression();

        // User volume must not change the signal presented to the trained denoiser.
        // Keep it after suppression; the gate also protects amplified peaks.
        tail.connect(gain);
        gain.connect(gate || destination);
        if (gate) gate.connect(destination);
        const startFallbackMeter = () => {
            if (closed || meterTimer) return;
            // Metering only: a throttled UI timer must never control outgoing speech.
            analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            const meterSource = ctx.createMediaStreamSource(destination.stream);
            meterSource.connect(analyser);
            nodes.push(meterSource, analyser);
            const samples = new Float32Array(analyser.fftSize);
            meterTimer = setInterval(() => {
                if (closed) return;
                analyser.getFloatTimeDomainData(samples);
                let energy = 0;
                for (const sample of samples) energy += sample * sample;
                onLevel(Math.min(1, Math.sqrt(energy / samples.length) * 5), true);
            }, 50);
        };
        if (mode === "rnnoise") {
            denoiser.addEventListener("processorerror", async () => {
                if (closed || fallingBack) return;
                fallingBack = true;
                try { filter.disconnect(denoiser); } catch { /* failed graph */ }
                try { denoiser.disconnect(); } catch { /* failed graph */ }
                tail = filter;
                filter.connect(gain);
                mode = await browserSuppression();
                if (!closed) onStatus(mode);
            });
        }
        if (gate) {
            gate.addEventListener("processorerror", () => {
                if (closed || !gate) return;
                try { gain.disconnect(gate); } catch { /* failed graph */ }
                try { gate.disconnect(); gate.port.close(); } catch { /* failed graph */ }
                gain.connect(destination);
                gate = null;
                startFallbackMeter();
                onStatus(mode);
            });
        } else {
            startFallbackMeter();
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
