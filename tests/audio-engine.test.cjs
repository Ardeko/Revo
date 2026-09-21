const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const engineModule = import(pathToFileURL(path.resolve(__dirname, '../wwwroot/js/audio/audio-engine.js')).href);

function createGate() {
    let Processor;
    const messages = [];
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../wwwroot/js/audio/voice-gate.js'), 'utf8'), {
        sampleRate: 48000,
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
        registerProcessor(name, type) { assert.equal(name, 'revo-voice-gate'); Processor = type; },
    });
    const gate = new Processor();
    return {
        gate, messages,
        configure(data) { gate.port.onmessage({ data: { type: 'configure', ...data } }); },
        frame(amplitude, blocks = 1) {
            let output;
            for (let block = 0; block < blocks; block++) {
                output = new Float32Array(128);
                gate.process([[new Float32Array(128).fill(amplitude)]], [[output]]);
            }
            return output;
        },
    };
}

test('voice gate suppresses low noise, opens for speech and holds syllable endings', () => {
    const gate = createGate();
    assert.equal(gate.frame(0.001, 30).every(value => value === 0), true);
    assert.ok(gate.frame(0.1).at(-1) > 0.09);
    assert.ok(gate.frame(0.001, 50).at(-1) > 0); // 133 ms remains audible.
    assert.equal(gate.frame(0.001, 60).every(value => value === 0), true); // 293 ms closes.
});

test('voice gate supports zero threshold and push to talk without timers or document visibility', () => {
    const gate = createGate();
    gate.configure({ threshold: 0 });
    assert.ok(gate.frame(0.001, 10).at(-1) > 0);
    gate.configure({ threshold: 0.4, enabled: false });
    assert.ok(gate.frame(0.001, 150).at(-1) > 0);
    assert.ok(gate.messages.length >= 7);
    assert.equal(gate.messages.at(-1).open, true);
});

test('voice gate reports pre-gate levels so a closed gate can reopen', () => {
    const gate = createGate();
    gate.frame(0.005, 20);
    assert.equal(gate.messages.at(-1).open, false);
    assert.ok(Math.abs(gate.messages.at(-1).level - 0.025) < 0.0001);
    gate.frame(0.1, 20);
    assert.equal(gate.messages.at(-1).open, true);
});

test('voice gate smooths shutdown and handles disconnected input', () => {
    const gate = createGate();
    gate.frame(0.1, 10);
    let previous = 0.001, maxJump = 0;
    for (let i = 0; i < 110; i++) {
        for (const value of gate.frame(0.001)) { maxJump = Math.max(maxJump, Math.abs(value - previous)); previous = value; }
    }
    assert.ok(maxJump < 0.00001, 'a closed gate should fade instead of creating a click');
    const output = new Float32Array(128).fill(1);
    assert.equal(gate.gate.process([[]], [[output]]), true);
    assert.equal(output.every(value => value === 0), true);
});

class FakeTrack {
    constructor(settings = {}) { this.kind = 'audio'; this.enabled = true; this.readyState = 'live'; this.settings = settings; }
    clone() { return new FakeTrack(this.settings); }
    stop() { this.readyState = 'ended'; }
    async applyConstraints(constraints) { this.constraints = constraints; if (this.settings.supportsNoise) this.settings.noiseSuppression = constraints.noiseSuppression; }
    getSettings() { return this.settings; }
}
class FakeStream {
    constructor(tracks = [new FakeTrack()]) { this.tracks = tracks; }
    getAudioTracks() { return this.tracks; }
    getTracks() { return this.tracks; }
}
class FakeNode {
    constructor() {
        this.connections = [];
        this.gain = { setTargetAtTime: value => { this.gain.value = value; } };
        this.frequency = {};
        this.Q = {};
    }
    connect(node) { this.connections.push(node); return node; }
    disconnect(node) { this.connections = node ? this.connections.filter(connection => connection !== node) : []; }
    getFloatTimeDomainData(array) { array.fill(0.01); }
}
class FakeContext {
    constructor(options) { this.options = options; this.currentTime = 0; this.sampleRate = options.sampleRate; this.state = 'running'; }
    createMediaStreamSource() { return new FakeNode(); }
    createBiquadFilter() { return new FakeNode(); }
    createGain() { return new FakeNode(); }
    createAnalyser() { return new FakeNode(); }
    createMediaStreamDestination() { const node = new FakeNode(); node.stream = new FakeStream(); return node; }
    async close() { this.state = 'closed'; }
}

test('stored numeric zero is retained; malformed gain is bounded safely', async () => {
    const { finiteNumber } = await engineModule;
    assert.equal(finiteNumber('0', 1, 0, 2), 0);
    assert.equal(finiteNumber('NaN', 1, 0, 2), 1);
    assert.equal(finiteNumber(Infinity, 1, 0, 2), 1);
    assert.equal(finiteNumber(4, 1, 0, 2), 2);
    assert.equal(finiteNumber(-1, 1, 0, 2), 0);
});

test('processed sender starts muted, is separate from monitor, and cleanup leaves raw capture to its owner', async () => {
    global.AudioContext = FakeContext;
    global.MediaStream = FakeStream;
    const { createAudioPipeline } = await engineModule;
    const raw = new FakeStream();
    const pipeline = await createAudioPipeline(raw, { noiseSuppression: false, inputGain: 0 });
    assert.equal(pipeline.context.options.sampleRate, 48000);
    assert.equal(pipeline.mode, 'off');
    assert.equal(pipeline.supportsGain, true);
    assert.equal(pipeline.supportsGate, false);
    assert.equal(pipeline.stream.getAudioTracks()[0].enabled, false);
    assert.notEqual(pipeline.stream.getAudioTracks()[0], pipeline.monitorStream.getAudioTracks()[0]);
    pipeline.stream.getAudioTracks()[0].enabled = false;
    assert.equal(pipeline.monitorStream.getAudioTracks()[0].enabled, true);
    await pipeline.close();
    await pipeline.close();
    assert.equal(pipeline.stream.getAudioTracks()[0].readyState, 'ended');
    assert.equal(pipeline.monitorStream.getAudioTracks()[0].readyState, 'ended');
    assert.equal(raw.getAudioTracks()[0].readyState, 'live');
    assert.equal(pipeline.context.state, 'closed');
});

test('unsupported worklets use verified browser suppression and never claim RNNoise', async () => {
    global.AudioContext = FakeContext;
    global.MediaStream = FakeStream;
    const { createAudioPipeline } = await engineModule;
    const raw = new FakeStream([new FakeTrack({ supportsNoise: true })]);
    const pipeline = await createAudioPipeline(raw, { noiseSuppression: true });
    assert.equal(pipeline.mode, 'browser');
    assert.equal(raw.getAudioTracks()[0].constraints.noiseSuppression, true);
    await pipeline.close();
    const unsupported = await createAudioPipeline(new FakeStream(), { noiseSuppression: true });
    assert.equal(unsupported.mode, 'unavailable');
    await unsupported.close();
});

test('Web Audio initialization failure retains a usable, initially muted raw clone', async () => {
    global.AudioContext = class { constructor() { throw new Error('Audio context unavailable'); } };
    global.MediaStream = FakeStream;
    const { createAudioPipeline } = await engineModule;
    const raw = new FakeStream();
    const pipeline = await createAudioPipeline(raw, { noiseSuppression: false });
    assert.equal(pipeline.mode, 'off');
    assert.equal(pipeline.supportsGain, false);
    assert.equal(pipeline.stream.getAudioTracks()[0].enabled, false);
    await pipeline.close();
    assert.equal(raw.getAudioTracks()[0].readyState, 'live');
});

test('browser suppression reports unavailable when the browser ignores or refuses it', async () => {
    global.AudioContext = FakeContext;
    global.MediaStream = FakeStream;
    global.HTMLMediaElement = class {};
    const { createAudioPipeline } = await engineModule;
    for (const settings of [{ noiseSuppression: false }, {}]) {
        const pipeline = await createAudioPipeline(new FakeStream([new FakeTrack(settings)]));
        assert.equal(pipeline.mode, 'unavailable');
        await pipeline.close();
    }
    delete global.HTMLMediaElement;
});

test('browser fallback preserves echo cancellation and capture constraints', async () => {
    global.AudioContext = FakeContext;
    global.MediaStream = FakeStream;
    const { createAudioPipeline } = await engineModule;
    const track = new FakeTrack({ supportsNoise: true });
    track.getConstraints = () => ({ echoCancellation: false, autoGainControl: false, deviceId: { exact: 'headset' } });
    const pipeline = await createAudioPipeline(new FakeStream([track]));
    assert.deepEqual(track.constraints, { echoCancellation: false, autoGainControl: false, deviceId: { exact: 'headset' }, noiseSuppression: true });
    await pipeline.close();
});

test('a disconnected microphone is rejected instead of creating a live but silent sender', async () => {
    const { createAudioPipeline } = await engineModule;
    const track = new FakeTrack();
    track.stop();
    await assert.rejects(createAudioPipeline(new FakeStream([track])), /bağlantısı kesildi/);
});

class FakeWorkletNode extends FakeNode {
    static nodes = [];
    static pendingReady = null;
    constructor(context, name) {
        super();
        this.name = name;
        this.events = new Map();
        this.portEvents = new Map();
        this.port = {
            addEventListener: (type, callback) => this.portEvents.set(type, callback),
            removeEventListener: type => this.portEvents.delete(type),
            start() {}, close: () => { this.portClosed = true; }, postMessage() {},
        };
        FakeWorkletNode.nodes.push(this);
        if (name.includes('/rnnoise')) {
            const ready = () => this.portEvents.get('message')?.({ data: { type: 'ready' } });
            if (FakeWorkletNode.pendingReady) FakeWorkletNode.pendingReady(ready);
            else queueMicrotask(ready);
        }
    }
    addEventListener(type, callback) {
        if (!this.events.has(type)) this.events.set(type, new Set());
        this.events.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.events.get(type)?.delete(callback); }
    async fail() { await Promise.all([...this.events.get('processorerror') || []].map(callback => callback())); }
}

class FakeWorkletContext extends FakeContext {
    constructor(options) { super(options); this.audioWorklet = { addModule: async () => {} }; }
    createGain() { this.inputGain = super.createGain(); return this.inputGain; }
    createMediaStreamDestination() { this.output = super.createMediaStreamDestination(); return this.output; }
}

function setupWorklets() {
    global.AudioContext = FakeWorkletContext;
    global.AudioWorkletNode = FakeWorkletNode;
    global.MediaStream = FakeStream;
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer });
    FakeWorkletNode.nodes = [];
}

test('RNNoise initialization waits for worklet readiness before returning the sender', async () => {
    setupWorklets();
    const { createAudioPipeline } = await engineModule;
    let markReady;
    const waiting = new Promise(resolve => { FakeWorkletNode.pendingReady = ready => { markReady = ready; resolve(); }; });
    let returned = false;
    const result = createAudioPipeline(new FakeStream()).then(pipeline => { returned = true; return pipeline; });
    await waiting;
    assert.equal(returned, false);
    markReady();
    const pipeline = await result;
    assert.equal(pipeline.mode, 'rnnoise');
    assert.equal(pipeline.stream.getAudioTracks()[0].enabled, false);
    await pipeline.close();
    FakeWorkletNode.pendingReady = null;
});

test('either order of runtime denoiser and gate failure preserves the outgoing graph and meter', async () => {
    const { createAudioPipeline } = await engineModule;
    for (const gateFirst of [false, true]) {
        setupWorklets();
        const readings = [];
        const pipeline = await createAudioPipeline(new FakeStream([new FakeTrack({ supportsNoise: true })]), {
            onLevel: (level, open) => readings.push({ level, open }),
        });
        const gate = FakeWorkletNode.nodes.find(node => node.name === 'revo-voice-gate');
        const denoiser = FakeWorkletNode.nodes.find(node => node.name.includes('/rnnoise'));
        await (gateFirst ? gate : denoiser).fail();
        await (gateFirst ? denoiser : gate).fail();
        assert.equal(pipeline.mode, 'browser');
        assert.equal(pipeline.supportsGate, false);
        assert.deepEqual(pipeline.context.inputGain.connections, [pipeline.context.output]);
        assert.equal(pipeline.stream.getAudioTracks()[0].enabled, false, 'failure must not unmute the sender');
        await new Promise(resolve => setTimeout(resolve, 65));
        assert.ok(readings.some(reading => reading.level > 0 && reading.open), 'meter survives gate failure');
        await pipeline.close();
        assert.equal(gate.portClosed, true);
        assert.equal(denoiser.portClosed, true);
    }
});
