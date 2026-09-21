(function () {
    'use strict';
    const username = document.getElementById('usernameInput');
    const tabs = [...document.querySelectorAll('.mode-tab')];
    const forms = { public: document.getElementById('publicRoomForm'), join: document.getElementById('joinForm'), create: document.getElementById('createForm') };
    let mode = tabs.find(tab => tab.classList.contains('active'))?.dataset.mode || 'public';
    const read = (store, key) => { try { return store.getItem(key); } catch { return null; } };
    const write = (store, key, value) => { try { if (value) store.setItem(key, value); else store.removeItem(key); } catch { /* private mode */ } };
    function choose(next, focus = false) {
        mode = next;
        tabs.forEach(tab => { const on = tab.dataset.mode === mode; tab.classList.toggle('active', on); tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; });
        Object.entries(forms).forEach(([name, form]) => { form.classList.toggle('active', name === mode); form.hidden = name !== mode; });
        if (focus) tabs.find(tab => tab.dataset.mode === mode).focus();
    }
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => choose(tab.dataset.mode));
        tab.addEventListener('keydown', event => {
            let next;
            if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
            if (event.key === 'Home') next = 0;
            if (event.key === 'End') next = tabs.length - 1;
            if (next !== undefined) { event.preventDefault(); choose(tabs[next].dataset.mode, true); }
        });
    });
    document.querySelectorAll('[data-mode-jump]').forEach(button => button.addEventListener('click', () => { choose(button.dataset.modeJump); username.focus(); }));
    function clear(input) {
        input.removeAttribute('aria-invalid');
        input.closest('.field-group')?.querySelector('.field-note')?.remove();
    }
    function invalid(input, text) {
        clear(input);
        input.setAttribute('aria-invalid', 'true');
        const note = document.createElement('p'); note.className = 'field-note'; note.textContent = text; note.setAttribute('role', 'alert');
        input.closest('.field-group').append(note); input.focus();
    }
    Object.values(forms).forEach(form => form.addEventListener('submit', event => {
        const name = username.value.trim();
        if (!name) { event.preventDefault(); invalid(username, 'Sohbete katılmak için bir isim yaz.'); return; }
        for (const input of form.querySelectorAll('input[required]')) {
            if (!input.value.trim()) { event.preventDefault(); invalid(input, 'Davetindeki oda kodunu gir.'); return; }
        }
        document.querySelectorAll('.js-username-mirror').forEach(input => { input.value = name; });
        write(localStorage, 'revo_username', name);
    }));
    document.querySelectorAll('.field-group input').forEach(input => input.addEventListener('input', () => clear(input)));
    username.value = read(localStorage, 'revo_username') || '';
    username.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); forms[mode].requestSubmit(); } });
    const image = document.getElementById('avatarPreviewImg'), initial = document.getElementById('avatarPreviewInitial'), clearButton = document.getElementById('avatarClearBtn');
    let avatar = read(sessionStorage, 'revoAvatar');
    function renderAvatar() {
        initial.textContent = username.value.trim().charAt(0).toLocaleUpperCase('tr-TR') || 'R';
        initial.hidden = !!avatar; image.hidden = !avatar; clearButton.hidden = !avatar;
        if (avatar) image.src = avatar; else image.removeAttribute('src');
    }
    username.addEventListener('input', renderAvatar);
    document.getElementById('avatarPreviewBtn').addEventListener('click', () => document.getElementById('avatarFileInput').click());
    clearButton.addEventListener('click', () => { avatar = null; write(sessionStorage, 'revoAvatar', null); renderAvatar(); });
    document.getElementById('avatarFileInput').addEventListener('change', async event => {
        const file = event.target.files[0]; if (!file) return;
        const feedback = document.getElementById('avatarFeedback');
        feedback.hidden = true;
        let bitmap;
        try {
            if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 8 * 1024 * 1024) throw new Error('PNG, JPG veya WebP görsel seç; en fazla 8 MB.');
            bitmap = await createImageBitmap(file);
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
            const size = Math.min(bitmap.width, bitmap.height);
            canvas.getContext('2d').drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 96, 96);
            avatar = canvas.toDataURL('image/jpeg', 0.85); write(sessionStorage, 'revoAvatar', avatar); renderAvatar();
        } catch (error) { feedback.hidden = false; feedback.textContent = error.message || 'Görsel açılamadı. Başka bir dosya dene.'; }
        finally { bitmap?.close(); event.target.value = ''; }
    });
    choose(mode); renderAvatar();
    document.getElementById('serverError')?.focus();
})();
