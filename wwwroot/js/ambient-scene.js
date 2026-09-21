/*
 * REVO ambient artwork. No dependency, no media permissions, no network traffic.
 * Mount: <div data-ambient-scene="silk" aria-hidden="true"></div>
 * The host must be positioned and have a size. "eclipse" adds orbital accents.
 * Call RevoAmbientScene.refresh() after inserting another host dynamically.
 */
(() => {
    'use strict';

    if (window.RevoAmbientScene) return;

    const FRAME_MS = 1000 / 30;
    const TAU = Math.PI * 2;
    const scenes = new Map();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const lifecycle = new AbortController();
    let frame = 0;
    let lastFrame = 0;
    let suspended = false;
    let destroyed = false;

    // Stable composition on every visit, independent of frame rate or device size.
    function seededRandom(seed) {
        return () => {
            seed |= 0;
            seed = seed + 0x6D2B79F5 | 0;
            let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
            value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
            return ((value ^ value >>> 14) >>> 0) / 4294967296;
        };
    }

    function motionAllowed(scene) {
        return !reducedMotion.matches
            && !document.documentElement.classList.contains('reduce-motion')
            && document.documentElement.dataset.sceneMotion !== 'off'
            && scene.host.dataset.sceneMotion !== 'off';
    }

    function canAnimate(scene) {
        return scene.visible && scene.width > 0 && scene.height > 0
            && scene.host.isConnected && scene.isEnabled() && motionAllowed(scene);
    }

    class AmbientScene {
        constructor(host, index) {
            this.host = host;
            this.canvas = document.createElement('canvas');
            this.canvas.className = 'ambient-scene__canvas';
            this.canvas.setAttribute('aria-hidden', 'true');
            this.canvas.setAttribute('role', 'presentation');
            this.context = this.canvas.getContext('2d', { alpha: true });
            this.width = 0;
            this.height = 0;
            this.visible = !('IntersectionObserver' in window);
            this.time = 0;
            this.disposed = false;
            const random = seededRandom(28031 + index * 127);
            this.glints = Array.from({ length: 14 }, () => ({
                x: .28 + random() * .68,
                y: .12 + random() * .72,
                radius: .3 + random() * .65,
                phase: random() * TAU,
                speed: .11 + random() * .12,
                intensity: .12 + random() * .28
            }));

            if (!this.context) return;
            host.append(this.canvas);
            this.resizeObserver = new ResizeObserver(() => {
                this.resize();
                schedule();
            });
            this.resizeObserver.observe(host);
            this.settingsObserver = new MutationObserver(() => {
                this.draw();
                sync();
            });
            this.settingsObserver.observe(host, {
                attributes: true,
                attributeFilter: ['data-scene-motion', 'data-ambient-scene']
            });
            if ('IntersectionObserver' in window) {
                this.intersectionObserver = new IntersectionObserver(entries => {
                    this.visible = entries[0].isIntersecting;
                    this.updateState();
                    sync();
                });
                this.intersectionObserver.observe(host);
            }
            this.resize();
        }

        resize() {
            if (this.disposed) return;
            const width = Math.round(this.host.clientWidth);
            const height = Math.round(this.host.clientHeight);
            if (width === this.width && height === this.height) return;
            this.width = width;
            this.height = height;
            // Keep fill cost bounded even on a 4K monitor. The image remains crisp.
            const pixelLimit = Math.sqrt(1400000 / Math.max(1, width * height));
            const ratio = Math.max(.5, Math.min(window.devicePixelRatio || 1, 1.4, pixelLimit));
            this.canvas.width = Math.max(1, Math.round(width * ratio));
            this.canvas.height = Math.max(1, Math.round(height * ratio));
            this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
            this.draw();
            this.updateState();
        }

        updateState() {
            this.host.dataset.ambientState = !this.isEnabled() ? 'off' : !motionAllowed(this) ? 'still'
                : document.hidden || suspended || !this.visible ? 'paused' : 'running';
        }

        isEnabled() {
            return !['none', 'plain', 'off'].includes(this.host.dataset.ambientScene);
        }

        draw() {
            if (!this.context || !this.width || !this.height || this.disposed) return;
            const context = this.context;
            const width = this.width;
            const height = this.height;
            const time = this.time;
            context.clearRect(0, 0, width, height);
            if (!this.isEnabled()) return;
            context.globalCompositeOperation = 'source-over';

            // A single broad pool of light breathes very slowly behind the filaments.
            const centerX = width * (.7 + Math.sin(time * .085) * .05);
            const centerY = height * (.48 + Math.cos(time * .085) * .05);
            const glow = context.createRadialGradient(centerX, centerY, 0,
                centerX, centerY, Math.max(width * .34, height * .62));
            glow.addColorStop(0, 'rgba(180, 197, 218, .085)');
            glow.addColorStop(.42, 'rgba(118, 146, 175, .025)');
            glow.addColorStop(1, 'rgba(110, 135, 165, 0)');
            context.fillStyle = glow;
            context.fillRect(0, 0, width, height);

            if (this.host.dataset.ambientScene === 'eclipse') this.drawOrbit();
            else this.drawSilk();

            // Sparse film-grain glints: no cursor trails, rapid twinkles, or starfield.
            for (const glint of this.glints) {
                const pulse = .55 + Math.sin(time * glint.speed + glint.phase) * .45;
                const x = width * (glint.x + Math.sin(time * .026 + glint.phase) * .012);
                const y = height * (glint.y + Math.cos(time * .035 + glint.phase) * .018);
                context.beginPath();
                context.arc(x, y, glint.radius, 0, TAU);
                context.fillStyle = `rgba(218, 228, 240, ${glint.intensity * pulse})`;
                context.fill();
            }
        }

        drawSilk() {
            const context = this.context;
            const width = this.width;
            const height = this.height;
            const time = this.time;
            const drift = Math.sin(time * .09) * .055;
            const fold = Math.cos(time * .065) * .07;
            const light = context.createLinearGradient(width * .25, 0, width, height * .8);
            light.addColorStop(0, 'rgba(163, 186, 210, 0)');
            light.addColorStop(.3, 'rgba(167, 191, 217, .09)');
            light.addColorStop(.61, 'rgba(236, 241, 248, .42)');
            light.addColorStop(.77, 'rgba(165, 189, 214, .11)');
            light.addColorStop(1, 'rgba(165, 189, 214, 0)');
            context.strokeStyle = light;

            // Two asymmetric, gently folding ribbons rather than a regular wave grid.
            for (let ribbon = 0; ribbon < 2; ribbon++) {
                const offset = ribbon * .11;
                for (let filament = 0; filament < 9; filament++) {
                    const spread = (filament - 4) * .012;
                    context.globalAlpha = ribbon === 0 ? 1 : .4;
                    context.lineWidth = filament === 4 ? 1.1 : .55;
                    context.beginPath();
                    context.moveTo(width * .12, height * (.85 + spread + offset));
                    context.bezierCurveTo(
                        width * (.38 + drift), height * (.78 + spread * 1.5 + offset),
                        width * (.51 - fold), height * (.08 + spread * .4 + offset),
                        width * (.69 + drift * .5), height * (.34 + spread + offset));
                    context.bezierCurveTo(
                        width * (.9 + fold), height * (.57 + spread * 2 + offset),
                        width * (.93 - drift), height * (.34 + spread * .5 + offset),
                        width * 1.08, height * (.1 + spread + offset));
                    context.stroke();
                }
            }
            context.globalAlpha = 1;
        }

        drawOrbit() {
            const context = this.context;
            const width = this.width;
            const height = this.height;
            const time = this.time;
            context.save();
            context.translate(width * .65, height * .54);
            context.rotate(-.2 + Math.sin(time * .04) * .015);
            const radiusX = width * (.35 + Math.sin(time * .075) * .01);
            const radiusY = height * (.17 + Math.sin(time * .09) * .025);
            const light = context.createLinearGradient(-radiusX, 0, radiusX, 0);
            light.addColorStop(0, 'rgba(192, 214, 235, 0)');
            light.addColorStop(.4, 'rgba(192, 214, 235, .045)');
            light.addColorStop(.73, 'rgba(232, 241, 250, .32)');
            light.addColorStop(1, 'rgba(192, 214, 235, 0)');
            context.strokeStyle = light;
            for (let ring = 0; ring < 6; ring++) {
                context.lineWidth = ring === 0 ? .9 : .5;
                context.globalAlpha = 1 - ring * .13;
                context.beginPath();
                context.ellipse(0, 0, radiusX + ring * 4, radiusY + ring * 2, 0,
                    .06 + Math.sin(time * .035) * .08, Math.PI * .99);
                context.stroke();
            }
            // A soft highlight travels through the lower ring over roughly a minute.
            // Its broad tail gives the image movement without turning it into a spinner.
            const highlight = .16 + (Math.sin(time * .1 - .8) + 1) * 1.24;
            context.lineWidth = 1.4;
            context.strokeStyle = 'rgb(229, 240, 250)';
            for (let tail = 0; tail < 7; tail++) {
                context.globalAlpha = .18 * (1 - tail / 7);
                context.beginPath();
                context.ellipse(0, 0, radiusX, radiusY, 0,
                    highlight - tail * .07, highlight + .055 - tail * .07);
                context.stroke();
            }
            context.restore();
        }

        dispose() {
            this.disposed = true;
            this.resizeObserver?.disconnect();
            this.intersectionObserver?.disconnect();
            this.settingsObserver?.disconnect();
            this.canvas.remove();
            delete this.host.dataset.ambientState;
        }
    }

    function schedule() {
        if (destroyed || suspended || document.hidden || frame) return;
        if ([...scenes.values()].some(canAnimate)) frame = requestAnimationFrame(tick);
    }

    function tick(timestamp) {
        frame = 0;
        if (destroyed || suspended || document.hidden) return;
        if (!lastFrame) lastFrame = timestamp - FRAME_MS;
        const elapsed = timestamp - lastFrame;
        if (elapsed >= FRAME_MS - .1) {
            const step = Math.min(elapsed, 80) / 1000;
            lastFrame = timestamp - elapsed % FRAME_MS;
            for (const [host, scene] of scenes) {
                if (!host.isConnected) {
                    scene.dispose();
                    scenes.delete(host);
                } else if (canAnimate(scene)) {
                    scene.time += step;
                    scene.draw();
                }
            }
        }
        schedule();
    }

    function sync() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        lastFrame = 0;
        for (const [host, scene] of scenes) {
            if (!host.isConnected) {
                scene.dispose();
                scenes.delete(host);
            } else scene.updateState();
        }
        schedule();
    }

    function refresh() {
        if (destroyed) return;
        for (const host of document.querySelectorAll('[data-ambient-scene]')) {
            if (scenes.has(host)) continue;
            const scene = new AmbientScene(host, scenes.size);
            if (scene.context) scenes.set(host, scene);
        }
        sync();
    }

    const preferenceObserver = new MutationObserver(sync);
    preferenceObserver.observe(document.documentElement, {
        attributes: true, attributeFilter: ['class', 'data-scene-motion']
    });
    reducedMotion.addEventListener('change', sync, { signal: lifecycle.signal });
    document.addEventListener('visibilitychange', sync, { signal: lifecycle.signal });
    window.addEventListener('pagehide', event => {
        if (event.persisted) {
            suspended = true;
            sync();
        } else destroy();
    }, { signal: lifecycle.signal });
    window.addEventListener('pageshow', () => {
        suspended = false;
        sync();
    }, { signal: lifecycle.signal });

    function destroy() {
        destroyed = true;
        lifecycle.abort();
        preferenceObserver.disconnect();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        for (const scene of scenes.values()) scene.dispose();
        scenes.clear();
    }

    window.RevoAmbientScene = Object.freeze({ refresh, destroy });
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', refresh, {
            once: true, signal: lifecycle.signal
        });
    } else refresh();
})();
