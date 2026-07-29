(function () {
  'use strict';

  console.log('REVO Cursor: Script dosyasi yüklendi.');

  var HOVER_SELECTOR = 'a, button, [role="button"], input, textarea, select, .btn, [data-cursor="hover"]';

  function init() {
    if (document.getElementById('revo-cursor-canvas')) return;

    var canvas = document.createElement('canvas');
    canvas.id = 'revo-cursor-canvas';
    document.body.appendChild(canvas);
    document.body.classList.add('revo-cursor-active');

    console.log('REVO Cursor: Canvas DOM elemanina eklendi.');

    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;

    function cssVar(name, fallback) {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) ? v.trim() : fallback;
    }

    var colorPrimary = cssVar('--revo-cursor-primary', '#22d3ee');
    var colorSecondary = cssVar('--revo-cursor-secondary', '#a78bfa');

    function resize() {
      dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    var mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    var pos = { x: mouse.x, y: mouse.y };
    var lastX = pos.x, lastY = pos.y;
    var trail = [];
    var rings = [];
    var lastRingTime = 0;
    var ringInterval = 1200;
    var hoverRingInterval = 380;
    var hovering = false;

    window.addEventListener('mousemove', function (e) {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    });

    document.addEventListener('mouseleave', function () {
      canvas.style.opacity = '0';
    });

    document.addEventListener('mouseenter', function () {
      canvas.style.opacity = '1';
    });

    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest && e.target.closest(HOVER_SELECTOR);
      hovering = !!el;
    });

    document.addEventListener('mousedown', function () {
      spawnRing(mouse.x, mouse.y, true);
    });

    function spawnRing(x, y, strong) {
      rings.push({
        x: x, y: y,
        r: strong ? 4 : 2,
        maxR: strong ? 74 : 46,
        alpha: strong ? 0.9 : 0.5,
        strong: !!strong
      });
      if (rings.length > 40) rings.shift();
    }

    function loop(t) {
      requestAnimationFrame(loop);

      pos.x += (mouse.x - pos.x) * 0.18;
      pos.y += (mouse.y - pos.y) * 0.18;

      var dx = pos.x - lastX, dy = pos.y - lastY;
      var speed = Math.sqrt(dx * dx + dy * dy);
      lastX = pos.x; lastY = pos.y;

      trail.push({ x: pos.x, y: pos.y });
      if (trail.length > 26) trail.shift();

      var interval = hovering ? hoverRingInterval : ringInterval;
      if (t - lastRingTime > interval) {
        spawnRing(pos.x, pos.y, false);
        lastRingTime = t;
      }

      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      if (trail.length > 1) {
        var angle = Math.atan2(dy, dx) + Math.PI / 2;
        ctx.beginPath();
        for (var i = 0; i < trail.length; i++) {
          var p = trail[i];
          var progress = i / (trail.length - 1);
          var amp = Math.min(speed * 0.4, 14) * (1 - progress);
          var wobble = Math.sin(progress * Math.PI * 3 + t * 0.01) * amp;
          var px = p.x + Math.cos(angle) * wobble;
          var py = p.y + Math.sin(angle) * wobble;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = colorPrimary;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      for (var r = rings.length - 1; r >= 0; r--) {
        var ring = rings[r];
        ring.r += ring.strong ? 2.6 : 1.4;
        ring.alpha *= 0.955;
        if (ring.r >= ring.maxR || ring.alpha < 0.02) {
          rings.splice(r, 1);
          continue;
        }
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
        ctx.strokeStyle = ring.strong ? colorSecondary : colorPrimary;
        ctx.globalAlpha = ring.alpha;
        ctx.lineWidth = ring.strong ? 2 : 1;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      var coreR = hovering ? 7 : 4.5;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, coreR, 0, Math.PI * 2);
      ctx.fillStyle = hovering ? colorSecondary : colorPrimary;
      ctx.shadowColor = hovering ? colorSecondary : colorPrimary;
      ctx.shadowBlur = hovering ? 16 : 10;
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, coreR + 5, 0, Math.PI * 2);
      ctx.strokeStyle = colorPrimary;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    requestAnimationFrame(loop);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();