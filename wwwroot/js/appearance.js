(function () {
    'use strict';
    const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
    const root = document.documentElement;
    const preferences = {
        theme: read('revo_theme', 'midnight') === 'dark' ? 'dark' : 'midnight',
        wallpaper: ['eclipse', 'silk', 'plain'].includes(read('revo_wallpaper', 'eclipse')) ? read('revo_wallpaper', 'eclipse') : 'eclipse',
        animate: read('revo_wallpaper_motion', '1') === '1',
        reduced: read('revo_reduce_motion', matchMedia('(prefers-reduced-motion: reduce)').matches ? '1' : '0') === '1'
    };
    function apply() {
        root.dataset.theme = preferences.theme;
        root.dataset.wallpaper = preferences.wallpaper;
        root.classList.toggle('reduce-motion', preferences.reduced);
        document.querySelectorAll('[data-ambient-scene]').forEach(scene => {
            scene.dataset.ambientScene = preferences.wallpaper === 'eclipse' ? 'eclipse' : 'silk';
            scene.dataset.sceneMotion = preferences.animate && preferences.wallpaper !== 'plain' ? 'on' : 'off';
        });
    }
    window.RevoAppearance = {
        get: () => ({ ...preferences }),
        set(changes) {
            const keys = { theme: 'revo_theme', wallpaper: 'revo_wallpaper', animate: 'revo_wallpaper_motion', reduced: 'revo_reduce_motion' };
            for (const [key, value] of Object.entries(changes)) {
                if (!Object.hasOwn(keys, key)) continue;
                preferences[key] = value;
                try { localStorage.setItem(keys[key], typeof value === 'boolean' ? (value ? '1' : '0') : value); } catch { /* private mode */ }
            }
            apply();
        },
        apply
    };
    apply();
    document.addEventListener('DOMContentLoaded', apply, { once: true });
})();
