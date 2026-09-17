/* REVO oda istemcisi — SignalR sinyalleşme + WebRTC mesh.
   Betik ES modülü değil: gürültü engelleme dinamik import ile yüklenir,
   başarısız olursa sohbet ham mikrofonla devam eder. */

function revoFatal(label, detail) {
    console.error(label, detail);
    var box = document.getElementById("messagesList");
    if (!box) return;
    var el = document.createElement("div");
    el.className = "message system";
    el.textContent = label + ": " + detail;
    box.classList.add("has-chat");
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
}

window.addEventListener("error", function (e) {
    revoFatal("Betik hatası", (e.message || "bilinmiyor") + " — " + (e.filename || "?") + ":" + (e.lineno || 0));
});

window.addEventListener("unhandledrejection", function (e) {
    revoFatal("İşlenmemiş hata", (e.reason && e.reason.message) || String(e.reason));
});

(function () {
    "use strict";

    const boot = window.REVO_BOOT || {};
    const currentUsername = boot.username || "Misafir";
    let currentRoomCode = boot.roomCode || "";
    let currentRoomName = boot.roomName || currentRoomCode;
    const currentRoomPassword = boot.roomPassword || null;
    const currentAvatarUrl = sessionStorage.getItem("revoAvatar") || null;

    let configuration = {
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        iceCandidatePoolSize: 4,
    };

    const iceServersReady = (async () => {
        try {
            const res = await fetch("/ice/servers", { cache: "no-store" });
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            if (Array.isArray(data.iceServers) && data.iceServers.length) {
                configuration = { ...configuration, iceServers: data.iceServers };
            }
        } catch (err) {
            console.warn("ICE sunucu listesi alınamadı, STUN ile devam ediliyor:", err);
        }
    })();

    const STORE = {
        devices: "revo_devices",
        ptt: "revo_ptt_key",
        micMode: "revo_mic_mode",
        vad: "revo_vad",
        master: "revo_master_vol",
        echo: "revo_echo",
        agc: "revo_agc",
        sfx: "revo_sfx",
    };

    function readStore(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : raw;
        } catch {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try { localStorage.setItem(key, value); } catch { /* gizli tarama */ }
    }

    function readDevices() {
        try { return JSON.parse(readStore(STORE.devices, "{}")) || {}; } catch { return {}; }
    }

    function writeDevices(next) {
        writeStore(STORE.devices, JSON.stringify(next));
    }

    const savedDevices = readDevices();
    let selectedMicId = savedDevices.mic || "";
    let selectedSpeakerId = savedDevices.speaker || "";
    let selectedCamId = savedDevices.camera || "";
    let echoCancellation = readStore(STORE.echo, "1") !== "0";
    let autoGainControl = readStore(STORE.agc, "1") !== "0";
    let soundFxEnabled = readStore(STORE.sfx, "1") !== "0";
    let masterVolume = Math.min(1, Math.max(0, Number(readStore(STORE.master, "1")) || 1));
    let vadThreshold = Math.min(0.4, Math.max(0, Number(readStore(STORE.vad, "0.12")) || 0.12));

    let localStream = null;
    let rawStream = null;
    let cleanStream = null;
    let noiseSuppressionEnabled = true;
    let suppressorCtx = null;
    let rnnoiseNode = null;
    let isMuted = false;
    let isDeafened = false;
    let mutedBeforeDeafen = false;
    let sharedAudioCtx = null;
    let isModerator = false;

    let cameraStream = null;
    let isCameraOn = false;
    let cameraPreviewStream = null;

    let screenStream = null;
    let isScreenSharing = false;

    let micMode = readStore(STORE.micMode, "always") === "ptt" ? "ptt" : "always";
    let pttActive = false;
    let pttKey = readStore(STORE.ptt, "Space") || "Space";
    let vadOpen = true;
    let vadHangoverUntil = 0;
    let selfLevel = 0;

    const participants = new Map();
    const levelMeterTokens = new Map();
    const typingUntil = new Map();
    let lastChat = { user: null, at: 0 };
    let chatPinnedToBottom = true;
    let typingNotifyAt = 0;

    const supportsSinkId = typeof HTMLMediaElement !== "undefined"
        && HTMLMediaElement.prototype
        && typeof HTMLMediaElement.prototype.setSinkId === "function";

    const connection = new signalR.HubConnectionBuilder()
        .withUrl("/chatHub")
        .withAutomaticReconnect()
        .build();

    const roomLayout = document.getElementById("roomLayout");
    const stageEl = document.getElementById("screenShareStage");
    const stageMainEl = document.getElementById("stageMain");
    const stageVideoEl = document.getElementById("screenShareVideo");
    const stageLabelEl = document.getElementById("screenShareLabel");
    const stageStopButton = document.getElementById("stageStopButton");
    const stageFullscreenButton = document.getElementById("stageFullscreenButton");
    const videoGalleryEl = document.getElementById("videoGallery");
    const settingsOverlay = document.getElementById("settingsOverlay");
    const confirmOverlay = document.getElementById("confirmOverlay");
    const userMenuEl = document.getElementById("userMenu");
    const micSelect = document.getElementById("micSelect");
    const speakerSelect = document.getElementById("speakerSelect");
    const camSelect = document.getElementById("camSelect");
    const settingsMicMeter = document.getElementById("settingsMicMeter");
    const settingsCamPreview = document.getElementById("settingsCamPreview");
    const settingsPreviewWrap = document.getElementById("settingsPreviewWrap");
    const toastEl = document.getElementById("toast");
    const masterVolumeSlider = document.getElementById("masterVolume");
    const vadSlider = document.getElementById("vadThreshold");
    const echoCancelCheck = document.getElementById("echoCancelCheck");
    const autoGainCheck = document.getElementById("autoGainCheck");
    const soundFxCheck = document.getElementById("soundFxCheck");

    const ICON = {
        micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M15 5.1V4a3 3 0 0 0-5.8-1"/><path d="M12 19v4"/><path d="M8 23h8"/><path d="M19 10v2a7 7 0 0 1-1.3 4.1"/><path d="M5 10v2a7 7 0 0 0 11 5.2"/><line x1="2" y1="2" x2="22" y2="22"/></svg>',
        deafen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 14v-2a9 9 0 0 1 16.5-5"/><path d="M21 12v2"/><path d="M21 16v2a2 2 0 0 1-2 2h-1v-4"/><path d="M3 16v2a2 2 0 0 0 2 2h1v-6H5"/><line x1="3" y1="3" x2="21" y2="21"/></svg>',
        cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14"/></svg>',
        screen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="20" height="13"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    };

    function setStatus(connected) {
        document.getElementById("statusDot").classList.toggle("connected", connected);
        document.getElementById("statusText").textContent = connected ? "SİNYAL VAR" : "BAĞLANIYOR";
    }

    function buildAvatar(name, avatarUrl) {
        if (avatarUrl) {
            const img = document.createElement("img");
            img.className = "avatar";
            img.src = avatarUrl;
            img.alt = "";
            return img;
        }
        const el = document.createElement("span");
        el.className = "avatar";
        el.textContent = (name || "?").trim().charAt(0).toLocaleUpperCase("tr-TR");
        return el;
    }

    function wrapAvatar(avatar) {
        const wrap = document.createElement("span");
        wrap.className = "avatar-wrap";
        wrap.appendChild(avatar);
        return wrap;
    }

    document.getElementById("selfChip").prepend(buildAvatar(currentUsername, currentAvatarUrl));
    document.getElementById("selfChipName").textContent = currentUsername;

    function persistDevices() {
        writeDevices({ mic: selectedMicId, speaker: selectedSpeakerId, camera: selectedCamId });
    }

    function isTypingInField() {
        const el = document.activeElement;
        if (!el) return false;
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
        return el.isContentEditable;
    }

    function overlayOpen() {
        return !settingsOverlay.hidden || !confirmOverlay.hidden;
    }

    const overlayCloseTimers = new WeakMap();
    let toastTimer = 0;
    let settingsFocusReturn = null;

    function overlayMotionMs() {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 450;
    }

    function setOverlayOpen(el, open) {
        const pending = overlayCloseTimers.get(el);
        if (pending) {
            clearTimeout(pending);
            overlayCloseTimers.delete(el);
        }
        if (open) {
            el.hidden = false;
            void el.offsetWidth;
            el.classList.add("is-open");
            return;
        }
        el.classList.remove("is-open");
        const wait = overlayMotionMs();
        const hide = () => {
            el.hidden = true;
            overlayCloseTimers.delete(el);
        };
        if (wait === 0) {
            hide();
            return;
        }
        overlayCloseTimers.set(el, setTimeout(hide, wait));
    }

    function showToast(text) {
        if (!toastEl) return;
        toastEl.textContent = text;
        toastEl.hidden = false;
        requestAnimationFrame(() => toastEl.classList.add("is-on"));
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.classList.remove("is-on");
            setTimeout(() => { toastEl.hidden = true; }, overlayMotionMs() ? 280 : 0);
        }, 1600);
    }

    async function copyInvite(feedbackEl) {
        const inviteUrl = `${window.location.origin}/Chat/Login?roomCode=${encodeURIComponent(currentRoomCode)}`;
        try {
            await navigator.clipboard.writeText(inviteUrl);
            showToast("Davet kopyalandı");
            if (!feedbackEl) return;
            const original = feedbackEl.dataset.copyLabel || feedbackEl.textContent;
            feedbackEl.dataset.copyLabel = original;
            feedbackEl.textContent = "Kopyalandı";
            clearTimeout(feedbackEl._copyTimer);
            feedbackEl._copyTimer = setTimeout(() => {
                feedbackEl.textContent = original;
            }, 1400);
        } catch (err) {
            console.error("Kopyalama hatası:", err);
            showToast("Kopyalanamadı");
        }
    }

    function markChatHasContent() {
        const list = document.getElementById("messagesList");
        if (list) list.classList.add("has-chat");
    }

    function resetChat() {
        const list = document.getElementById("messagesList");
        list.innerHTML = "";
        list.classList.remove("has-chat");
        const empty = document.createElement("div");
        empty.className = "chat-empty";
        empty.id = "chatEmpty";
        empty.textContent = "Frekans açık. İlk cümleyi sen kur.";
        list.appendChild(empty);
        lastChat = { user: null, at: 0 };
        document.getElementById("jumpLatest").classList.remove("is-visible");
    }

    function syncSelfState() {
        const el = document.getElementById("selfChipState");
        if (!el) return;
        if (isDeafened) el.textContent = "Kulaklık kapalı";
        else if (isMuted) el.textContent = "Mikrofon kapalı";
        else if (isScreenSharing) el.textContent = "Ekran paylaşımı";
        else if (isCameraOn) el.textContent = "Kamera açık";
        else el.textContent = "Hazır";
    }

    function syncPreviewWrap() {
        if (!settingsPreviewWrap) return;
        const stream = settingsCamPreview.srcObject;
        const live = !!(stream && typeof stream.getVideoTracks === "function"
            && stream.getVideoTracks().some((t) => t.readyState === "live"));
        settingsPreviewWrap.classList.toggle("has-stream", live);
    }

    function setRoomChrome(code, name) {
        if (code) currentRoomCode = code;
        if (name) currentRoomName = name;
        const title = currentRoomName || currentRoomCode || "Oda";
        const nameEl = document.getElementById("roomDisplayName");
        if (nameEl) nameEl.textContent = title;
        const codeEl = document.getElementById("roomCodeText");
        if (codeEl) codeEl.textContent = currentRoomCode;
        document.title = "REVO — " + title;
    }

    function ensureSalonInvite() {
        let wrap = document.getElementById("salonInvite");
        if (!wrap) {
            const salon = document.getElementById("salon");
            if (!salon) return;
            wrap = document.createElement("div");
            wrap.className = "salon-invite";
            wrap.id = "salonInvite";
            wrap.hidden = true;
            wrap.innerHTML = '<button type="button" class="salon-invite__btn" id="salonInviteCopy">Daveti kopyala</button>';
            salon.appendChild(wrap);
        }
        const extra = wrap.querySelector(".salon-invite__line");
        if (extra) extra.remove();
    }

    function syncSalonMeta() {
        ensureSalonInvite();
        const n = participants.size + 1;
        const label = n === 1 ? "1 kişi" : n + " kişi";
        const el = document.getElementById("salonTagline");
        if (el) el.textContent = n === 1 ? "Frekans açık" : label;
        const count = document.getElementById("participantCount");
        if (count) count.textContent = label;
        const invite = document.getElementById("salonInvite");
        if (invite) {
            const media = roomLayout && roomLayout.classList.contains("is-media");
            invite.hidden = n !== 1 || media;
        }
    }

    function atmosphereVideo() {
        let vid = document.getElementById("roomAtmosphereVideo");
        const host = document.querySelector(".room-atmosphere");
        if (!vid && host) {
            vid = document.createElement("video");
            vid.id = "roomAtmosphereVideo";
            vid.className = "room-atmosphere__video";
            vid.autoplay = true;
            vid.muted = true;
            vid.loop = true;
            vid.playsInline = true;
            vid.setAttribute("playsinline", "");
            vid.preload = "metadata";
            vid.disablePictureInPicture = true;
            vid.poster = "/media/echoid-poster.png";
            const src = document.createElement("source");
            src.src = "/media/echoid-hero.mp4";
            src.type = "video/mp4";
            vid.appendChild(src);
            host.insertBefore(vid, host.firstChild);
        }
        return vid;
    }

    function playAtmosphere() {
        const vid = atmosphereVideo();
        if (!vid) return;
        const rest = document.hidden || document.body.classList.contains("is-media")
            || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (rest) {
            vid.pause();
            return;
        }
        const play = vid.play();
        if (play && typeof play.catch === "function") play.catch(() => {});
    }

    function syncAtmosphere(mediaOn) {
        document.body.classList.toggle("is-media", mediaOn);
        playAtmosphere();
    }

    atmosphereVideo();
    playAtmosphere();
    document.addEventListener("visibilitychange", playAtmosphere);

    function clockLabel(date) {
        return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
    }

    function playCue(kind) {
        if (!soundFxEnabled || isDeafened) return;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const run = () => {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = kind === "leave" ? 392 : 660;
            const peak = 0.05 * masterVolume;
            g.gain.setValueAtTime(0.0001, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), ctx.currentTime + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
            osc.connect(g).connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.22);
            osc.onended = () => ctx.close().catch(() => {});
        };
        const start = selectedSpeakerId && typeof ctx.setSinkId === "function"
            ? ctx.setSinkId(selectedSpeakerId).catch(() => {}).then(run)
            : Promise.resolve(run());
        start.catch(() => { try { ctx.close(); } catch { /* */ } });
    }

    async function playTestSound() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        try {
            if (selectedSpeakerId && typeof ctx.setSinkId === "function") {
                await ctx.setSinkId(selectedSpeakerId);
            }
        } catch { /* varsayılan çıkış */ }
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        const peak = Math.max(0.0002, 0.07 * masterVolume);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(peak, ctx.currentTime + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
        osc.connect(g).connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.45);
        osc.onended = () => ctx.close().catch(() => {});
    }

    function askConfirm(title, text, okLabel) {
        return new Promise((resolve) => {
            document.getElementById("confirmTitle").textContent = title;
            document.getElementById("confirmText").textContent = text;
            document.getElementById("confirmOk").textContent = okLabel || "Onayla";
            setOverlayOpen(confirmOverlay, true);

            const finish = (value) => {
                setOverlayOpen(confirmOverlay, false);
                document.getElementById("confirmOk").removeEventListener("click", onOk);
                document.getElementById("confirmCancel").removeEventListener("click", onCancel);
                confirmOverlay.removeEventListener("click", onBackdrop);
                resolve(value);
            };
            const onBackdrop = (e) => {
                if (e.target === confirmOverlay) finish(false);
            };
            confirmOverlay.addEventListener("click", onBackdrop);
            const onOk = () => finish(true);
            const onCancel = () => finish(false);
            document.getElementById("confirmOk").addEventListener("click", onOk);
            document.getElementById("confirmCancel").addEventListener("click", onCancel);
        });
    }

    async function showNotice(title, text) {
        const cancel = document.getElementById("confirmCancel");
        cancel.hidden = true;
        try {
            await askConfirm(title, text, "Tamam");
        } finally {
            cancel.hidden = false;
        }
    }

    function messagesNearBottom() {
        const list = document.getElementById("messagesList");
        return list.scrollHeight - list.scrollTop - list.clientHeight < 72;
    }

    function scrollMessagesIfPinned() {
        const list = document.getElementById("messagesList");
        if (chatPinnedToBottom) {
            list.scrollTop = list.scrollHeight;
            document.getElementById("jumpLatest").classList.remove("is-visible");
        } else {
            document.getElementById("jumpLatest").classList.add("is-visible");
        }
    }

    function appendSystemMessage(text) {
        const el = document.createElement("div");
        el.className = "message system";
        el.textContent = text;
        document.getElementById("messagesList").appendChild(el);
        lastChat = { user: null, at: 0 };
        markChatHasContent();
        scrollMessagesIfPinned();
    }

    function mentionIn(text) {
        if (!currentUsername) return false;
        const escaped = currentUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp("(^|[^\\w])@" + escaped + "\\b", "i").test(text)
            || new RegExp("(^|[^\\w])" + escaped + "\\b", "i").test(text);
    }

    function appendChatMessage(user, text, avatarUrl) {
        const now = Date.now();
        const grouped = lastChat.user === user && (now - lastChat.at) < 120000;
        const el = document.createElement("div");
        el.className = "message" + (grouped ? " grouped" : "") + (mentionIn(text) ? " message--mention" : "");

        if (!grouped) {
            el.appendChild(buildAvatar(user, avatarUrl));
            const who = document.createElement("span");
            who.className = "who";
            who.textContent = user;
            el.appendChild(who);
            const when = document.createElement("span");
            when.className = "when";
            when.textContent = clockLabel(new Date());
            el.appendChild(when);
            el.appendChild(document.createElement("br"));
        }

        el.appendChild(document.createTextNode(text));
        document.getElementById("messagesList").appendChild(el);
        lastChat = { user, at: now };
        markChatHasContent();
        scrollMessagesIfPinned();
    }

    function renderTyping() {
        const now = Date.now();
        const names = [];
        for (const [id, until] of typingUntil.entries()) {
            if (until < now) {
                typingUntil.delete(id);
                continue;
            }
            const p = participants.get(id);
            if (p) names.push(p.username);
        }
        const el = document.getElementById("typingIndicator");
        if (!names.length) {
            el.textContent = "";
            return;
        }
        el.textContent = names.length === 1
            ? names[0] + " yazıyor…"
            : names.slice(0, 2).join(", ") + " yazıyor…";
    }

    function getOrCreateParticipant(connectionId, name, avatarUrl) {
        let p = participants.get(connectionId);
        if (!p) {
            p = {
                username: name || "Katılımcı",
                avatarUrl: avatarUrl || null,
                pc: null,
                audioEl: null,
                muted: false,
                deafened: false,
                camera: false,
                screen: false,
                volume: 1,
                localMuted: false,
                cameraStreamId: null,
                screenStreamId: null,
                pendingVideos: [],
            };
            participants.set(connectionId, p);
        } else {
            if (name) p.username = name;
            if (avatarUrl) p.avatarUrl = avatarUrl;
        }
        return p;
    }

    function applyParticipantGain(p) {
        if (!p || !p.audioEl) return;
        p.audioEl.muted = isDeafened || p.localMuted;
        p.audioEl.volume = Math.max(0, Math.min(1, p.volume * masterVolume));
    }

    function applyAllGains() {
        for (const p of participants.values()) applyParticipantGain(p);
    }

    function applyAudioOutput(el) {
        if (!el || !supportsSinkId) return;
        el.setSinkId(selectedSpeakerId || "").catch((err) => {
            console.warn("Çıkış aygıtı uygulanamadı:", err);
        });
    }

    function applyAllOutputs() {
        for (const p of participants.values()) applyAudioOutput(p.audioEl);
    }

    function setParticipantVolume(connectionId, volume) {
        const p = participants.get(connectionId);
        if (!p) return;
        p.volume = volume;
        applyParticipantGain(p);
    }

    function refreshMediaLayout() {
        const hasScreen = !!stageEl.dataset.ownerConnectionId;
        const hasCams = videoGalleryEl.childElementCount > 0;
        roomLayout.classList.toggle("is-media", hasScreen || hasCams);
        roomLayout.classList.toggle("is-sharing", hasScreen);
        roomLayout.classList.toggle("has-cameras", hasCams);
        document.body.classList.toggle("is-sharing", hasScreen);
        syncAtmosphere(hasScreen || hasCams);
        stageMainEl.hidden = !hasScreen;
        if (!hasScreen && hasCams) {
            stageLabelEl.textContent = videoGalleryEl.childElementCount === 1 ? "Kamera" : "Kameralar";
            stageStopButton.hidden = true;
        }
        syncSalonMeta();
    }

    function upsertCameraTile(id, name, stream, isSelf) {
        const tileId = "cam-" + id;
        let tile = document.getElementById(tileId);
        if (!tile) {
            tile = document.createElement("div");
            tile.className = "cam-tile";
            tile.id = tileId;
            const video = document.createElement("video");
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            if (isSelf) video.classList.add("is-self");
            const label = document.createElement("div");
            label.className = "cam-tile__name";
            tile.appendChild(video);
            tile.appendChild(label);
            videoGalleryEl.appendChild(tile);
        }
        const video = tile.querySelector("video");
        if (video.srcObject !== stream) video.srcObject = stream;
        tile.querySelector(".cam-tile__name").textContent = isSelf ? name + " (Sen)" : name;
        refreshMediaLayout();
    }

    function removeCameraTile(id) {
        const tile = document.getElementById("cam-" + id);
        if (!tile) return;
        const video = tile.querySelector("video");
        if (video) video.srcObject = null;
        tile.remove();
        refreshMediaLayout();
    }

    function markCameraSpeaking(connectionId, speaking) {
        const tile = document.getElementById("cam-" + connectionId);
        if (tile && tile.classList.contains("speaking") !== speaking) {
            tile.classList.toggle("speaking", speaking);
        }
    }

    function resolveVideoKind(p, stream, track) {
        const streamId = stream && stream.id;
        if (streamId && p.screenStreamId && streamId === p.screenStreamId) return "screen";
        if (streamId && p.cameraStreamId && streamId === p.cameraStreamId) return "camera";
        if (track && track.contentHint === "detail") return "screen";
        if (track && track.contentHint === "motion") return "camera";
        if (p.screen && !p.camera) return "screen";
        if (p.camera && !p.screen) return "camera";
        return null;
    }

    function attachRemoteVideo(connectionId, stream, track) {
        const p = getOrCreateParticipant(connectionId);
        const kind = resolveVideoKind(p, stream, track);
        if (!kind) {
            p.pendingVideos.push({ stream, track });
            setTimeout(() => flushPendingVideo(connectionId, stream, track), 700);
            return;
        }
        if (kind === "screen") {
            showRemoteScreenShare(connectionId, p.username, stream, track);
        } else {
            p.camera = true;
            upsertCameraTile(connectionId, p.username, stream, false);
            track.addEventListener("ended", () => {
                p.camera = false;
                removeCameraTile(connectionId);
                renderParticipantList();
            });
        }
        renderParticipantList();
    }

    function flushPendingVideo(connectionId, stream, track) {
        const p = participants.get(connectionId);
        if (!p) return;
        const idx = p.pendingVideos.findIndex((x) => x.track === track);
        if (idx === -1) return;
        p.pendingVideos.splice(idx, 1);
        const kind = resolveVideoKind(p, stream, track) || (p.screen ? "screen" : "camera");
        if (kind === "screen") showRemoteScreenShare(connectionId, p.username, stream, track);
        else {
            p.camera = true;
            upsertCameraTile(connectionId, p.username, stream, false);
            track.addEventListener("ended", () => {
                p.camera = false;
                removeCameraTile(connectionId);
                renderParticipantList();
            });
        }
        renderParticipantList();
        refreshMediaLayout();
    }

    function flushAllPending(connectionId) {
        const p = participants.get(connectionId);
        if (!p || !p.pendingVideos.length) return;
        const pending = p.pendingVideos.splice(0);
        pending.forEach(({ stream, track }) => {
            const kind = resolveVideoKind(p, stream, track) || "camera";
            if (kind === "screen") showRemoteScreenShare(connectionId, p.username, stream, track);
            else {
                p.camera = true;
                upsertCameraTile(connectionId, p.username, stream, false);
                track.addEventListener("ended", () => {
                    p.camera = false;
                    removeCameraTile(connectionId);
                    renderParticipantList();
                });
            }
        });
        refreshMediaLayout();
        renderParticipantList();
    }

    function buildParticipantRow(connectionId, name, avatarUrl, isYou, state) {
        const li = document.createElement("li");
        li.className = "participant" + (isYou ? " you" : "") + (state.muted ? " muted" : "");
        li.dataset.connectionId = connectionId;
        if ((speakingUntil.get(connectionId) || 0) > performance.now()) {
            li.classList.add("speaking");
        }

        if (isYou && isModerator) {
            const chip = document.createElement("span");
            chip.className = "mod-chip";
            chip.textContent = "Kurucu";
            li.appendChild(chip);
        }

        li.appendChild(wrapAvatar(buildAvatar(name, avatarUrl)));

        const nameEl = document.createElement("span");
        nameEl.className = "name";
        nameEl.textContent = name;
        li.appendChild(nameEl);

        if (!isYou && state.status && state.status !== "connected") {
            const isTrouble = state.status === "failed" || state.status === "disconnected" || state.status === "closed";
            const badge = document.createElement("span");
            badge.className = "pending";
            badge.textContent = isTrouble ? "bağlantı sorunu" : "bağlanıyor";
            li.appendChild(badge);
        }

        const icons = document.createElement("span");
        icons.className = "state-icons";
        if (state.muted) icons.insertAdjacentHTML("beforeend", ICON.micOff);
        if (state.deafened) icons.insertAdjacentHTML("beforeend", ICON.deafen);
        if (state.camera) icons.insertAdjacentHTML("beforeend", ICON.cam);
        if (state.screen) icons.insertAdjacentHTML("beforeend", ICON.screen);
        li.appendChild(icons);

        const meter = document.createElement("span");
        meter.className = "meter";
        for (let i = 0; i < 3; i++) {
            const bar = document.createElement("span");
            bar.className = "bar";
            meter.appendChild(bar);
        }
        li.appendChild(meter);

        if (!isYou) {
            li.addEventListener("click", (e) => {
                e.stopPropagation();
                openUserMenu(connectionId, e);
            });
        }

        return li;
    }

    function renderParticipantList() {
        const list = document.getElementById("participantList");
        list.innerHTML = "";
        list.appendChild(buildParticipantRow("__self__", currentUsername, currentAvatarUrl, true, {
            muted: isMuted,
            deafened: isDeafened,
            camera: isCameraOn,
            screen: isScreenSharing,
            status: "connected",
        }));

        for (const [connectionId, p] of participants.entries()) {
            const status = p.pc ? p.pc.connectionState : "pending";
            list.appendChild(buildParticipantRow(connectionId, p.username, p.avatarUrl, false, {
                muted: p.muted,
                deafened: p.deafened,
                camera: p.camera,
                screen: p.screen,
                status,
            }));
        }

        document.getElementById("participantCount").textContent = `${participants.size + 1} kişi`;
        syncSalonMeta();
    }

    let userMenuTarget = null;

    function closeUserMenu() {
        userMenuEl.hidden = true;
        userMenuTarget = null;
    }

    function openUserMenu(connectionId, event) {
        const p = participants.get(connectionId);
        if (!p) return;
        userMenuTarget = connectionId;
        document.getElementById("userMenuName").textContent = p.username;
        document.getElementById("userMenuVolume").value = String(Math.round(p.volume * 100));
        document.getElementById("userMenuMute").textContent = p.localMuted ? "Sesi aç" : "Sessize al";
        const kickBtn = document.getElementById("userMenuKick");
        kickBtn.hidden = !isModerator;
        userMenuEl.hidden = false;
        const x = Math.min(event.clientX, window.innerWidth - 240);
        const y = Math.min(event.clientY, window.innerHeight - 180);
        userMenuEl.style.left = x + "px";
        userMenuEl.style.top = y + "px";
    }

    document.getElementById("userMenuVolume").addEventListener("input", () => {
        if (!userMenuTarget) return;
        setParticipantVolume(userMenuTarget, Number(document.getElementById("userMenuVolume").value) / 100);
    });

    document.getElementById("userMenuMute").addEventListener("click", () => {
        if (!userMenuTarget) return;
        const p = participants.get(userMenuTarget);
        if (!p) return;
        p.localMuted = !p.localMuted;
        applyParticipantGain(p);
        document.getElementById("userMenuMute").textContent = p.localMuted ? "Sesi aç" : "Sessize al";
    });

    document.getElementById("userMenuKick").addEventListener("click", async () => {
        if (!userMenuTarget || !isModerator) return;
        const p = participants.get(userMenuTarget);
        if (!p) return;
        const id = userMenuTarget;
        closeUserMenu();
        const ok = await askConfirm("Odadan at", p.username + " kişisini odadan atmak istediğine emin misin?", "At");
        if (ok) {
            connection.invoke("KickUser", id).catch((err) => console.error("Kick hatası:", err));
        }
    });

    document.addEventListener("click", (e) => {
        if (!userMenuEl.hidden && !userMenuEl.contains(e.target)) closeUserMenu();
    });

    const speakingUntil = new Map();
    const meterRows = new Map();

    function applyLevelToRow(connectionId, level) {
        let row = meterRows.get(connectionId);
        if (!row || !row.isConnected) {
            row = document.querySelector(`.participant[data-connection-id="${CSS.escape(connectionId)}"]`);
            if (row) meterRows.set(connectionId, row);
        }
        if (!row) return;
        const bars = row.querySelectorAll(".meter .bar");
        const heights = [4, 8, 14];
        bars.forEach((bar, i) => {
            const active = level > (i + 1) * 0.18;
            const next = active ? `${heights[i]}px` : "3px";
            if (bar.style.height !== next) bar.style.height = next;
        });
        const now = performance.now();
        if (level > 0.12) speakingUntil.set(connectionId, now + 320);
        const speaking = (speakingUntil.get(connectionId) || 0) > now;
        if (row.classList.contains("speaking") !== speaking) {
            row.classList.toggle("speaking", speaking);
        }
        markCameraSpeaking(connectionId, speaking);
    }

    function noteSelfLevel(level) {
        selfLevel = level;
        if (settingsMicMeter) {
            settingsMicMeter.style.width = Math.min(100, Math.round(level * 140)) + "%";
        }
        if (micMode !== "always" || isMuted || !localStream) return;
        if (vadThreshold <= 0) {
            if (!vadOpen) {
                vadOpen = true;
                updateEffectiveMicState();
            }
            return;
        }
        const now = performance.now();
        if (level >= vadThreshold) {
            vadHangoverUntil = now + 280;
            if (!vadOpen) {
                vadOpen = true;
                updateEffectiveMicState();
            }
        } else if (vadOpen && now > vadHangoverUntil) {
            vadOpen = false;
            updateEffectiveMicState();
        }
    }

    function startLevelMeter(stream, connectionId) {
        if (!sharedAudioCtx) {
            sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (sharedAudioCtx.state === "suspended") {
            sharedAudioCtx.resume().catch(() => {});
        }

        const token = {};
        levelMeterTokens.set(connectionId, token);

        const source = sharedAudioCtx.createMediaStreamSource(stream);
        const analyser = sharedAudioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        (function tick() {
            if (levelMeterTokens.get(connectionId) !== token) return;
            requestAnimationFrame(tick);
            if (document.hidden) return;
            analyser.getByteFrequencyData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i];
            const level = Math.min(1, (sum / data.length) / 60);
            applyLevelToRow(connectionId, level);
            if (connectionId === "__self__") noteSelfLevel(level);
        })();
    }

    function addLocalTracksTo(pc) {
        if (localStream) {
            localStream.getTracks().forEach((track) => {
                const sender = pc.addTrack(track, localStream);
                if (track.kind === "audio") tuneAudioSender(sender);
            });
        }
        if (cameraStream) {
            cameraStream.getVideoTracks().forEach((track) => {
                const sender = pc.addTrack(track, cameraStream);
                tuneVideoSender(sender, false);
            });
        }
        if (screenStream) {
            screenStream.getVideoTracks().forEach((track) => {
                const sender = pc.addTrack(track, screenStream);
                tuneVideoSender(sender, true);
            });
        }
    }

    function createPeerConnectionFor(connectionId) {
        const p = getOrCreateParticipant(connectionId);
        if (p.pc) return p.pc;

        const pc = new RTCPeerConnection(configuration);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                connection.invoke("SendICECandidate", connectionId, JSON.stringify(event.candidate))
                    .catch((err) => console.error("ICE gönderim hatası:", err));
            }
        };

        pc.ontrack = (event) => {
            if (event.track.kind === "video") {
                attachRemoteVideo(connectionId, event.streams[0], event.track);
                return;
            }
            if (!p.audioEl) {
                const audioEl = document.createElement("audio");
                audioEl.autoplay = true;
                document.getElementById("remoteAudios").appendChild(audioEl);
                p.audioEl = audioEl;
                applyAudioOutput(audioEl);
            }
            if (p.audioEl.srcObject !== event.streams[0]) {
                p.audioEl.srcObject = event.streams[0];
            }
            applyParticipantGain(p);
            startLevelMeter(event.streams[0], connectionId);
        };

        pc.onconnectionstatechange = () => renderParticipantList();

        addLocalTracksTo(pc);

        p.pc = pc;
        renderParticipantList();
        return pc;
    }

    function tuneAudioSender(sender) {
        if (!sender || typeof sender.getParameters !== "function") return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 48000;
            params.encodings[0].networkPriority = "high";
            params.encodings[0].priority = "high";
            sender.setParameters(params).catch((err) => {
                console.warn("Ses gönderim parametreleri uygulanamadı:", err);
            });
        } catch (err) {
            console.warn("Ses gönderim parametreleri okunamadı:", err);
        }
    }

    function tuneVideoSender(sender, isScreen) {
        if (!sender || typeof sender.getParameters !== "function") return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = isScreen ? 1800000 : 800000;
            sender.setParameters(params).catch(() => {});
        } catch { /* */ }
    }

    function tuneOpusSdp(sdp) {
        if (!sdp) return sdp;
        return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*minptime[^\r\n]*)/g, (match, pt, params) => {
            const wanted = {
                useinbandfec: "1",
                usedtx: "0",
                stereo: "0",
                maxaveragebitrate: "48000",
                maxplaybackrate: "48000",
            };
            const parts = params.split(";").map((s) => s.trim()).filter(Boolean);
            const seen = new Set(parts.map((s) => s.split("=")[0]));
            for (const [key, value] of Object.entries(wanted)) {
                if (!seen.has(key)) parts.push(`${key}=${value}`);
            }
            return `a=fmtp:${pt} ${parts.join(";")}`;
        });
    }

    async function buildCleanStream(sourceStream) {
        const { loadRnnoise, RnnoiseWorkletNode } = await import("/js/noise-suppressor/index.js");

        suppressorCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        await suppressorCtx.audioWorklet.addModule("/js/noise-suppressor/rnnoise/workletProcessor.js");

        const wasmBinary = await loadRnnoise({
            url: "/js/noise-suppressor/rnnoise.wasm",
            simdUrl: "/js/noise-suppressor/rnnoise_simd.wasm",
        });

        const sourceNode = suppressorCtx.createMediaStreamSource(sourceStream);
        rnnoiseNode = new RnnoiseWorkletNode(suppressorCtx, { maxChannels: 1, wasmBinary });
        const destinationNode = suppressorCtx.createMediaStreamDestination();
        sourceNode.connect(rnnoiseNode).connect(destinationNode);

        return destinationNode.stream;
    }

    async function teardownNoisePipeline() {
        if (rnnoiseNode) {
            try { rnnoiseNode.disconnect(); } catch { /* */ }
            try { rnnoiseNode.destroy(); } catch { /* */ }
            rnnoiseNode = null;
        }
        if (suppressorCtx) {
            try { await suppressorCtx.close(); } catch { /* */ }
            suppressorCtx = null;
        }
        cleanStream = null;
    }

    function audioConstraints() {
        const audio = {
            echoCancellation,
            autoGainControl,
            noiseSuppression: false,
        };
        if (selectedMicId) audio.deviceId = { exact: selectedMicId };
        return { audio };
    }

    function updateEffectiveMicState() {
        if (!localStream) return;

        let shouldTransmit;
        if (isMuted) {
            shouldTransmit = false;
        } else if (micMode === "ptt") {
            shouldTransmit = pttActive;
        } else {
            shouldTransmit = vadThreshold <= 0 ? true : vadOpen;
        }

        localStream.getAudioTracks().forEach((track) => { track.enabled = shouldTransmit; });

        const indicator = document.getElementById("txIndicator");
        if (isMuted) {
            indicator.textContent = isDeafened ? "kulaklık kapalı" : "";
            indicator.className = "tx-indicator";
        } else if (micMode === "always") {
            indicator.textContent = vadThreshold > 0 && !shouldTransmit ? "sessizlik" : "";
            indicator.className = "tx-indicator" + (shouldTransmit ? "" : " gated");
        } else {
            indicator.textContent = shouldTransmit ? "aktarılıyor" : "beklemede";
            indicator.className = "tx-indicator" + (shouldTransmit ? " on" : " gated");
        }
    }

    function setMicMode(mode) {
        micMode = mode;
        writeStore(STORE.micMode, mode);
        document.querySelectorAll(".mode-pill").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.mode === mode);
        });
        if (mode === "always") vadOpen = true;
        updateEffectiveMicState();
    }

    async function acquireMicStream() {
        try {
            return await navigator.mediaDevices.getUserMedia(audioConstraints());
        } catch (err) {
            if (selectedMicId) {
                selectedMicId = "";
                persistDevices();
                return await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation, autoGainControl, noiseSuppression: false },
                });
            }
            throw err;
        }
    }

    async function wireLocalAudio(newRaw) {
        if (rawStream && rawStream !== newRaw) {
            rawStream.getTracks().forEach((t) => t.stop());
        }
        await teardownNoisePipeline();
        rawStream = newRaw;

        const nsButton = document.getElementById("noiseSuppressionButton");
        try {
            cleanStream = await buildCleanStream(rawStream);
            localStream = noiseSuppressionEnabled ? cleanStream : rawStream;
            nsButton.disabled = false;
            nsButton.setAttribute("aria-pressed", String(noiseSuppressionEnabled));
        } catch (err) {
            console.error("Gürültü engelleme başlatılamadı, ham mikrofon kullanılacak:", err);
            localStream = rawStream;
            noiseSuppressionEnabled = false;
            nsButton.disabled = true;
            nsButton.title = "Gürültü engelleme bu tarayıcıda kullanılamıyor";
        }

        startLevelMeter(localStream, "__self__");
        updateEffectiveMicState();
        return localStream;
    }

    async function replaceAudioTrackEverywhere() {
        const newTrack = localStream && localStream.getAudioTracks()[0];
        if (!newTrack) return;
        for (const p of participants.values()) {
            if (!p.pc) continue;
            const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === "audio");
            if (sender) {
                try { await sender.replaceTrack(newTrack); }
                catch (err) { console.error("Ses track'i değiştirilemedi:", err); }
            }
        }
        updateEffectiveMicState();
    }

    async function ensureLocalStream() {
        if (localStream) return localStream;
        const stream = await acquireMicStream();
        await wireLocalAudio(stream);
        await refreshDeviceLists();
        return localStream;
    }

    async function switchAudioInput(deviceId) {
        selectedMicId = deviceId || "";
        persistDevices();
        const stream = await acquireMicStream();
        await wireLocalAudio(stream);
        await replaceAudioTrackEverywhere();
        await refreshDeviceLists();
    }

    async function toggleNoiseSuppression() {
        if (!cleanStream) return;

        noiseSuppressionEnabled = !noiseSuppressionEnabled;
        const targetStream = noiseSuppressionEnabled ? cleanStream : rawStream;
        localStream = targetStream;
        await replaceAudioTrackEverywhere();

        const btn = document.getElementById("noiseSuppressionButton");
        btn.setAttribute("aria-pressed", String(noiseSuppressionEnabled));
        btn.setAttribute("aria-label", noiseSuppressionEnabled ? "Gürültü engellemeyi kapat" : "Gürültü engellemeyi aç");
    }

    function fillSelect(select, devices, selected, fallbackLabel) {
        const current = selected || "";
        select.innerHTML = "";
        const def = document.createElement("option");
        def.value = "";
        def.textContent = fallbackLabel;
        select.appendChild(def);
        devices.forEach((d, i) => {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || ("Aygıt " + (i + 1));
            select.appendChild(opt);
        });
        if (current && [...select.options].some((o) => o.value === current)) {
            select.value = current;
        } else {
            select.value = "";
        }
    }

    async function refreshDeviceLists() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        let devices = [];
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch (err) {
            console.warn("Aygıt listesi alınamadı:", err);
            return;
        }
        fillSelect(micSelect, devices.filter((d) => d.kind === "audioinput"), selectedMicId, "Sistem varsayılanı");
        fillSelect(speakerSelect, devices.filter((d) => d.kind === "audiooutput"), selectedSpeakerId, "Sistem varsayılanı");
        fillSelect(camSelect, devices.filter((d) => d.kind === "videoinput"), selectedCamId, "Sistem varsayılanı");
        speakerSelect.disabled = !supportsSinkId;
        document.getElementById("testSpeakerBtn").disabled = !supportsSinkId;
        if (!supportsSinkId) {
            speakerSelect.title = "Bu tarayıcı hoparlör seçimini desteklemiyor";
        }
    }

    async function stopCameraPreview() {
        if (cameraPreviewStream && cameraPreviewStream !== cameraStream) {
            cameraPreviewStream.getTracks().forEach((t) => t.stop());
        }
        cameraPreviewStream = null;
        if (!isCameraOn) settingsCamPreview.srcObject = null;
        syncPreviewWrap();
    }

    async function startCameraPreview() {
        if (isCameraOn && cameraStream) {
            settingsCamPreview.srcObject = cameraStream;
            syncPreviewWrap();
            return;
        }
        try {
            const video = { width: { ideal: 640 }, height: { ideal: 360 } };
            if (selectedCamId) video.deviceId = { exact: selectedCamId };
            const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
            if (cameraPreviewStream && cameraPreviewStream !== cameraStream) {
                cameraPreviewStream.getTracks().forEach((t) => t.stop());
            }
            cameraPreviewStream = stream;
            settingsCamPreview.srcObject = stream;
            syncPreviewWrap();
        } catch (err) {
            console.warn("Kamera önizlemesi açılamadı:", err);
            syncPreviewWrap();
        }
    }

    async function openSettings() {
        settingsFocusReturn = document.activeElement;
        masterVolumeSlider.value = String(Math.round(masterVolume * 100));
        vadSlider.value = String(Math.round(vadThreshold * 100));
        echoCancelCheck.checked = echoCancellation;
        autoGainCheck.checked = autoGainControl;
        soundFxCheck.checked = soundFxEnabled;
        setOverlayOpen(settingsOverlay, true);
        try { await ensureLocalStream(); } catch { /* izin yoksa liste boş kalır */ }
        await refreshDeviceLists();
        await startCameraPreview();
        setTimeout(() => { try { micSelect.focus(); } catch { /* */ } }, 40);
    }

    async function closeSettings() {
        setOverlayOpen(settingsOverlay, false);
        await stopCameraPreview();
        const back = settingsFocusReturn;
        settingsFocusReturn = null;
        if (back && typeof back.focus === "function") {
            setTimeout(() => back.focus(), overlayMotionMs());
        }
    }

    function videoConstraints(idealWidth, idealHeight) {
        const video = {
            width: { ideal: idealWidth },
            height: { ideal: idealHeight },
            frameRate: { ideal: 60 },
        };
        if (selectedCamId) video.deviceId = { exact: selectedCamId };
        return { video, audio: false };
    }

    async function acquireCameraStream() {
        try {
            return await navigator.mediaDevices.getUserMedia(videoConstraints(1280, 720));
        } catch (err) {
            if (selectedCamId) {
                selectedCamId = "";
                persistDevices();
                return await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
                    audio: false,
                });
            }
            throw err;
        }
    }

    async function renegotiateAll() {
        for (const [connectionId, p] of participants.entries()) {
            if (!p.pc) continue;
            try {
                const offer = await p.pc.createOffer();
                offer.sdp = tuneOpusSdp(offer.sdp);
                await p.pc.setLocalDescription(offer);
                await connection.invoke("SendOffer", connectionId, JSON.stringify(offer));
            } catch (err) {
                console.error(`Yeniden pazarlık hatası (${connectionId}):`, err);
            }
        }
    }

    async function startCamera() {
        cameraStream = await acquireCameraStream();
        const track = cameraStream.getVideoTracks()[0];
        track.contentHint = "motion";
        track.addEventListener("ended", () => { if (isCameraOn) stopCamera(); });

        await connection.invoke("AnnounceMedia", "camera", cameraStream.id).catch(() => {});
        await connection.invoke("ToggleCamera", true).catch(() => {});

        for (const p of participants.values()) {
            if (!p.pc) continue;
            const sender = p.pc.addTrack(track, cameraStream);
            tuneVideoSender(sender, false);
        }
        await renegotiateAll();

        isCameraOn = true;
        upsertCameraTile("__self__", currentUsername, cameraStream, true);
        settingsCamPreview.srcObject = cameraStream;
        syncPreviewWrap();
        const btn = document.getElementById("cameraButton");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Kamerayı kapat");
        syncSelfState();
        renderParticipantList();
        await refreshDeviceLists();
    }

    async function stopCamera() {
        if (!cameraStream) return;
        const track = cameraStream.getVideoTracks()[0];
        for (const p of participants.values()) {
            if (!p.pc) continue;
            const sender = p.pc.getSenders().find((s) => s.track === track);
            if (sender) p.pc.removeTrack(sender);
        }
        cameraStream.getTracks().forEach((t) => t.stop());
        cameraStream = null;
        isCameraOn = false;
        removeCameraTile("__self__");
        await connection.invoke("ToggleCamera", false).catch(() => {});
        await renegotiateAll();
        const btn = document.getElementById("cameraButton");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Kamerayı aç");
        syncSelfState();
        renderParticipantList();
        if (!settingsOverlay.hidden) await startCameraPreview();
        else syncPreviewWrap();
    }

    async function toggleCamera() {
        try {
            if (isCameraOn) await stopCamera();
            else await startCamera();
        } catch (err) {
            if (err.name !== "NotAllowedError") {
                console.error("Kamera hatası:", err);
                appendSystemMessage("Kamera açılamadı.");
            }
        }
    }

    async function switchCameraDevice(deviceId) {
        selectedCamId = deviceId || "";
        persistDevices();
        if (isCameraOn) {
            const oldTrack = cameraStream.getVideoTracks()[0];
            const next = await acquireCameraStream();
            const newTrack = next.getVideoTracks()[0];
            newTrack.contentHint = "motion";
            newTrack.addEventListener("ended", () => { if (isCameraOn) stopCamera(); });
            for (const p of participants.values()) {
                if (!p.pc) continue;
                const sender = p.pc.getSenders().find((s) => s.track === oldTrack);
                if (sender) {
                    try { await sender.replaceTrack(newTrack); }
                    catch (err) { console.error("Kamera track'i değiştirilemedi:", err); }
                }
            }
            oldTrack.stop();
            cameraStream = next;
            upsertCameraTile("__self__", currentUsername, cameraStream, true);
            settingsCamPreview.srcObject = cameraStream;
            syncPreviewWrap();
            await connection.invoke("AnnounceMedia", "camera", cameraStream.id).catch(() => {});
        } else if (!settingsOverlay.hidden) {
            await startCameraPreview();
        }
        await refreshDeviceLists();
    }

    function openScreenShareStage(ownerId, labelText, stream, isSelf) {
        stageVideoEl.srcObject = stream;
        stageEl.dataset.ownerConnectionId = ownerId;
        stageLabelEl.textContent = labelText;
        stageStopButton.hidden = !isSelf;
        refreshMediaLayout();
    }

    function clearScreenShareStage() {
        exitStageFullscreen();
        stageVideoEl.srcObject = null;
        delete stageEl.dataset.ownerConnectionId;
        stageStopButton.hidden = true;
        refreshMediaLayout();
    }

    function showRemoteScreenShare(connectionId, username, stream, track) {
        const p = participants.get(connectionId);
        if (p) p.screen = true;
        openScreenShareStage(connectionId, `${username} ekranını paylaşıyor`, stream, false);
        renderParticipantList();
        track.addEventListener("ended", () => {
            if (stageEl.dataset.ownerConnectionId === connectionId) {
                clearScreenShareStage();
            }
            if (p) {
                p.screen = false;
                renderParticipantList();
            }
        });
    }

    function hideRemoteScreenShareIfFrom(connectionId) {
        if (stageEl.dataset.ownerConnectionId === connectionId) {
            clearScreenShareStage();
        }
        const p = participants.get(connectionId);
        if (p) p.screen = false;
    }

    let stageIdleTimer = null;

    function stageIsFullscreen() {
        return document.fullscreenElement === stageEl || stageEl.classList.contains("is-faux-fullscreen");
    }

    function syncFullscreenUi() {
        const on = stageIsFullscreen();
        stageFullscreenButton.setAttribute("aria-label", on ? "Tam ekrandan çık" : "Tam ekran");
        stageFullscreenButton.title = on ? "Tam ekrandan çık (Esc)" : "Tam ekran";
        if (!on) {
            stageEl.classList.remove("is-idle");
            clearTimeout(stageIdleTimer);
        } else {
            armStageIdleTimer();
        }
    }

    function armStageIdleTimer() {
        clearTimeout(stageIdleTimer);
        stageEl.classList.remove("is-idle");
        if (!stageIsFullscreen()) return;
        stageIdleTimer = setTimeout(() => stageEl.classList.add("is-idle"), 2500);
    }

    async function enterStageFullscreen() {
        if (!roomLayout.classList.contains("is-media")) return;
        if (stageEl.requestFullscreen) {
            try {
                await stageEl.requestFullscreen({ navigationUI: "hide" });
                syncFullscreenUi();
                return;
            } catch (err) {
                console.warn("Fullscreen API reddedildi, kendi tam ekranımıza düşülüyor:", err);
            }
        }
        stageEl.classList.add("is-faux-fullscreen");
        syncFullscreenUi();
    }

    function exitStageFullscreen() {
        if (document.fullscreenElement === stageEl) {
            document.exitFullscreen().catch(() => {});
        }
        stageEl.classList.remove("is-faux-fullscreen");
        syncFullscreenUi();
    }

    function toggleStageFullscreen() {
        if (stageIsFullscreen()) exitStageFullscreen();
        else enterStageFullscreen();
    }

    stageFullscreenButton.addEventListener("click", toggleStageFullscreen);
    stageVideoEl.addEventListener("dblclick", toggleStageFullscreen);
    stageStopButton.addEventListener("click", () => { toggleScreenShare(); });
    stageEl.addEventListener("mousemove", armStageIdleTimer);
    document.addEventListener("fullscreenchange", syncFullscreenUi);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && stageEl.classList.contains("is-faux-fullscreen")) {
            exitStageFullscreen();
        }
    });

    async function startScreenShare() {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = screenStream.getVideoTracks()[0];
        track.contentHint = "detail";

        await connection.invoke("AnnounceMedia", "screen", screenStream.id).catch(() => {});
        await connection.invoke("ToggleScreenShare", true).catch(() => {});

        for (const p of participants.values()) {
            if (!p.pc) continue;
            const sender = p.pc.addTrack(track, screenStream);
            tuneVideoSender(sender, true);
        }
        await renegotiateAll();

        track.addEventListener("ended", () => stopScreenShare());
        openScreenShareStage("self", "Ekranını paylaşıyorsun", screenStream, true);

        isScreenSharing = true;
        const btn = document.getElementById("screenShareButton");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Ekran paylaşımını durdur");
        syncSelfState();
        renderParticipantList();
    }

    async function stopScreenShare() {
        if (!screenStream) return;
        const track = screenStream.getVideoTracks()[0];

        for (const p of participants.values()) {
            if (!p.pc) continue;
            const sender = p.pc.getSenders().find((s) => s.track === track);
            if (sender) p.pc.removeTrack(sender);
        }
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;

        if (stageEl.dataset.ownerConnectionId === "self") {
            clearScreenShareStage();
        }

        await connection.invoke("ToggleScreenShare", false).catch(() => {});
        await renegotiateAll();

        isScreenSharing = false;
        const btn = document.getElementById("screenShareButton");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Ekranını paylaş");
        syncSelfState();
        renderParticipantList();
    }

    async function toggleScreenShare() {
        try {
            if (isScreenSharing) await stopScreenShare();
            else await startScreenShare();
        } catch (err) {
            if (err.name !== "NotAllowedError") {
                console.error("Ekran paylaşımı hatası:", err);
            }
        }
    }

    async function callUser(connectionId) {
        const pc = createPeerConnectionFor(connectionId);
        const offer = await pc.createOffer();
        offer.sdp = tuneOpusSdp(offer.sdp);
        await pc.setLocalDescription(offer);
        await connection.invoke("SendOffer", connectionId, JSON.stringify(offer));
    }

    function teardownParticipant(connectionId) {
        const p = participants.get(connectionId);
        if (!p) return;
        if (p.pc) {
            hideRemoteScreenShareIfFrom(connectionId);
            p.pc.close();
        }
        if (p.audioEl) p.audioEl.remove();
        removeCameraTile(connectionId);
        levelMeterTokens.delete(connectionId);
        meterRows.delete(connectionId);
        typingUntil.delete(connectionId);
        participants.delete(connectionId);
    }

    async function announceLocalMedia() {
        if (isMuted) connection.invoke("ToggleMute", true).catch(() => {});
        if (isDeafened) connection.invoke("ToggleDeafen", true).catch(() => {});
        if (isCameraOn && cameraStream) {
            await connection.invoke("AnnounceMedia", "camera", cameraStream.id).catch(() => {});
            await connection.invoke("ToggleCamera", true).catch(() => {});
        }
        if (isScreenSharing && screenStream) {
            await connection.invoke("AnnounceMedia", "screen", screenStream.id).catch(() => {});
            await connection.invoke("ToggleScreenShare", true).catch(() => {});
        }
    }

    function syncMuteButton() {
        const btn = document.getElementById("muteButton");
        btn.setAttribute("aria-pressed", String(isMuted));
        btn.setAttribute("aria-label", isMuted ? "Mikrofonu aç" : "Mikrofonu kapat");
        const deafenBtn = document.getElementById("deafenButton");
        deafenBtn.setAttribute("aria-pressed", String(isDeafened));
        deafenBtn.setAttribute("aria-label", isDeafened ? "Kulaklığı aç" : "Kulaklığı kapat");
        syncSelfState();
    }

    async function setMuted(next, fromDeafen) {
        try {
            await ensureLocalStream();
        } catch {
            appendSystemMessage("Mikrofona erişim izni vermelisin.");
            return;
        }
        isMuted = next;
        updateEffectiveMicState();
        syncMuteButton();
        connection.invoke("ToggleMute", isMuted).catch((err) => console.error("Mute bildirim hatası:", err));
        renderParticipantList();
        if (!fromDeafen) { /* */ }
    }

    async function setDeafened(next) {
        if (next) {
            mutedBeforeDeafen = isMuted;
            isDeafened = true;
            await setMuted(true, true);
        } else {
            isDeafened = false;
            await setMuted(mutedBeforeDeafen, true);
        }
        applyAllGains();
        connection.invoke("ToggleDeafen", isDeafened).catch((err) => console.error("Deafen bildirim hatası:", err));
        updateEffectiveMicState();
        syncMuteButton();
        renderParticipantList();
    }

    connection.on("JoinedRoom", (roomCode, moderator) => {
        isModerator = moderator;
        renderParticipantList();
    });

    connection.on("JoinError", async (reason) => {
        await showNotice("Odaya girilemedi", reason || "Odaya katılamadın.");
        window.location.href = `/Chat/Login?roomCode=${encodeURIComponent(currentRoomCode)}`;
    });

    connection.on("KickedFromRoom", async () => {
        await showNotice("Odadan çıkarıldın", "Bu odanın kurucusu seni çıkardı.");
        window.location.href = "/Chat/Login";
    });

    connection.on("ExistingUsers", async (users) => {
        try {
            await ensureLocalStream();
        } catch (err) {
            console.error("Mikrofon erişim hatası:", err);
            appendSystemMessage("Odaya sesli katılmak için mikrofon erişimine izin vermelisin.");
            return;
        }
        for (const u of users) {
            const p = getOrCreateParticipant(u.connectionId, u.username, u.avatarUrl);
            p.muted = !!u.muted;
            p.deafened = !!u.deafened;
            p.camera = !!u.camera;
            p.screen = !!u.screen;
            p.cameraStreamId = u.cameraStreamId || null;
            p.screenStreamId = u.screenStreamId || null;
            await callUser(u.connectionId);
        }
        renderParticipantList();
    });

    connection.on("UserJoined", (connectionId, name, avatarUrl) => {
        getOrCreateParticipant(connectionId, name, avatarUrl);
        renderParticipantList();
        appendSystemMessage(`${name} odaya katıldı.`);
        playCue("join");
    });

    connection.on("ReceiveOffer", async (senderConnectionId, offerStr) => {
        try {
            await ensureLocalStream();
        } catch (err) {
            console.error("Mikrofon erişim hatası:", err);
            appendSystemMessage("Odaya sesli katılmak için mikrofon erişimine izin vermelisin.");
            return;
        }
        const offer = JSON.parse(offerStr);
        const pc = createPeerConnectionFor(senderConnectionId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        answer.sdp = tuneOpusSdp(answer.sdp);
        await pc.setLocalDescription(answer);
        await connection.invoke("SendAnswer", senderConnectionId, JSON.stringify(answer));
    });

    connection.on("ReceiveAnswer", async (senderConnectionId, answerStr) => {
        const p = participants.get(senderConnectionId);
        if (!p || !p.pc) return;
        await p.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr)));
    });

    connection.on("ReceiveICECandidate", async (senderConnectionId, candidateStr) => {
        const p = participants.get(senderConnectionId);
        if (!p || !p.pc) return;
        try {
            await p.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateStr)));
        } catch (e) {
            console.error("ICE ekleme hatası:", e);
        }
    });

    connection.on("UserMuteChanged", (connectionId, muted) => {
        const p = participants.get(connectionId);
        if (p) {
            p.muted = muted;
            renderParticipantList();
        }
    });

    connection.on("UserDeafenChanged", (connectionId, deafened) => {
        const p = participants.get(connectionId);
        if (p) {
            p.deafened = deafened;
            if (deafened) p.muted = true;
            renderParticipantList();
        }
    });

    connection.on("UserCameraChanged", (connectionId, on) => {
        const p = participants.get(connectionId);
        if (!p) return;
        p.camera = on;
        if (!on) {
            p.cameraStreamId = null;
            removeCameraTile(connectionId);
        }
        renderParticipantList();
    });

    connection.on("UserScreenShareChanged", (connectionId, on) => {
        const p = participants.get(connectionId);
        if (!p) return;
        p.screen = on;
        if (!on) hideRemoteScreenShareIfFrom(connectionId);
        renderParticipantList();
    });

    connection.on("UserMediaAnnounced", (connectionId, kind, streamId) => {
        const p = getOrCreateParticipant(connectionId);
        if (kind === "camera") {
            p.camera = true;
            p.cameraStreamId = streamId;
        } else if (kind === "screen") {
            p.screen = true;
            p.screenStreamId = streamId;
        }
        flushAllPending(connectionId);
        renderParticipantList();
    });

    connection.on("UserTyping", (connectionId) => {
        typingUntil.set(connectionId, Date.now() + 3200);
        renderTyping();
    });

    connection.on("UserLeft", (connectionId, name) => {
        teardownParticipant(connectionId);
        renderParticipantList();
        renderTyping();
        appendSystemMessage(`${name} odadan ayrıldı.`);
        playCue("leave");
    });

    connection.on("ReceiveMessage", (senderConnectionId, user, message) => {
        const isSelf = senderConnectionId === connection.connectionId;
        const avatarUrl = isSelf ? currentAvatarUrl : (participants.get(senderConnectionId)?.avatarUrl || null);
        const pinned = chatPinnedToBottom;
        appendChatMessage(user, message, avatarUrl);
        if (!isSelf && !pinned && mentionIn(message)) {
            document.getElementById("jumpLatest").classList.add("is-visible");
        }
    });

    document.getElementById("messagesList").addEventListener("scroll", () => {
        chatPinnedToBottom = messagesNearBottom();
        if (chatPinnedToBottom) {
            document.getElementById("jumpLatest").classList.remove("is-visible");
        }
    });

    document.getElementById("jumpLatest").addEventListener("click", () => {
        chatPinnedToBottom = true;
        const list = document.getElementById("messagesList");
        list.scrollTop = list.scrollHeight;
        document.getElementById("jumpLatest").classList.remove("is-visible");
    });

    document.getElementById("messageForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const input = document.getElementById("messageInput");
        const message = input.value.trim();
        if (!message) return;
        connection.invoke("SendMessage", message).catch((err) => console.error("Mesaj gönderim hatası:", err));
        input.value = "";
    });

    document.getElementById("messageInput").addEventListener("input", () => {
        const now = Date.now();
        if (now - typingNotifyAt < 1800) return;
        typingNotifyAt = now;
        connection.invoke("Typing").catch(() => {});
    });

    document.getElementById("muteButton").addEventListener("click", () => {
        if (isDeafened) {
            mutedBeforeDeafen = false;
            setDeafened(false);
            return;
        }
        setMuted(!isMuted, false);
    });

    document.getElementById("deafenButton").addEventListener("click", () => {
        setDeafened(!isDeafened);
    });

    document.getElementById("noiseSuppressionButton").addEventListener("click", () => {
        toggleNoiseSuppression().catch((err) => console.error("Gürültü engelleme değiştirme hatası:", err));
    });

    document.getElementById("screenShareButton").addEventListener("click", () => {
        toggleScreenShare();
    });

    document.getElementById("cameraButton").addEventListener("click", () => {
        toggleCamera();
    });

    document.getElementById("settingsButton").addEventListener("click", () => openSettings());
    document.getElementById("settingsClose").addEventListener("click", () => closeSettings());
    settingsOverlay.addEventListener("click", (e) => {
        if (e.target === settingsOverlay) closeSettings();
    });

    micSelect.addEventListener("change", () => {
        switchAudioInput(micSelect.value).catch((err) => {
            console.error("Mikrofon değiştirilemedi:", err);
            appendSystemMessage("Mikrofon değiştirilemedi.");
        });
    });

    speakerSelect.addEventListener("change", () => {
        selectedSpeakerId = speakerSelect.value || "";
        persistDevices();
        applyAllOutputs();
    });

    camSelect.addEventListener("change", () => {
        switchCameraDevice(camSelect.value).catch((err) => {
            console.error("Kamera değiştirilemedi:", err);
            appendSystemMessage("Kamera değiştirilemedi.");
        });
    });

    document.getElementById("testSpeakerBtn").addEventListener("click", () => {
        playTestSound().catch(() => {});
    });

    masterVolumeSlider.addEventListener("input", () => {
        masterVolume = Number(masterVolumeSlider.value) / 100;
        writeStore(STORE.master, String(masterVolume));
        applyAllGains();
    });

    vadSlider.addEventListener("input", () => {
        vadThreshold = Number(vadSlider.value) / 100;
        writeStore(STORE.vad, String(vadThreshold));
        if (vadThreshold <= 0) {
            vadOpen = true;
            updateEffectiveMicState();
        }
    });

    echoCancelCheck.addEventListener("change", () => {
        echoCancellation = echoCancelCheck.checked;
        writeStore(STORE.echo, echoCancellation ? "1" : "0");
        switchAudioInput(selectedMicId).catch((err) => console.error(err));
    });

    autoGainCheck.addEventListener("change", () => {
        autoGainControl = autoGainCheck.checked;
        writeStore(STORE.agc, autoGainControl ? "1" : "0");
        switchAudioInput(selectedMicId).catch((err) => console.error(err));
    });

    soundFxCheck.addEventListener("change", () => {
        soundFxEnabled = soundFxCheck.checked;
        writeStore(STORE.sfx, soundFxEnabled ? "1" : "0");
    });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener("devicechange", () => {
            refreshDeviceLists().catch(() => {});
        });
    }

    document.querySelectorAll(".mode-pill").forEach((btn) => {
        btn.addEventListener("click", async () => {
            try {
                await ensureLocalStream();
            } catch {
                appendSystemMessage("Mikrofona erişim izni vermelisin.");
                return;
            }
            setMicMode(btn.dataset.mode);
        });
    });

    function pttKeyLabel(code) {
        if (code === "Space") return "Boşluk";
        if (code.startsWith("Key")) return code.slice(3);
        if (code.startsWith("Digit")) return code.slice(5);
        return code;
    }

    let isListeningForPttKey = false;

    function updatePttKeyButton() {
        const btn = document.getElementById("pttKeyButton");
        btn.textContent = isListeningForPttKey ? "Bir tuşa bas…" : pttKeyLabel(pttKey);
        btn.classList.toggle("listening", isListeningForPttKey);
    }

    document.getElementById("pttKeyButton").addEventListener("click", () => {
        isListeningForPttKey = true;
        updatePttKeyButton();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            if (!userMenuEl.hidden) closeUserMenu();
            if (!settingsOverlay.hidden) closeSettings();
            if (!confirmOverlay.hidden) document.getElementById("confirmCancel").click();
        }

        if (isListeningForPttKey) {
            if (e.code === "Escape") {
                isListeningForPttKey = false;
                updatePttKeyButton();
                return;
            }
            e.preventDefault();
            pttKey = e.code;
            writeStore(STORE.ptt, pttKey);
            isListeningForPttKey = false;
            updatePttKeyButton();
            return;
        }

        if (overlayOpen() || isTypingInField()) return;

        if (e.ctrlKey && e.shiftKey && e.code === "KeyM") {
            e.preventDefault();
            document.getElementById("muteButton").click();
            return;
        }
        if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
            e.preventDefault();
            document.getElementById("deafenButton").click();
            return;
        }
        if (e.ctrlKey && e.shiftKey && e.code === "KeyV") {
            e.preventDefault();
            document.getElementById("cameraButton").click();
            return;
        }
        if (e.ctrlKey && e.code === "Comma") {
            e.preventDefault();
            if (settingsOverlay.hidden) openSettings();
            else closeSettings();
            return;
        }

        if (e.code !== pttKey || micMode !== "ptt" || e.repeat) return;
        e.preventDefault();
        pttActive = true;
        updateEffectiveMicState();
    });

    document.addEventListener("keyup", (e) => {
        if (e.code !== pttKey || micMode !== "ptt") return;
        pttActive = false;
        updateEffectiveMicState();
    });

    updatePttKeyButton();
    setMicMode(micMode);

    window.addEventListener("blur", () => {
        if (pttActive) {
            pttActive = false;
            updateEffectiveMicState();
        }
    });

    document.getElementById("leaveButton").addEventListener("click", () => {
        window.location.href = "/Chat/Login";
    });

    document.getElementById("roomCodeBadge").addEventListener("click", () => {
        const icon = document.querySelector("#roomCodeBadge .copy-icon");
        copyInvite(icon);
    });

    ensureSalonInvite();
    const salonInviteCopy = document.getElementById("salonInviteCopy");
    if (salonInviteCopy) {
        salonInviteCopy.addEventListener("click", () => copyInvite(salonInviteCopy));
    }

    setInterval(renderTyping, 800);

    window.addEventListener("beforeunload", () => {
        if (rawStream) rawStream.getTracks().forEach((track) => track.stop());
        if (cleanStream) cleanStream.getTracks().forEach((track) => track.stop());
        if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
        if (cameraPreviewStream && cameraPreviewStream !== cameraStream) {
            cameraPreviewStream.getTracks().forEach((track) => track.stop());
        }
        if (rnnoiseNode) {
            try { rnnoiseNode.destroy(); } catch { /* */ }
        }
        if (suppressorCtx) suppressorCtx.close();
        if (screenStream) screenStream.getTracks().forEach((track) => track.stop());
        participants.forEach((p) => p.pc && p.pc.close());
    });

    Promise.all([connection.start(), iceServersReady])
        .then(() => {
            setStatus(true);
            return connection.invoke("JoinRoom", currentRoomCode, currentUsername, currentRoomPassword, currentAvatarUrl);
        })
        .then(() => {
            renderParticipantList();
            return announceLocalMedia();
        })
        .catch((err) => {
            console.error("SignalR bağlantı hatası:", err);
            setStatus(false);
            appendSystemMessage("Bağlantı kurulamadı, sayfayı yenilemeyi dene.");
        });

    connection.onreconnecting(() => setStatus(false));

    connection.onreconnected(() => {
        setStatus(true);
        participants.forEach((p, id) => teardownParticipant(id));
        connection.invoke("JoinRoom", currentRoomCode, currentUsername, currentRoomPassword, currentAvatarUrl)
            .then(() => {
                renderParticipantList();
                return announceLocalMedia();
            });
    });

    masterVolumeSlider.value = String(Math.round(masterVolume * 100));
    vadSlider.value = String(Math.round(vadThreshold * 100));
    echoCancelCheck.checked = echoCancellation;
    autoGainCheck.checked = autoGainControl;
    soundFxCheck.checked = soundFxEnabled;

    settingsCamPreview.addEventListener("playing", syncPreviewWrap);
    settingsCamPreview.addEventListener("emptied", syncPreviewWrap);
    setRoomChrome(currentRoomCode, currentRoomName);
    syncSelfState();
    renderParticipantList();
})();
