const { test, expect } = require('@playwright/test');

async function observeVoice(page, denyMicrophone = false) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ denyMicrophone }) => {
        window.__denyMicrophone = denyMicrophone;
        window.__voiceCaptures = [];
        window.__voicePeers = [];
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
            if (constraints.audio && window.__denyMicrophone) {
                throw new DOMException('Microphone permission denied for regression check', 'NotAllowedError');
            }
            const stream = await capture(constraints);
            window.__voiceCaptures.push(stream);
            return stream;
        };
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
            constructor(...args) {
                super(...args);
                window.__voicePeers.push(this);
            }
        };
    }, { denyMicrophone });
    return errors;
}

async function enterRoom(page, name, code) {
    await page.goto(code ? `/oda/${encodeURIComponent(code)}` : '/Chat/Login');
    await page.locator('#usernameInput').fill(name);
    if (code) {
        await page.locator('#joinForm button[type=submit]').click();
    } else {
        await page.locator('.mode-tab[data-mode=create]').click();
        await page.locator('#createForm button[type=submit]').click();
    }
    await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    return (await page.locator('#roomCodeText').textContent()).trim();
}

async function audioBytes(page, direction) {
    return page.evaluate(async direction => {
        let bytes = 0;
        for (const peer of window.__voicePeers) {
            if (peer.connectionState !== 'connected') continue;
            const stats = await peer.getStats();
            stats.forEach(stat => {
                if (stat.type === `${direction}-rtp` && stat.kind === 'audio') {
                    bytes += direction === 'inbound' ? stat.bytesReceived || 0 : stat.bytesSent || 0;
                }
            });
        }
        return bytes;
    }, direction);
}

test('a listener can enable a previously denied microphone with one click and sees accurate voice states', async ({ page, browser }) => {
    const errors = await observeVoice(page, true);
    const code = await enterRoom(page, 'Dinleyen');
    await expect(page.locator('#selfChipState')).toContainText('Dinleyici');
    await expect(page.locator('#txIndicator')).toContainText('Mikrofon izni yok');
    await expect(page.locator('.participant.you .participant-status')).toHaveText('Dinleyici');
    await expect(page.locator('#muteButton')).toHaveAttribute('aria-label', 'Mikrofonu etkinleştir');

    const otherContext = await browser.newContext({
        baseURL: 'http://127.0.0.1:5187',
        permissions: ['microphone', 'camera']
    });
    const other = await otherContext.newPage();
    const otherErrors = await observeVoice(other);
    try {
        await enterRoom(other, 'Konuşan', code);
        // Permission denial still allows receiving another participant's real WebRTC audio.
        await expect.poll(() => audioBytes(page, 'inbound')).toBeGreaterThan(0);
        await expect.poll(() => page.locator('#remoteAudios audio').evaluateAll(elements =>
            elements.some(element => !element.paused && element.readyState >= 2))).toBe(true);

        await page.evaluate(() => { window.__denyMicrophone = false; });
        await page.locator('#muteButton').click();

        await expect(page.locator('#selfChipState')).toHaveText('Görüşmeye hazır');
        await expect(page.locator('#muteButton')).toHaveAttribute('aria-label', 'Mikrofonu kapat');
        await expect(page.locator('.participant.you .participant-status')).toHaveText(/Dinliyor|Konuşuyor/);
        await expect.poll(() => page.evaluate(() => window.__voiceCaptures.some(stream =>
            stream.getAudioTracks().some(track => track.readyState === 'live')))).toBe(true);
        // The same room connection must start carrying the recovered microphone in both directions.
        await expect.poll(() => audioBytes(page, 'outbound')).toBeGreaterThan(0);
        await expect.poll(() => audioBytes(other, 'inbound')).toBeGreaterThan(0);
        await expect.poll(() => other.locator('#remoteAudios audio').evaluateAll(elements =>
            elements.some(element => !element.paused && element.readyState >= 2))).toBe(true);

        await page.locator('#muteButton').click();
        await expect(page.locator('.participant.you .participant-status')).toHaveText('Mikrofon kapalı');
        await expect(other.locator('.participant:not(.you) .participant-status')).toHaveText('Mikrofon kapalı');
        await page.locator('#deafenButton').click();
        await expect(page.locator('.participant.you .participant-status')).toHaveText('Kulaklık kapalı');
        await expect(other.locator('.participant:not(.you) .participant-status')).toHaveText('Kulaklık kapalı');
        expect(errors).toEqual([]);
        expect(otherErrors).toEqual([]);
    } finally {
        await otherContext.close();
    }
});

test('unsupported screen sharing explains the limitation without starting media', async ({ page }) => {
    const errors = await observeVoice(page);
    await page.addInitScript(() => {
        Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
            configurable: true,
            value: undefined
        });
    });
    await enterRoom(page, 'Paylaşım kontrolü');
    await expect(page.locator('#selfChipState')).toHaveText('Görüşmeye hazır');
    const capturesBefore = await page.evaluate(() => window.__voiceCaptures.length);

    await page.locator('#screenShareButton').click();

    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toContainText('Bu tarayıcı ekran paylaşımını desteklemiyor.');
    await expect(page.locator('#screenShareButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#cameraButton')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#screenShareStage')).toBeHidden();
    expect(await page.evaluate(() => window.__voiceCaptures.length)).toBe(capturesBefore);
    expect(errors).toEqual([]);
});
