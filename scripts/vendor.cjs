const { copyFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const source = resolve(root, 'node_modules/@microsoft/signalr');
const target = resolve(root, 'wwwroot/lib/signalr');
mkdirSync(target, { recursive: true });
for (const file of ['signalr.min.js', 'signalr.min.js.map']) {
    copyFileSync(resolve(source, 'dist/browser', file), resolve(target, file));
}
// The npm distribution omits LICENSE.txt; its upstream MIT license is checked in.
console.log('SignalR browser assets copied to wwwroot/lib/signalr.');
