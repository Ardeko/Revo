// ===================== REVO — Custom Title Bar (Photino) =====================
// Photino'nun WebView2 altyapısı Electron'daki gibi CSS
// "-webkit-app-region: drag" özelliğini native olarak desteklemez, bu yüzden
// sürüklemeyi Program.cs tarafındaki Win32 ReleaseCapture/SendMessage
// (WM_NCLBUTTONDOWN + HTCAPTION) hilesiyle yapıyoruz. Bu dosya sadece
// mesajları C# tarafına iletiyor.
(function () {
    // Photino masaüstü penceresinde miyiz, yoksa normal tarayıcıda mı?
    // ardaguner.xyz'de sayfa tarayıcıda açıldığında küçült/büyüt/kapat
    // düğmeleri anlamsız (ve çalışmaz) — o durumda şeridi hiç göstermiyoruz.
    function isDesktopHost() {
        return !!(window.external && typeof window.external.sendMessage === "function");
    }

    function sendToHost(message) {
        if (isDesktopHost()) {
            window.external.sendMessage(message);
        }
    }

    // Büyütülmüş durumda ikon "geri yükle"ye dönüşsün (üst üste iki kare) —
    // Windows'un kendi pencere düğmelerindeki alışılmış davranış.
    var ICON_MAXIMIZE = '<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" /></svg>';
    var ICON_RESTORE = '<svg viewBox="0 0 12 12"><rect x="1.5" y="3.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1" /><path d="M3.5 3.5 V1.5 H10.5 V8.5 H8.5" fill="none" stroke="currentColor" stroke-width="1" /></svg>';

    document.addEventListener("DOMContentLoaded", function () {
        var bar = document.querySelector(".revo-titlebar");
        if (!bar) return;

        if (!isDesktopHost()) {
            bar.style.display = "none";
            // Sayfa düzeni --tb-height kadar boşluk bırakıyor; tarayıcıda o
            // boşluğa gerek yok.
            document.documentElement.style.setProperty("--tb-height", "0px");
            return;
        }

        var dragArea = bar.querySelector(".revo-titlebar__drag");
        var minBtn = bar.querySelector(".revo-titlebar__btn--minimize");
        var maxBtn = bar.querySelector(".revo-titlebar__btn--maximize");
        var closeBtn = bar.querySelector(".revo-titlebar__btn--close");

        if (dragArea) {
            dragArea.addEventListener("mousedown", function (e) {
                // Sol tık dışındaki tıklamalarda (sağ tık menüsü vs.) sürükleme
                // başlatma; çift tıkla maximize/restore aşağıda ele alınıyor.
                if (e.button !== 0) return;
                sendToHost("titlebar:drag-start");
            });

            dragArea.addEventListener("dblclick", function () {
                sendToHost("titlebar:maximize-toggle");
            });
        }

        if (minBtn) {
            minBtn.addEventListener("click", function () {
                sendToHost("titlebar:minimize");
            });
        }

        if (maxBtn) {
            maxBtn.addEventListener("click", function () {
                sendToHost("titlebar:maximize-toggle");
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener("click", function () {
                sendToHost("titlebar:close");
            });
        }

        function applyState(text) {
            if (typeof text !== "string" || text.indexOf("titlebar:state:") !== 0) return;
            var isMaximized = text.slice("titlebar:state:".length) === "maximized";
            bar.classList.toggle("is-maximized", isMaximized);
            if (maxBtn) {
                maxBtn.innerHTML = isMaximized ? ICON_RESTORE : ICON_MAXIMIZE;
                maxBtn.setAttribute("aria-label", isMaximized ? "Geri Yükle" : "Büyüt");
            }
        }

        // ÖNEMLİ: Photino, C# tarafındaki SendWebMessage çağrılarını
        // window.external.receiveMessage(callback) üzerinden teslim ediyor —
        // tarayıcıların standart "message" olayı üzerinden DEĞİL. Eski kod
        // window.addEventListener("message", …) dinlediği için büyütme ikonu
        // hiçbir zaman güncellenmiyordu.
        if (typeof window.external.receiveMessage === "function") {
            window.external.receiveMessage(applyState);
        }

        // Yine de standart olayı da dinliyoruz: Photino'nun ileriki bir sürümü
        // ya da farklı bir gömme senaryosu bu yolu kullanırsa çalışmaya devam etsin.
        window.addEventListener("message", function (event) {
            applyState(typeof event.data === "string" ? event.data : "");
        });
    });
})();