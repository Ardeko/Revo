const { test, expect } = require('@playwright/test');

function observeErrors(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    return errors;
}

async function enter(page, name, code = null) {
    await page.goto(code ? `/oda/${encodeURIComponent(code)}` : '/Chat/Login');
    await page.locator('#usernameInput').fill(name);
    if (code) await page.locator('#joinForm button[type=submit]').click();
    else {
        await page.locator('.mode-tab[data-mode=create]').click();
        await page.locator('#createForm button[type=submit]').click();
    }
    await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    await expect(page.locator('#participantList')).toContainText(name);
    return (await page.locator('#roomCodeText').textContent()).trim();
}

async function openAppearance(page) {
    await page.locator('#settingsButton').click();
    await page.locator('#tabAppearance').click();
    await expect(page.locator('#settingsAppearance')).toBeVisible();
}

// Read rendered pixels, not renderer counters or animation implementation state.
async function fingerprint(canvas) {
    return canvas.evaluate(element => {
        const pixels = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
        let hash = 2166136261;
        for (let index = 0; index < pixels.length; index += 4) {
            hash = Math.imul(hash ^ pixels[index], 16777619);
            hash = Math.imul(hash ^ pixels[index + 1], 16777619);
            hash = Math.imul(hash ^ pixels[index + 2], 16777619);
            hash = Math.imul(hash ^ pixels[index + 3], 16777619);
        }
        return hash >>> 0;
    });
}

async function expectMoving(canvas) {
    await expect(canvas).toBeVisible();
    await expect.poll(() => canvas.evaluate(element => element.width * element.height)).toBeGreaterThan(1000);
    const first = await fingerprint(canvas);
    await expect.poll(() => fingerprint(canvas)).not.toBe(first);
}

async function expectStill(page, canvas) {
    // Let the browser deliver preference events and finish an already queued frame.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const first = await fingerprint(canvas);
    await page.waitForTimeout(240);
    expect(await fingerprint(canvas)).toBe(first);
}

async function expectWallpaper(page, mode, host) {
    const artwork = page.locator(host);
    const canvas = artwork.locator('canvas');
    if (mode === 'plain') {
        await expect(canvas).toBeHidden();
        await expect(artwork).not.toHaveCSS('background-image', /revo-eclipse\.png/);
    } else {
        await expect(canvas).toBeVisible();
        if (mode === 'eclipse') await expect(artwork).toHaveCSS('background-image', /revo-eclipse\.png/);
        else await expect(artwork).not.toHaveCSS('background-image', /revo-eclipse\.png/);
    }
}

test('wallpaper really moves and both system and app reduced motion freeze its pixels', async ({ page }) => {
    const errors = observeErrors(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/Chat/Login');
    const loginCanvas = page.locator('.login-backdrop canvas');
    await expectMoving(loginCanvas);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectStill(page, loginCanvas);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expectMoving(loginCanvas);

    await enter(page, 'Hareket');
    const roomCanvas = page.locator('.room-hero__atmosphere canvas');
    await expectMoving(roomCanvas);
    await openAppearance(page);
    await page.locator('#reduceMotionCheck').check();
    await page.keyboard.press('Escape');
    await expectStill(page, roomCanvas);
    await openAppearance(page);
    await page.locator('#reduceMotionCheck').uncheck();
    await page.keyboard.press('Escape');
    await expectMoving(roomCanvas);
    expect(errors).toEqual([]);
});

test('all wallpapers and the movement preference survive reload and the login screen', async ({ page }) => {
    const errors = observeErrors(page);
    await enter(page, 'Görünüm');
    const roomUrl = page.url();
    for (const [mode, moving] of [['silk', true], ['plain', false], ['eclipse', false]]) {
        await openAppearance(page);
        const radio = page.locator(`input[name=wallpaper][value=${mode}]`);
        await page.locator('.wallpaper-choice').filter({ has: radio }).click();
        await expect(radio).toBeChecked();
        await page.locator('#wallpaperMotionCheck').setChecked(moving);
        await page.keyboard.press('Escape');
        await expectWallpaper(page, mode, '.room-hero__atmosphere');
        if (mode === 'silk') await page.screenshot({ path: 'artifacts/preview/voice-room-silk.png', animations: 'disabled' });
        if (mode !== 'plain') {
            const canvas = page.locator('.room-hero__atmosphere canvas');
            if (moving) await expectMoving(canvas); else await expectStill(page, canvas);
        }

        await page.reload();
        await expect(page.locator('#statusDot')).toHaveClass(/connected/);
        await expectWallpaper(page, mode, '.room-hero__atmosphere');
        await openAppearance(page);
        await expect(page.locator(`input[name=wallpaper][value=${mode}]`)).toBeChecked();
        await expect(page.locator('#wallpaperMotionCheck')).toBeChecked({ checked: moving });
        await page.keyboard.press('Escape');

        await page.goto('/Chat/Login');
        await expectWallpaper(page, mode, '.login-backdrop');
        if (mode === 'silk') await page.screenshot({ path: 'artifacts/preview/login-silk.png', animations: 'disabled' });
        if (mode !== 'plain') {
            const canvas = page.locator('.login-backdrop canvas');
            if (moving) await expectMoving(canvas); else await expectStill(page, canvas);
        }
        await page.goto(roomUrl);
        await expect(page.locator('#statusDot')).toHaveClass(/connected/);
    }
    expect(errors).toEqual([]);
});

for (const width of [320, 390]) {
    test(`mobile ${width}px separates voice and chat, counts real incoming messages, and keeps settings close accessible`, async ({ page, browser }) => {
        await page.setViewportSize({ width, height: 740 });
        const errors = observeErrors(page);
        const room = await enter(page, 'Ada');
        const otherContext = await browser.newContext({
            baseURL: 'http://127.0.0.1:5187', permissions: ['microphone', 'camera']
        });
        const other = await otherContext.newPage();
        const otherErrors = observeErrors(other);
        try {
            await enter(other, 'Deniz', room);
            await expect(page.locator('#participantList')).toContainText('Deniz');
            const voiceTab = page.locator('[data-room-pane=voice]');
            const chatTab = page.locator('[data-room-pane=chat]');
            await expect(voiceTab).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('#salon')).toBeVisible();
            await expect(page.locator('.chat-panel')).toBeHidden();
            await expect(page.locator('#mobileUnread')).toBeHidden();

            await other.locator('#messageInput').fill('Sohbette seni bekliyorum.');
            await other.locator('#messageForm button[type=submit]').click();
            await expect(page.locator('#mobileUnread')).toHaveText('1');
            await expect(page.locator('#mobileUnread')).toBeVisible();
            await chatTab.click();
            await expect(chatTab).toHaveAttribute('aria-pressed', 'true');
            await expect(page.locator('#salon')).toBeHidden();
            await expect(page.locator('.chat-panel')).toBeVisible();
            await expect(page.locator('#messagesList')).toContainText('Sohbette seni bekliyorum.');
            await expect(page.locator('#mobileUnread')).toBeHidden();

            await other.locator('#messageInput').fill('Görüşme hazır.');
            await other.locator('#messageForm button[type=submit]').click();
            await expect(page.locator('#messagesList')).toContainText('Görüşme hazır.');
            await expect(page.locator('#mobileUnread')).toBeHidden();
            await page.locator('#messageInput').fill('Buradayım.');
            await page.locator('#messageForm button[type=submit]').click();
            await expect(other.locator('#messagesList')).toContainText('Buradayım.');
            await voiceTab.click();
            await expect(page.locator('#mobileUnread')).toBeHidden();
            await other.locator('#messageInput').fill('Bir mesaj daha.');
            await other.locator('#messageForm button[type=submit]').click();
            await expect(page.locator('#mobileUnread')).toHaveText('1');
            await chatTab.focus();
            await page.keyboard.press('Enter');
            await expect(page.locator('#mobileUnread')).toBeHidden();

            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await page.locator('#settingsButton').click();
            const close = page.locator('#settingsClose');
            await expect(page.locator('#settingsOverlay')).toHaveCSS('opacity', '1');
            const before = await close.boundingBox();
            const body = page.locator('.settings-body');
            await body.hover();
            await page.mouse.wheel(0, 3000);
            await expect.poll(() => body.evaluate(element => element.scrollTop)).toBeGreaterThan(50);
            const after = await close.boundingBox();
            expect(after.y).toBeCloseTo(before.y, 0);
            expect(after.x).toBeGreaterThanOrEqual(0);
            expect(after.y).toBeGreaterThanOrEqual(0);
            expect(after.x + after.width).toBeLessThanOrEqual(width);
            expect(after.y + after.height).toBeLessThanOrEqual(740);
            await close.click();
            await expect(page.locator('#settingsOverlay')).toBeHidden();
            await expect(page.locator('#settingsButton')).toBeFocused();
            expect(errors).toEqual([]);
            expect(otherErrors).toEqual([]);
        } finally {
            await otherContext.close();
        }
    });
}
