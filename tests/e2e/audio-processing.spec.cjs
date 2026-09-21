const { test, expect } = require('@playwright/test');
const path = require('node:path');

test('real RNNoise worklet attenuates steady noise and preserves the unfiltered signal path', async ({ page }, testInfo) => {
    await page.goto('/Chat/Login');
    const result = await page.evaluate(async () => {
        const { createAudioPipeline } = await import('/js/audio/audio-engine.js');
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const buffer = ctx.createBuffer(1, 48000 * 4, 48000);
        const data = buffer.getChannelData(0);
        let seed = 12345;
        for (let i = 0; i < data.length; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            data[i] = ((seed / 4294967296) * 2 - 1) * 0.05;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const raw = ctx.createMediaStreamDestination();
        source.connect(raw);
        source.start();
        const settings = { voiceActivity: false, threshold: 0, inputGain: 1 };
        const unfiltered = await createAudioPipeline(raw.stream, { ...settings, noiseSuppression: false });
        const filtered = await createAudioPipeline(raw.stream, { ...settings, noiseSuppression: true });
        function meter(stream) {
            const node = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            node.connect(analyser);
            return analyser;
        }
        const before = meter(unfiltered.monitorStream);
        const after = meter(filtered.monitorStream);
        function rms(analyser) {
            const samples = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(samples);
            return Math.sqrt(samples.reduce((energy, value) => energy + value * value, 0) / samples.length);
        }
        try {
            await new Promise(resolve => setTimeout(resolve, 2500));
            const samples = [];
            for (let i = 0; i < 12; i++) {
                samples.push({ before: rms(before), after: rms(after) });
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            unfiltered.configure({ ...settings, inputGain: 0 });
            await new Promise(resolve => setTimeout(resolve, 300));
            return {
                mode: filtered.mode,
                before: samples.reduce((sum, sample) => sum + sample.before, 0) / samples.length,
                after: samples.reduce((sum, sample) => sum + sample.after, 0) / samples.length,
                zeroGain: rms(before),
                rate: filtered.context.sampleRate
            };
        } finally {
            source.stop();
            await unfiltered.close();
            await filtered.close();
            raw.stream.getTracks().forEach(track => track.stop());
            await ctx.close();
        }
    });
    await testInfo.attach('measured-noise-levels', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result.mode).toBe('rnnoise');
    expect(result.rate).toBe(48000);
    expect(result.before).toBeGreaterThan(0.015);
    expect(result.after).toBeLessThan(result.before * 0.65);
    expect(result.zeroGain).toBeLessThan(0.0001);
});

test('RNNoise preserves audible speech through the outgoing processed track', async ({ page }, testInfo) => {
    await page.route('**/test-speech.wav', route => route.fulfill({ path: path.resolve(__dirname, '../fixtures/speech.wav'), contentType: 'audio/wav' }));
    await page.goto('/Chat/Login');
    const result = await page.evaluate(async () => {
        const { createAudioPipeline } = await import('/js/audio/audio-engine.js');
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const response = await fetch('/test-speech.wav');
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const raw = ctx.createMediaStreamDestination();
        source.connect(raw);
        const pipeline = await createAudioPipeline(raw.stream, { noiseSuppression: true, threshold: 0.06, inputGain: 1, voiceActivity: true });
        pipeline.stream.getAudioTracks()[0].enabled = true;
        const input = ctx.createMediaStreamSource(raw.stream);
        const output = ctx.createMediaStreamSource(pipeline.stream);
        const before = ctx.createAnalyser();
        const after = ctx.createAnalyser();
        input.connect(before);
        output.connect(after);
        source.start();
        const samples = new Float32Array(2048);
        let inputEnergy = 0, outputEnergy = 0, peak = 0;
        try {
            for (let i = 0; i < 75; i++) {
                await new Promise(resolve => setTimeout(resolve, 50));
                before.getFloatTimeDomainData(samples);
                for (const sample of samples) inputEnergy += sample * sample;
                after.getFloatTimeDomainData(samples);
                for (const sample of samples) { outputEnergy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
            }
            return { mode: pipeline.mode, inputEnergy, outputEnergy, peak, rmsRatio: Math.sqrt(outputEnergy / inputEnergy) };
        } finally {
            source.stop();
            await pipeline.close();
            raw.stream.getTracks().forEach(track => track.stop());
            await ctx.close();
        }
    });
    await testInfo.attach('measured-speech-levels', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result.mode).toBe('rnnoise');
    expect(result.inputEnergy).toBeGreaterThan(1);
    expect(result.outputEnergy).toBeGreaterThan(1);
    expect(result.rmsRatio).toBeGreaterThan(0.15);
    expect(result.rmsRatio).toBeLessThan(1.5);
    expect(result.peak).toBeLessThan(1);
});
