const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 60000,
    expect: { timeout: 15000 },
    fullyParallel: false,
    workers: 1,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: 'http://127.0.0.1:5187',
        browserName: 'chromium',
        viewport: { width: 1440, height: 900 },
        permissions: ['microphone', 'camera'],
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure'
    },
    webServer: {
        command: 'dotnet run --no-launch-profile -- --web --urls http://127.0.0.1:5187',
        url: 'http://127.0.0.1:5187/Chat/Login',
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 }
    }
});
