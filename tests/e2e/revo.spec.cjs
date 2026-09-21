const { test, expect } = require('@playwright/test');

async function observeMedia(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.__peers = [];
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
            constructor(...args) { super(...args); window.__peers.push(this); }
        };
        window.__sockets = [];
        const Socket = window.WebSocket;
        window.WebSocket = class extends Socket {
            constructor(...args) { super(...args); window.__sockets.push(this); }
        };
        window.__captures = [];
        const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async constraints => {
            const stream = await capture(constraints);
            window.__captures.push({ constraints, stream });
            return stream;
        };
    });
    return errors;
}

async function enter(page, name, code = null) {
    await page.goto(code ? `/oda/${encodeURIComponent(code)}` : '/Chat/Login');
    await page.locator('#usernameInput').fill(name);
    if (code) {
        await page.locator('#joinForm button[type=submit]').click();
    } else {
        await page.locator('.mode-tab[data-mode=create]').click();
        await page.locator('#createForm button[type=submit]').click();
    }
    await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    await expect(page.locator('#participantList')).toContainText(name);
    return (await page.locator('#roomCodeText').textContent()).trim();
}

async function outboundBytes(page) {
    return page.evaluate(async () => {
        let bytes = 0;
        for (const pc of window.__peers) {
            if (pc.connectionState !== 'connected') continue;
            const stats = await pc.getStats();
            stats.forEach(stat => {
                if (stat.type === 'outbound-rtp' && stat.kind === 'audio') bytes += stat.bytesSent || 0;
            });
        }
        return bytes;
    });
}

test('local assets, invite, chat, audio settings and keyboard navigation', async ({ page }, testInfo) => {
    const errors = await observeMedia(page);
    await page.goto('/Chat/Login');
    await page.screenshot({ path: testInfo.outputPath('login-desktop.png'), fullPage: true });
    for (const path of ['/js/room.js', '/js/room-ui.js', '/lib/signalr/signalr.min.js', '/js/noise-suppressor/rnnoise.wasm']) {
        const response = await page.request.get(path);
        expect(response.ok(), path).toBe(true);
    }
    const room = await enter(page, 'Arda');
    expect(room).toBeTruthy();
    await page.locator('#messageInput').fill('Merhaba REVO! <script>alert(1)</script>');
    await page.locator('#messageForm button[type=submit]').click();
    await expect(page.locator('#messagesList')).toContainText('Merhaba REVO! <script>alert(1)</script>');
    await expect(page.locator('#messagesList script')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('room-desktop.png'), fullPage: true });

    await page.locator('#settingsButton').click();
    await expect(page.locator('#settingsOverlay')).toBeVisible();
    await expect(page.locator('#audioProcessingStatus')).toContainText('RNNoise');
    await expect(page.locator('#settingsOverlay')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('settings-desktop.png'), fullPage: true });
    await page.locator('#masterVolume').fill('0');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('revo_master_vol'))).toBe('0');
    await page.keyboard.press('Escape');
    await expect(page.locator('#settingsOverlay')).toBeHidden();
    await expect(page.locator('#settingsButton')).toBeFocused();
    await page.reload();
    await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    await page.locator('#settingsButton').click();
    await expect(page.locator('#masterVolume')).toHaveValue('0');
    expect(errors).toEqual([]);
});

test('settings tabs preserve appearance and camera preview only captures on request', async ({ page }) => {
    const errors = await observeMedia(page);
    await enter(page, 'Ayarlar');
    await page.locator('#settingsButton').click();
    await expect.poll(() => page.evaluate(() => window.__captures.filter(item => item.constraints.video).length)).toBe(0);
    await page.locator('#tabVideo').click();
    await expect(page.locator('#settingsVideo')).toBeVisible();
    await expect(page.locator('#settingsAudio')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__captures.filter(item => item.constraints.video).length)).toBe(0);
    await page.locator('#cameraPreviewButton').click();
    await expect.poll(() => page.locator('#settingsCamPreview').evaluate(video => video.videoWidth)).toBeGreaterThan(0);
    await page.locator('#tabAppearance').click();
    await page.locator('#themeSelect').selectOption('dark');
    await page.locator('#chatFontSize').fill('16');
    await page.locator('#compactChatCheck').check();
    await page.locator('#reduceMotionCheck').check();
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__captures.flatMap(item => item.stream.getVideoTracks()).every(track => track.readyState === 'ended'))).toBe(true);
    await page.reload();
    await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    await page.locator('#settingsButton').click();
    await page.locator('#tabAppearance').click();
    await expect(page.locator('#themeSelect')).toHaveValue('dark');
    await expect(page.locator('#chatFontSize')).toHaveValue('16');
    await expect(page.locator('#compactChatCheck')).toBeChecked();
    await expect(page.locator('#reduceMotionCheck')).toBeChecked();
    await page.locator('#tabAppearance').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tabShortcuts')).toBeFocused();
    await expect(page.locator('#settingsShortcuts')).toBeVisible();
    expect(errors).toEqual([]);
});

test('two browsers exchange WebRTC audio, messages, mute state and camera', async ({ browser, page }, testInfo) => {
    const errors = await observeMedia(page);
    const room = await enter(page, 'Ada');
    const context2 = await browser.newContext({ permissions: ['microphone', 'camera'], baseURL: 'http://127.0.0.1:5187' });
    const other = await context2.newPage();
    const otherErrors = await observeMedia(other);
    try {
        await enter(other, 'Deniz', room);
        await expect(page.locator('#participantCount')).toHaveText('2 kişi');
        await expect(other.locator('#participantCount')).toHaveText('2 kişi');
        await expect.poll(() => page.evaluate(() => window.__peers.some(pc => pc.connectionState === 'connected'))).toBe(true);
        await expect.poll(() => outboundBytes(page)).toBeGreaterThan(0);
        await expect.poll(() => outboundBytes(other)).toBeGreaterThan(0);
        await expect.poll(() => other.locator('#remoteAudios audio').evaluateAll(elements => elements.some(el => !el.paused && el.readyState >= 2))).toBe(true);
        await page.locator('#messageInput').fill('Ses bağlantısı hazır.');
        await page.locator('#messageForm button[type=submit]').click();
        await expect(other.locator('#messagesList')).toContainText('Ses bağlantısı hazır.');

        const peerCard = page.getByRole('button', { name: 'Deniz için ses ayarları' });
        await peerCard.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#userMenuVolume')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('#userMenu')).toBeHidden();
        await expect(peerCard).toBeFocused();

        await page.locator('#muteButton').click();
        await expect(page.locator('#muteButton')).toHaveAttribute('aria-pressed', 'true');
        await expect(other.locator('.participant').filter({ hasText: 'Ada' })).toHaveClass(/muted/);
        await expect.poll(() => page.evaluate(() => window.__peers.filter(pc => pc.connectionState === 'connected').every(pc => pc.getSenders().filter(s => s.track?.kind === 'audio').every(s => !s.track.enabled)))).toBe(true);
        await page.locator('#muteButton').click();
        await page.locator('#deafenButton').click();
        await expect.poll(() => page.locator('#remoteAudios audio').evaluateAll(elements => elements.every(el => el.muted))).toBe(true);
        await page.locator('#deafenButton').click();

        await page.locator('.mode-pill[data-mode=ptt]').click();
        await expect.poll(() => page.evaluate(() => window.__peers.filter(pc => pc.connectionState === 'connected').every(pc => pc.getSenders().filter(s => s.track?.kind === 'audio').every(s => !s.track.enabled)))).toBe(true);
        await page.keyboard.down('Space');
        await expect.poll(() => page.evaluate(() => window.__peers.some(pc => pc.getSenders().some(s => s.track?.kind === 'audio' && s.track.enabled)))).toBe(true);
        await page.keyboard.up('Space');
        await page.locator('.mode-pill[data-mode=always]').click();

        await page.locator('#settingsButton').click();
        await page.locator('#micTestButton').click();
        await expect(page.locator('#micTestButton')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => page.evaluate(() => window.__peers.filter(pc => pc.connectionState === 'connected').every(pc => pc.getSenders().filter(s => s.track?.kind === 'audio').every(s => !s.track.enabled)))).toBe(true);
        await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => window.__peers.some(pc => pc.getSenders().some(s => s.track?.kind === 'audio' && s.track.enabled)))).toBe(true);
        await page.locator('#cameraButton').click();
        await expect(page.locator('#cameraButton')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => other.locator('#videoGallery video').evaluateAll(videos => videos.some(video => video.videoWidth > 0))).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('room-video.png'), fullPage: true });
        await page.locator('#cameraButton').click();

        // Changing processing must replace the sender track without ending the call.
        const bytesBefore = await outboundBytes(page);
        await page.locator('#noiseSuppressionButton').click();
        await expect.poll(() => outboundBytes(page)).toBeGreaterThan(bytesBefore);
        await expect.poll(() => page.evaluate(() => window.__peers.some(pc => pc.connectionState === 'connected'))).toBe(true);

        // Force a transport interruption and verify room rejoin, media and chat recover.
        await page.evaluate(() => window.__sockets.forEach(socket => socket.close()));
        await expect.poll(() => page.evaluate(() => window.__sockets.length)).toBeGreaterThan(1);
        await expect(page.locator('#statusDot')).toHaveClass(/connected/);
        await expect(other.locator('#participantCount')).toHaveText('2 kişi');
        await expect.poll(() => page.evaluate(() => window.__peers.some(pc => pc.connectionState === 'connected'))).toBe(true);
        await page.locator('#messageInput').fill('Yeniden bağlandım.');
        await page.locator('#messageForm button[type=submit]').click();
        await expect(other.locator('#messagesList')).toContainText('Yeniden bağlandım.');
        expect(errors).toEqual([]);
        expect(otherErrors).toEqual([]);
    } finally {
        await context2.close();
    }
});

test('RNNoise load failure reports the actual fallback capability and preserves chat', async ({ page }) => {
    const errors = await observeMedia(page);
    await page.route('**/rnnoise*.wasm', route => route.abort());
    await enter(page, 'Yedek');
    await page.locator('#settingsButton').click();
    await expect(page.locator('#audioProcessingStatus')).toHaveText(/Tarayıcı gürültü engellemesi etkin|Gürültü engelleme bu tarayıcıda kullanılamıyor/);
    const browserSuppression = await page.evaluate(() => window.__captures
        .flatMap(item => item.stream.getAudioTracks())
        .some(track => track.readyState === 'live' && track.getSettings().noiseSuppression === true));
    await expect(page.locator('#audioProcessingStatus')).toHaveText(browserSuppression
        ? 'Tarayıcı gürültü engellemesi etkin'
        : 'Gürültü engelleme bu tarayıcıda kullanılamıyor');
    await page.locator('#micTestButton').click();
    await expect(page.locator('#micTestButton')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#settingsOverlay')).toBeHidden();
    await expect(page.locator('#settingsButton')).toBeFocused();
    await page.locator('#messageInput').fill('Sohbete devam edebiliyorum.');
    await expect(page.locator('#messageInput')).toHaveValue('Sohbete devam edebiliyorum.');
    await page.locator('#messageForm button[type=submit]').click();
    await expect(page.locator('#messagesList')).toContainText('Sohbete devam edebiliyorum.');
    expect(errors).toEqual([]);
});

test('password room survives refresh and rejects an incorrect password', async ({ page, browser }) => {
    await page.goto('/Chat/Login');
    await page.locator('#usernameInput').fill('Kurucu');
    await page.locator('.mode-tab[data-mode=create]').click();
    await page.locator('#createForm input[name=password]').fill('revo-test-password');
    await page.locator('#createForm button[type=submit]').click();
    await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    const room = (await page.locator('#roomCodeText').textContent()).trim();
    await page.reload();
    await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    await expect(page.locator('#confirmOverlay')).toBeHidden();
    const context2 = await browser.newContext({ baseURL: 'http://127.0.0.1:5187' });
    const other = await context2.newPage();
    try {
        await other.goto(`/oda/${room}`);
        await other.locator('#usernameInput').fill('Misafir');
        await other.locator('#joinForm input[name=password]').fill('wrong-password');
        await other.locator('#joinForm button[type=submit]').click();
        await expect(other.locator('.form-error')).toContainText('Şifre');
        await expect(other.locator('#roomLayout')).toHaveCount(0);
    } finally { await context2.close(); }
});

test('microphone denial keeps text chat available', async ({ page }) => {
    const errors = await observeMedia(page);
    await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied for test', 'NotAllowedError'); };
    });
    await enter(page, 'Yazar');
    await page.locator('#messageInput').fill('Mikrofon olmadan mesaj.');
    await page.locator('#messageForm button[type=submit]').click();
    await expect(page.locator('#messagesList')).toContainText('Mikrofon olmadan mesaj.');
    expect(errors).toEqual([]);
});

test('a participant who denies microphone permission can still hear the room', async ({ browser, page }) => {
    await observeMedia(page);
    const room = await enter(page, 'Konuşan');
    const listenerContext = await browser.newContext({ baseURL: 'http://127.0.0.1:5187' });
    const listener = await listenerContext.newPage();
    const errors = await observeMedia(listener);
    await listener.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied for test', 'NotAllowedError'); };
    });
    try {
        await enter(listener, 'Dinleyen', room);
        await expect.poll(() => listener.evaluate(() => window.__peers.some(pc => pc.connectionState === 'connected'))).toBe(true);
        await expect.poll(() => listener.locator('#remoteAudios audio').evaluateAll(elements => elements.some(el => !el.paused && el.readyState >= 2))).toBe(true);
        await expect.poll(() => listener.evaluate(async () => {
            let received = 0;
            for (const pc of window.__peers) {
                const stats = await pc.getStats();
                stats.forEach(stat => { if (stat.type === 'inbound-rtp' && stat.kind === 'audio') received += stat.bytesReceived || 0; });
            }
            return received;
        })).toBeGreaterThan(0);
        expect(errors).toEqual([]);
    } finally { await listenerContext.close(); }
});

test('mobile layout keeps controls and settings inside the viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/Chat/Login');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator('#usernameInput')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('login-mobile.png'), fullPage: true });
    await enter(page, 'Mobil');
    await expect(page.locator('#participantList')).toBeVisible();
    await expect(page.locator('#settingsButton')).toBeInViewport();
    await expect(page.locator('#leaveButton')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('room-mobile.png'), fullPage: true });
    await page.locator('[data-room-pane=chat]').click();
    await expect(page.locator('#messageInput')).toBeInViewport();
    await page.locator('#messageInput').fill('Mobil sohbet hazır.');
    await page.locator('#sendButton').click();
    await expect(page.locator('#messagesList')).toContainText('Mobil sohbet hazır.');
    await page.screenshot({ path: testInfo.outputPath('chat-mobile.png'), fullPage: true });
    await page.locator('#settingsButton').click();
    await expect(page.locator('#settingsClose')).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('settings-mobile.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('login validates empty names and exposes the room browser', async ({ page }, testInfo) => {
    const errors = await observeMedia(page);
    await page.goto('/Chat/Login');
    await page.locator('#publicGo').click();
    await expect(page.locator('#usernameInput')).toBeFocused();
    await expect(page.locator('#usernameGroup .field-note')).toBeVisible();
    await page.goto('/Chat/Rooms');
    await expect(page.locator('.room-name')).toContainText(['Açık Frekans']);
    await page.screenshot({ path: testInfo.outputPath('rooms-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('rooms-mobile.png'), fullPage: true });
    expect(errors).toEqual([]);
});
