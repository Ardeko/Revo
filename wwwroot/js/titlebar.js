// ===================== REVO — Custom Title Bar (Photino) =====================
// Photino'nun WebView2 altyapısı Electron'daki "-webkit-app-region: drag"
// özelliğini desteklemiyor, bu yüzden sürükleme Program.cs tarafındaki Win32
// ReleaseCapture/SendMessage (WM_NCLBUTTONDOWN + HTCAPTION) hilesiyle yapılıyor.
// Bu dosya komutları C# tarafına iletiyor.
(function () {
    "use strict";

    var DESKTOP_FLAG = "revo:isDesktop";

    // ---- Masaüstü tespiti ----
    // Eski sürüm yalnızca DOMContentLoaded anında window.external.sendMessage'a
    // bakıyordu. İki sorunu vardı:
    //   1) Photino köprüsü sayfa scriptlerinden SONRA enjekte edilebiliyor;
    //      o an bakınca yok görünüyor ve şerit kalıcı olarak gizleniyordu.
    //      Şeridin hiç çıkmamasının sebebi buydu.
    //   2) Giriş → oda geçişi form POST'u ile yeni bir sayfa yüklemesi;
    //      her yüklemede tespiti sıfırdan yapmak gerekiyordu.
    //
    // Artık üç kaynağa birden bakıyoruz ve sonucu sekme boyunca saklıyoruz:
    //   • Program.cs pencereyi ?desktop=1 ile açıyor (kesin bilgi)
    //   • sessionStorage'daki bayrak (aynı pencerede sonraki sayfalar)
    //   • window.external.sendMessage (köprü hazırsa)
    function markDesktop() {
        try { sessionStorage.setItem(DESKTOP_FLAG, "1"); } catch (e) { /* özel mod */ }
    }

    function hasBridge() {
        return !!(window.external && typeof window.external.sendMessage === "function");
    }

    function isDesktopHost() {
        if (hasBridge()) { markDesktop(); return true; }
        try {
            if (sessionStorage.getItem(DESKTOP_FLAG) === "1") return true;
        } catch (e) { /* yoksay */ }
        return false;
    }

    // Pencere ?desktop=1 ile açıldıysa hemen işaretle — köprü henüz hazır
    // olmasa bile masaüstünde olduğumuzu biliyoruz.
    try {
        if (new URLSearchParams(window.location.search).get("desktop") === "1") {
            markDesktop();
        }
    } catch (e) { /* yoksay */ }

    function sendToHost(message) {
        if (hasBridge()) window.external.sendMessage(message);
    }

    // Büyütülmüş durumda ikon "geri yükle"ye döner (üst üste iki kare) —
    // Windows'un kendi pencere düğmelerindeki alışılmış davranış.
    var ICON_MAXIMIZE = '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
    var ICON_RESTORE = '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

    function init() {
        var bar = document.querySelector(".revo-titlebar");
        if (!bar) return;

        if (!isDesktopHost()) {
            // Tarayıcıda çalışan sürüm: çalışmayan küçült/kapat düğmeleri
            // göstermenin anlamı yok.
            bar.hidden = true;
            document.documentElement.style.setProperty("--tb-height", "0px");
            return;
        }

        bar.hidden = false;

        var dragArea = bar.querySelector(".revo-titlebar__drag");
        var minBtn = bar.querySelector(".revo-titlebar__btn--minimize");
        var maxBtn = bar.querySelector(".revo-titlebar__btn--maximize");
        var closeBtn = bar.querySelector(".revo-titlebar__btn--close");

        if (dragArea) {
            dragArea.addEventListener("mousedown", function (e) {
                if (e.button !== 0) return;  // sağ tık sürüklemesin
                sendToHost("titlebar:drag-start");
            });
            dragArea.addEventListener("dblclick", function () {
                sendToHost("titlebar:maximize-toggle");
            });
        }

        if (minBtn) {
            minBtn.addEventListener("click", function () { sendToHost("titlebar:minimize"); });
        }
        if (maxBtn) {
            maxBtn.addEventListener("click", function () { sendToHost("titlebar:maximize-toggle"); });
        }
        if (closeBtn) {
            closeBtn.addEventListener("click", function () { sendToHost("titlebar:close"); });
        }

        function applyState(text) {
            if (typeof text !== "string" || text.indexOf("titlebar:state:") !== 0) return;
            var isMaximized = text.slice("titlebar:state:".length) === "maximized";
            bar.classList.toggle("is-maximized", isMaximized);
            if (maxBtn) {
                maxBtn.innerHTML = isMaximized ? ICON_RESTORE : ICON_MAXIMIZE;
                maxBtn.setAttribute("aria-label", isMaximized ? "Geri yükle" : "Büyüt");
                maxBtn.setAttribute("title", isMaximized ? "Geri yükle" : "Büyüt");
            }
        }

        // ÖNEMLİ: Photino, C# tarafındaki SendWebMessage çağrılarını
        // window.external.receiveMessage(callback) üzerinden teslim ediyor —
        // tarayıcıların standart "message" olayı üzerinden DEĞİL.
        function attachReceiver(attempt) {
            if (window.external && typeof window.external.receiveMessage === "function") {
                window.external.receiveMessage(applyState);
                return;
            }
            // Köprü henüz enjekte edilmemiş olabilir; kısa süre yeniden dene.
            if (attempt < 20) {
                setTimeout(function () { attachReceiver(attempt + 1); }, 100);
            }
        }
        attachReceiver(0);

        // Standart olayı da dinliyoruz: Photino'nun ileriki bir sürümü ya da
        // farklı bir gömme senaryosu bu yolu kullanırsa çalışmaya devam etsin.
        window.addEventListener("message", function (event) {
            applyState(typeof event.data === "string" ? event.data : "");
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
