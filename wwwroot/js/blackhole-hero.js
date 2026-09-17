/* REVO login black-hole hero — vanilla WebGL port of BlackHoleHeroSection.
   No React, no CDN. Photino / tarayıcı aynı dosyayı yerelden yükler. */
(function (global) {
    "use strict";

    var VERT = [
        "attribute vec2 aPos;",
        "varying vec2 vUv;",
        "void main() {",
        "  vUv = aPos * 0.5 + 0.5;",
        "  gl_Position = vec4(aPos, 0.0, 1.0);",
        "}"
    ].join("\n");

    var SCENE_FRAG = ""; // filled below

    var BLEND_FRAG = [
        "precision highp float;",
        "varying vec2 vUv;",
        "uniform sampler2D uCur;",
        "uniform sampler2D uPrev;",
        "uniform float uAlpha;",
        "void main() {",
        "  vec3 c = texture2D(uCur, vUv).rgb;",
        "  vec3 p = texture2D(uPrev, vUv).rgb;",
        "  gl_FragColor = vec4(mix(p, c, uAlpha), 1.0);",
        "}"
    ].join("\n");

    var BRIGHT_FRAG = [
        "precision highp float;",
        "varying vec2 vUv;",
        "uniform sampler2D uTex;",
        "uniform vec2 uTexel;",
        "uniform float uDecode;",
        "uniform float uPack;",
        "uniform float uThreshold;",
        "void main() {",
        "  vec3 s = texture2D(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb",
        "         + texture2D(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb",
        "         + texture2D(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb",
        "         + texture2D(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;",
        "  s *= 0.25;",
        "  if (uDecode > 0.5) s = s / max(vec3(0.002), 1.0 - s);",
        "  float l = max(s.r, max(s.g, s.b));",
        "  s *= max(0.0, l - uThreshold) / max(0.0001, l);",
        "  gl_FragColor = vec4(s * uPack, 1.0);",
        "}"
    ].join("\n");

    var BLUR_FRAG = [
        "precision highp float;",
        "varying vec2 vUv;",
        "uniform sampler2D uTex;",
        "uniform vec2 uStep;",
        "void main() {",
        "  vec3 s = texture2D(uTex, vUv).rgb * 0.2270270;",
        "  s += (texture2D(uTex, vUv + uStep * 1.3846154).rgb",
        "      + texture2D(uTex, vUv - uStep * 1.3846154).rgb) * 0.3162162;",
        "  s += (texture2D(uTex, vUv + uStep * 3.2307692).rgb",
        "      + texture2D(uTex, vUv - uStep * 3.2307692).rgb) * 0.0702702;",
        "  gl_FragColor = vec4(s, 1.0);",
        "}"
    ].join("\n");

    var COMPOSITE_FRAG = [
        "precision highp float;",
        "varying vec2 vUv;",
        "uniform sampler2D uScene;",
        "uniform sampler2D uBloom;",
        "uniform vec2  uRes;",
        "uniform float uDecode;",
        "uniform float uPack;",
        "uniform float uGlow;",
        "uniform float uExposure;",
        "uniform float uVignette;",
        "uniform float uScrimDir;",
        "uniform float uScrimAmt;",
        "uniform float uSeed;",
        "vec3 aces(vec3 x) {",
        "  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);",
        "}",
        "void main() {",
        "  vec3 scene = texture2D(uScene, vUv).rgb;",
        "  if (uDecode > 0.5) {",
        "    scene = min(scene, vec3(0.98));",
        "    scene = scene / max(vec3(0.002), 1.0 - scene);",
        "  }",
        "  vec3 bloom = texture2D(uBloom, vUv).rgb / uPack;",
        "  vec3 c = scene + bloom * uGlow;",
        "  c = aces(c * uExposure);",
        "  c = pow(max(c, 0.0), vec3(0.4545));",
        "  vec2 d = vUv - 0.5;",
        "  c *= 1.0 - uVignette * dot(d, d) * 1.9;",
        "  if (uScrimDir > 0.5) {",
        "    float x = uScrimDir < 1.5 ? vUv.x",
        "            : uScrimDir < 2.5 ? 1.0 - vUv.x",
        "            : uScrimDir < 3.5 ? 1.0 - vUv.y",
        "            : vUv.y;",
        "    c *= 1.0 - uScrimAmt * pow(1.0 - clamp(x, 0.0, 1.0), 2.4);",
        "  }",
        "  float n = fract(sin(dot(gl_FragCoord.xy + uSeed, vec2(12.9898, 78.233))) * 43758.5453);",
        "  c += (n - 0.5) / 255.0;",
        "  gl_FragColor = vec4(c, 1.0);",
        "}"
    ].join("\n");

    var RAD = Math.PI / 180;
    var HALTON = [
        [0.5, 0.333], [0.25, 0.667], [0.75, 0.111], [0.125, 0.444],
        [0.625, 0.778], [0.375, 0.222], [0.875, 0.556], [0.0625, 0.889]
    ];

    var DEFAULTS = {
        distance: 24,
        elevation: -5.5,
        azimuth: 0,
        orbitSpeed: 0,
        roll: -20,
        fov: 42,
        diskInner: 3,
        diskOuter: 15,
        diskThickness: 0.26,
        diskDensity: 1,
        brightness: 1.14,
        spinSpeed: 0.085,
        grain: 0.34,
        doppler: 0.16,
        hotColor: "#F5F9FC",
        midColor: "#8FB9D6",
        coolColor: "#2C4254",
        starBrightness: 0,
        glow: 0,
        exposure: 1.0,
        vignette: 0.28,
        steps: 52,
        resolution: 0.28,
        maxDpr: 1,
        focus: [0.34, 0.46],
        scrim: "right",
        scrimStrength: 0.82,
        paused: false,
        skipBloom: true
    };

    function hexToLinear(hex) {
        var h = String(hex || "").trim().replace("#", "");
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var n = parseInt(h.slice(0, 6), 16);
        if (isNaN(n)) return [1, 1, 1];
        var srgb = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
        return srgb.map(function (v) {
            return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
    }

    function assign(target, src) {
        Object.keys(src || {}).forEach(function (k) {
            if (src[k] !== undefined) target[k] = src[k];
        });
        return target;
    }

    function mount(host, options) {
        if (!host) return function () {};
        var C = assign(assign({}, DEFAULTS), options || {});
        C.skipBloom = true;
        C.starBrightness = 0;
        C.glow = 0;
        C.resolution = Math.min(0.28, Number(C.resolution) || 0.28);
        C.steps = Math.min(52, Number(C.steps) || 52);
        C.maxDpr = 1;
        var canvas = document.createElement("canvas");
        canvas.className = "hero__hole";
        canvas.setAttribute("aria-hidden", "true");
        host.insertBefore(canvas, host.firstChild);

        var reduced = typeof window.matchMedia === "function"
            && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        var opts = {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: "low-power",
            preserveDrawingBuffer: false,
            desynchronized: true
        };
        var gl = canvas.getContext("webgl2", opts) || canvas.getContext("webgl", opts);
        if (!gl) {
            canvas.style.display = "none";
            return function () {};
        }

        var dbg = gl.getExtension("WEBGL_debug_renderer_info");
        var renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "") : "";
        var software = /swiftshader|llvmpipe|softpipe|software|microsoft basic/i.test(renderer);

        function compile(type, src) {
            var sh = gl.createShader(type);
            if (!sh) return null;
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
                console.error("REVO blackhole shader:", gl.getShaderInfoLog(sh));
                gl.deleteShader(sh);
                return null;
            }
            return sh;
        }

        function link(fragSrc) {
            var vs = compile(gl.VERTEX_SHADER, VERT);
            var fs = compile(gl.FRAGMENT_SHADER, fragSrc);
            if (!vs || !fs) return null;
            var program = gl.createProgram();
            if (!program) return null;
            gl.attachShader(program, vs);
            gl.attachShader(program, fs);
            gl.bindAttribLocation(program, 0, "aPos");
            gl.linkProgram(program);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                console.error(gl.getProgramInfoLog(program));
                return null;
            }
            var u = {};
            var n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            for (var i = 0; i < n; i++) {
                var info = gl.getActiveUniform(program, i);
                if (info) u[info.name] = gl.getUniformLocation(program, info.name);
            }
            return { program: program, u: u };
        }

        var hdr = false;
        var texType = gl.UNSIGNED_BYTE;
        var internal = gl.RGBA;
        var linearOK = true;
        var filter = gl.LINEAR;
        var pack = 0.12;

        function makeTarget(w, h) {
            var tex = gl.createTexture();
            var fb = gl.createFramebuffer();
            if (!tex || !fb) return null;
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, texType, null);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            if (status !== gl.FRAMEBUFFER_COMPLETE) {
                gl.deleteTexture(tex);
                gl.deleteFramebuffer(fb);
                return null;
            }
            return { fb: fb, tex: tex, w: w, h: h };
        }

        var sceneProg, blendProg, brightProg, blurProg, compProg, vbo;
        var scene, histA, histB, bloomA, bloomB;
        var settled = 0;
        var width = 0, height = 0, sceneW = 0, sceneH = 0;

        function dropTargets() {
            [scene, histA, histB, bloomA, bloomB].forEach(function (t) {
                if (!t) return;
                gl.deleteTexture(t.tex);
                gl.deleteFramebuffer(t.fb);
            });
            scene = histA = histB = bloomA = bloomB = null;
            settled = 0;
        }

        function build() {
            sceneProg = link(SCENE_FRAG);
            blendProg = link(BLEND_FRAG);
            compProg = link(COMPOSITE_FRAG);
            if (!C.skipBloom) {
                brightProg = link(BRIGHT_FRAG);
                blurProg = link(BLUR_FRAG);
                if (!brightProg || !blurProg) return false;
            }
            if (!sceneProg || !blendProg || !compProg) return false;
            vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            return true;
        }

        function resize() {
            var rect = host.getBoundingClientRect();
            var dpr = 1;
            var cssW = Math.max(1, Math.round(rect.width));
            var cssH = Math.max(1, Math.round(rect.height));
            var scale = software ? 0.28 : Math.min(1, Math.max(0.28, C.resolution));
            var sw = Math.max(2, Math.round(cssW * dpr * scale));
            var sh = Math.max(2, Math.round(cssH * dpr * scale));
            if (sw === sceneW && sh === sceneH && width === sw && height === sh) return;
            width = sw;
            height = sh;
            sceneW = sw;
            sceneH = sh;
            canvas.width = sw;
            canvas.height = sh;
            canvas.style.width = cssW + "px";
            canvas.style.height = cssH + "px";
            dropTargets();
            scene = makeTarget(sw, sh);
            histA = makeTarget(sw, sh);
            histB = makeTarget(sw, sh);
            if (!C.skipBloom) {
                var bw = Math.max(2, sw >> 2);
                var bh = Math.max(2, sh >> 2);
                bloomA = makeTarget(bw, bh);
                bloomB = makeTarget(bw, bh);
            }
        }

        var clock = reduced ? 6 : 0;
        var lastFrame = 0;
        var running = true;
        var visible = true;
        var raf = 0;
        var hot = hexToLinear(C.hotColor);
        var mid = hexToLinear(C.midColor);
        var cool = hexToLinear(C.coolColor);
        var outer = Math.max(C.diskInner + 0.5, C.diskOuter);
        var az0 = C.azimuth * RAD;
        var el0 = Math.max(-88, Math.min(88, C.elevation)) * RAD;
        var dist = Math.max(2.2, C.distance);
        var ce = Math.cos(el0);
        var camX = dist * ce * Math.cos(az0);
        var camY = dist * Math.sin(el0);
        var camZ = dist * ce * Math.sin(az0);
        var fx = -camX / dist, fy = -camY / dist, fz = -camZ / dist;
        var rx = fz, ry = 0, rz = -fx;
        var rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        var ux = ry * fz - rz * fy;
        var uy = rz * fx - rx * fz;
        var uz = rx * fy - ry * fx;
        var cr = Math.cos(C.roll * RAD);
        var sr = Math.sin(C.roll * RAD);
        var RX = rx * cr + ux * sr, RY = ry * cr + uy * sr, RZ = rz * cr + uz * sr;
        var UX = -rx * sr + ux * cr, UY = -ry * sr + uy * cr, UZ = -rz * sr + uz * cr;
        var tanHalf = Math.tan(Math.max(8, Math.min(110, C.fov)) * 0.5 * RAD);

        function pass(prog, target) {
            gl.useProgram(prog.program);
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
            gl.viewport(0, 0, target ? target.w : width, target ? target.h : height);
        }

        function draw() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

        function bind(tex, unit) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex);
        }

        function render(t) {
            if (!sceneProg || !blendProg || !compProg) return;
            if (!scene || !histA || !histB) return;
            if (!C.skipBloom && (!brightProg || !blurProg || !bloomA || !bloomB)) return;

            pass(sceneProg, scene);
            var u = sceneProg.u;
            gl.uniform2f(u.uRes, scene.w, scene.h);
            gl.uniform1f(u.uTime, t);
            gl.uniform3f(u.uCamPos, camX, camY, camZ);
            gl.uniform3f(u.uRight, RX, RY, RZ);
            gl.uniform3f(u.uUp, UX, UY, UZ);
            gl.uniform3f(u.uFwd, fx, fy, fz);
            gl.uniform1f(u.uTanHalf, tanHalf);
            gl.uniform2f(u.uFocus, C.focus[0], 1 - C.focus[1]);
            gl.uniform1f(u.uSteps, software ? 40 : Math.max(36, Math.min(56, Math.round(C.steps))));
            gl.uniform1f(u.uSkyR, Math.max(dist * 1.35, outer * 2.4));
            gl.uniform1f(u.uDiskIn, Math.max(1.05, C.diskInner));
            gl.uniform1f(u.uDiskOut, outer);
            gl.uniform1f(u.uThick, Math.max(0.02, C.diskThickness));
            gl.uniform1f(u.uDensity, Math.max(0, C.diskDensity));
            gl.uniform1f(u.uSpin, C.spinSpeed * 6.2831853);
            gl.uniform1f(u.uGrain, Math.max(0.02, C.grain));
            gl.uniform1f(u.uBright, Math.max(0, C.brightness));
            gl.uniform1f(u.uDoppler, Math.max(0, Math.min(1, C.doppler)));
            gl.uniform3f(u.uHot, hot[0], hot[1], hot[2]);
            gl.uniform3f(u.uMid, mid[0], mid[1], mid[2]);
            gl.uniform3f(u.uCool, cool[0], cool[1], cool[2]);
            gl.uniform1f(u.uStars, Math.max(0, C.starBrightness));
            gl.uniform1f(u.uEncode, hdr ? 0 : 1);
            if (settled < 6) {
                var hj = HALTON[settled % HALTON.length];
                gl.uniform2f(u.uJitter, hj[0] - 0.5, hj[1] - 0.5);
            } else {
                gl.uniform2f(u.uJitter, 0, 0);
            }
            gl.uniform1f(u.uSeed, (settled % 64) * 17.13);
            draw();

            var alpha = settled === 0 ? 1 : 0.42;
            pass(blendProg, histB);
            bind(scene.tex, 0);
            bind(histA.tex, 1);
            gl.uniform1i(blendProg.u.uCur, 0);
            gl.uniform1i(blendProg.u.uPrev, 1);
            gl.uniform1f(blendProg.u.uAlpha, alpha);
            draw();
            var shown = histB;
            var tmp = histA;
            histA = histB;
            histB = tmp;
            settled++;

            if (!C.skipBloom) {
                pass(brightProg, bloomA);
                bind(shown.tex, 0);
                gl.uniform1i(brightProg.u.uTex, 0);
                gl.uniform2f(brightProg.u.uTexel, 1 / shown.w, 1 / shown.h);
                gl.uniform1f(brightProg.u.uDecode, hdr ? 0 : 1);
                gl.uniform1f(brightProg.u.uPack, pack);
                gl.uniform1f(brightProg.u.uThreshold, 0.85);
                draw();

                function blurStep(src, dst, dx, dy) {
                    pass(blurProg, dst);
                    bind(src.tex, 0);
                    gl.uniform1i(blurProg.u.uTex, 0);
                    gl.uniform2f(blurProg.u.uStep, dx / dst.w, dy / dst.h);
                    draw();
                }
                blurStep(bloomA, bloomB, 1, 0);
                blurStep(bloomB, bloomA, 0, 1);
                blurStep(bloomA, bloomB, 2.6, 0);
                blurStep(bloomB, bloomA, 0, 2.6);
            }

            pass(compProg, null);
            bind(shown.tex, 0);
            bind(C.skipBloom ? shown.tex : bloomA.tex, 1);
            gl.uniform1i(compProg.u.uScene, 0);
            gl.uniform1i(compProg.u.uBloom, 1);
            gl.uniform2f(compProg.u.uRes, width, height);
            gl.uniform1f(compProg.u.uDecode, hdr ? 0 : 1);
            gl.uniform1f(compProg.u.uPack, pack);
            gl.uniform1f(compProg.u.uGlow, C.skipBloom ? 0 : Math.max(0, C.glow) * 0.26);
            gl.uniform1f(compProg.u.uExposure, Math.max(0.05, C.exposure));
            gl.uniform1f(compProg.u.uVignette, Math.max(0, Math.min(1, C.vignette)));
            gl.uniform1f(compProg.u.uScrimDir,
                C.scrim === "left" ? 1 : C.scrim === "right" ? 2 : C.scrim === "top" ? 3 : C.scrim === "bottom" ? 4 : 0);
            gl.uniform1f(compProg.u.uScrimAmt, Math.max(0, Math.min(1, C.scrimStrength)));
            gl.uniform1f(compProg.u.uSeed, (t * 60) % 1000);
            draw();
        }

        function settle(passes) {
            for (var i = 0; i < passes; i++) render(clock);
        }

        function tick(now) {
            if (!running) return;
            raf = requestAnimationFrame(tick);
            if (!visible || document.hidden) { lastFrame = now; return; }
            var dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 0.016;
            lastFrame = now;
            if (!C.paused && !reduced) clock += dt;
            render(clock);
        }

        if (!SCENE_FRAG || !build()) {
            canvas.style.display = "none";
            return function () {};
        }
        resize();
        settle(reduced ? 6 : 4);
        if (!reduced && !software) raf = requestAnimationFrame(tick);

        var ro = typeof ResizeObserver === "function" ? new ResizeObserver(function () {
            resize();
            if (reduced || software) settle(4);
        }) : null;
        if (ro) ro.observe(host);

        var io = typeof IntersectionObserver === "function" ? new IntersectionObserver(function (entries) {
            visible = entries[0] ? entries[0].isIntersecting : true;
        }, { threshold: 0 }) : null;
        if (io) io.observe(host);

        function onVisibility() { visible = !document.hidden; lastFrame = 0; }
        document.addEventListener("visibilitychange", onVisibility);

        function onLost(e) {
            e.preventDefault();
            running = false;
            cancelAnimationFrame(raf);
            canvas.style.display = "none";
        }
        canvas.addEventListener("webglcontextlost", onLost);

        return function destroy() {
            running = false;
            cancelAnimationFrame(raf);
            if (ro) ro.disconnect();
            if (io) io.disconnect();
            document.removeEventListener("visibilitychange", onVisibility);
            canvas.removeEventListener("webglcontextlost", onLost);
            dropTargets();
            if (vbo) gl.deleteBuffer(vbo);
            [sceneProg, blendProg, brightProg, blurProg, compProg].forEach(function (p) {
                if (p) gl.deleteProgram(p.program);
            });
            if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
        };
    }

    global.RevoBlackhole = { mount: mount, _setScene: function (src) { SCENE_FRAG = src; } };
})(window);
