// ===================== REVO — Custom Title Bar (Photino) =====================
// Photino'nun WebView2 altyapısı Electron'daki gibi CSS
// "-webkit-app-region: drag" özelliğini native olarak desteklemez, bu yüzden
// sürüklemeyi Program.cs tarafındaki Win32 ReleaseCapture/SendMessage
// (WM_NCLBUTTONDOWN + HTCAPTION) hilesiyle yapıyoruz. Bu dosya sadece
// mesajları C# tarafına iletiyor.
(function () {
    function sendToHost(message) {
        // Photino.NET her pencereye window.external.sendMessage enjekte eder.
        if (window.external && typeof window.external.sendMessage === "function") {
            window.external.sendMessage(message);
        } else {
            console.warn("REVO titlebar: Photino web message köprüsü bulunamadı:", message);
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        const bar = document.querySelector(".revo-titlebar");
        if (!bar) return;

        const dragArea = bar.querySelector(".revo-titlebar__drag");
        const minBtn = bar.querySelector(".revo-titlebar__btn--minimize");
        const maxBtn = bar.querySelector(".revo-titlebar__btn--maximize");
        const closeBtn = bar.querySelector(".revo-titlebar__btn--close");

        if (dragArea) {
            dragArea.addEventListener("mousedown", function (e) {
                // Sol tık dışındaki tıklamalarda (sağ tık menüsü vs.) sürükleme
                // başlatma; ayrıca çift tıkla maximize/restore'u da burada ele alalım.
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

        // C# tarafı her komuttan sonra "titlebar:state:maximized|normal" geri
        // gönderiyor; buna göre maximize ikonunu restore ikonuna çeviriyoruz.
        window.addEventListener("message", function (event) {
            const data = typeof event.data === "string" ? event.data : "";
            if (!data.startsWith("titlebar:state:")) return;
            const isMaximized = data.endsWith("maximized");
            bar.classList.toggle("is-maximized", isMaximized);
        });
    });
})();
