(function () {
    'use strict';
    const root = document.documentElement;
    const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
    const save = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
    const preferences = {
        theme: ['midnight', 'dark'].includes(read('revo_theme', 'midnight')) ? read('revo_theme', 'midnight') : 'midnight',
        size: Math.min(18, Math.max(12, Number(read('revo_chat_size', '14')) || 14)),
        compact: read('revo_compact_chat', '0') === '1',
        motion: read('revo_reduce_motion', matchMedia('(prefers-reduced-motion: reduce)').matches ? '1' : '0') === '1'
    };
    function apply() {
        root.dataset.theme = preferences.theme;
        root.style.setProperty('--chat-size', preferences.size + 'px');
        root.classList.toggle('compact-chat', preferences.compact);
        root.classList.toggle('reduce-motion', preferences.motion);
        window.RevoAppearance?.set({ theme: preferences.theme, reduced: preferences.motion });
        document.getElementById('chatFontSizeValue').textContent = preferences.size + ' px';
    }
    const fields = [
        ['themeSelect', 'theme', 'revo_theme', false],
        ['chatFontSize', 'size', 'revo_chat_size', false],
        ['compactChatCheck', 'compact', 'revo_compact_chat', true],
        ['reduceMotionCheck', 'motion', 'revo_reduce_motion', true]
    ];
    fields.forEach(([id, property, key, checkbox]) => {
        const field = document.getElementById(id);
        if (checkbox) field.checked = preferences[property]; else field.value = String(preferences[property]);
        field.addEventListener('input', () => {
            preferences[property] = checkbox ? field.checked : property === 'size' ? Number(field.value) : field.value;
            save(key, checkbox ? (field.checked ? '1' : '0') : field.value);
            apply();
        });
    });
    apply();
    const appearance = window.RevoAppearance;
    const wallpapers = [...document.querySelectorAll('input[name="wallpaper"]')];
    wallpapers.forEach(input => {
        input.checked = input.value === appearance.get().wallpaper;
        input.addEventListener('change', () => { if (input.checked) appearance.set({ wallpaper: input.value }); });
    });
    const wallpaperMotion = document.getElementById('wallpaperMotionCheck');
    wallpaperMotion.checked = appearance.get().animate;
    wallpaperMotion.addEventListener('change', () => appearance.set({ animate: wallpaperMotion.checked }));
    const tabs = [...document.querySelectorAll('[data-settings-tab]')];
    const panels = [...document.querySelectorAll('[data-settings-panel]')];
    function select(tab, focus) {
        tabs.forEach(item => {
            const active = item === tab;
            item.classList.toggle('active', active);
            item.setAttribute('aria-selected', String(active));
            item.tabIndex = active ? 0 : -1;
        });
        panels.forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== tab.dataset.settingsTab; });
        document.querySelector('.settings-body').scrollTop = 0;
        if (focus) tab.focus();
    }
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => select(tab, false));
        tab.addEventListener('keydown', event => {
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = tabs.length - 1;
            if (next !== undefined) { event.preventDefault(); select(tabs[next], true); }
        });
    });

    const compactViewport = matchMedia('(max-width: 640px)');
    const room = document.getElementById('roomLayout');
    const paneButtons = [...document.querySelectorAll('[data-room-pane]')];
    const unreadBadge = document.getElementById('mobileUnread');
    const messages = document.getElementById('messagesList');
    let unread = 0;
    function choosePane(pane) {
        room.dataset.mobilePane = pane;
        paneButtons.forEach(button => {
            const selected = button.dataset.roomPane === pane;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        if (pane === 'chat') {
            unread = 0;
            unreadBadge.hidden = true;
            requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
        }
    }
    paneButtons.forEach((button, index) => {
        button.addEventListener('click', () => choosePane(button.dataset.roomPane));
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            const next = paneButtons[(index + 1) % paneButtons.length];
            choosePane(next.dataset.roomPane);
            next.focus();
        });
    });
    document.addEventListener('revo:message', event => {
        if (event.detail.self || !compactViewport.matches || room.dataset.mobilePane === 'chat') return;
        unreadBadge.textContent = String(Math.min(++unread, 99));
        unreadBadge.setAttribute('aria-label', unread + ' okunmamış mesaj');
        unreadBadge.hidden = false;
    });
    compactViewport.addEventListener('change', () => {
        unread = 0;
        unreadBadge.hidden = true;
        if (!compactViewport.matches) requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
    });
    const selfState = document.getElementById('selfChipState');
    const mobileState = document.getElementById('mobileSelfState');
    const syncMobileState = () => {
        mobileState.textContent = ({ listener: 'Dinleyici', preparing: 'Hazırlanıyor', muted: 'Mikrofon kapalı', deafened: 'Kulaklık kapalı', testing: 'Ses testi', ready: 'Mikrofon açık' })[selfState.dataset.state] || 'Hazırlanıyor';
        mobileState.title = selfState.textContent;
        mobileState.dataset.state = selfState.dataset.state || 'ready';
    };
    new MutationObserver(syncMobileState).observe(selfState, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    syncMobileState();
    const overlays = ['settingsOverlay', 'confirmOverlay'].map(id => document.getElementById(id));
    const app = document.querySelector('.app');
    const observer = new MutationObserver(() => { app.inert = overlays.some(overlay => !overlay.hidden); });
    overlays.forEach(overlay => observer.observe(overlay, { attributes: true, attributeFilter: ['hidden'] }));
    document.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const overlay = [...overlays].reverse().find(item => !item.hidden);
        if (!overlay) return;
        const focusable = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(item => item.getClientRects().length > 0 && item.tabIndex >= 0);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
})();
