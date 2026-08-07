using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.AspNetCore.SignalR;
using Photino.NET;
using RevoApp.Hubs;
using RevoApp.Services;

// ============================================================================
// REVO iki farklı şekilde çalışır:
//
//   SUNUCU MODU  — Render'daki (ya da herhangi bir sunucudaki) kopya. Kestrel'i
//                  başlatır, sayfaları ve /chatHub'ı servis eder. Odalar,
//                  katılımcılar ve WebRTC sinyalleşmesi BURADA yaşar.
//
//   MASAÜSTÜ MODU — Kullanıcının indirdiği .exe. Kendi sunucusunu ÇALIŞTIRMAZ;
//                  sadece uzaktaki REVO sunucusuna bakan bir pencere açar.
//
// Eskiden .exe kendi içinde Kestrel'i 127.0.0.1'de başlatıyordu. Bu, herkesin
// kendi bilgisayarındaki ayrı bir sunucuya bağlanması demekti — iki kişi .exe'yi
// açtığında birbirini asla göremezdi, çünkü aynı odada değil, iki ayrı dünyada
// oluyorlardı. Discord gibi çalışması için masaüstü uygulamasının HERKESİN
// bağlandığı tek bir sunucuya bakması gerekiyor.
//
// Yan fayda: pencere artık https:// bir adres yüklüyor. Tarayıcılar mikrofon
// (getUserMedia) ve AudioWorklet gibi API'leri sadece "güvenli bağlam"da açıyor;
// http://127.0.0.1 bunu her zaman sağlamıyordu.
// ============================================================================

const string DefaultServerUrl = "https://ardekostudios.xyz";

// Sunucu modu ne zaman devreye girer:
//   • "--web" argümanı açıkça verildiğinde (Dockerfile / Render bunu kullanır)
//   • Windows dışında çalışıyorsak — Linux konteynerde pencere açmanın anlamı yok
//     ve eski kodda bu kontrol olmadığı için sunucuya deploy edildiğinde
//     masaüstü moduna düşme riski vardı.
var isServerMode = args.Contains("--web") || !OperatingSystem.IsWindows();

// Test için: REVO.exe --server=http://localhost:5000
// (kendi makinendeki sunucuya bağlanmak istersen)
var serverUrl = args
    .FirstOrDefault(a => a.StartsWith("--server=", StringComparison.OrdinalIgnoreCase))
    ?.Substring("--server=".Length)
    ?.TrimEnd('/') ?? DefaultServerUrl;

if (isServerMode)
{
    await RunServerAsync(args);
    return;
}

RunDesktopClient(serverUrl);
return;

// ---------------------------------------------------------------------------
// SUNUCU MODU
// ---------------------------------------------------------------------------
static async Task RunServerAsync(string[] commandLineArgs)
{
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        Args = commandLineArgs,
        // wwwroot'u çalışma dizinine değil, uygulamanın yanına göre çöz —
        // konteynerde ya da servis olarak başlatıldığında çalışma dizini
        // farklı olabiliyor.
        WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
    });

    builder.Services.AddControllersWithViews();

    // Varsayılan mesaj boyutu limiti (32KB), JoinRoom'a gömülen base64 profil
    // resmi için dar olabiliyor; küçük bir pay ile yükseltiyoruz.
    builder.Services.AddSignalR(options =>
    {
        options.MaximumReceiveMessageSize = 128 * 1024;
    });

    // Odaları tutan servis — tekil (Singleton) olmalı çünkü tüm bağlantılar
    // aynı oda listesini paylaşmak zorunda.
    builder.Services.AddSingleton<RoomManager>();

    // TURN kimlik bilgilerini Cloudflare'den alıp önbellekleyen servis.
    // Anahtarlar ortam değişkeninden okunuyor: Turn__KeyId, Turn__ApiToken
    builder.Services.AddHttpClient();
    builder.Services.AddSingleton<TurnCredentialService>();

    var app = builder.Build();

    app.UseStaticFiles();
    app.UseRouting();

    // [Route("ice")] gibi öznitelik tabanlı route'lar için (IceController).
    app.MapControllers();

    // /oda/ABC123 gibi davet linkleri Login sayfasını, oda kodu önceden
    // dolu şekilde açsın diye ayrı bir route. "default" route'undan ÖNCE
    // tanımlanmalı, aksi halde eşleşmeden önce default kuralı devreye girer.
    app.MapControllerRoute(
        name: "room",
        pattern: "oda/{roomCode}",
        defaults: new { controller = "Chat", action = "Login" });

    app.MapControllerRoute(
        name: "default",
        pattern: "{controller=Chat}/{action=Login}");

    app.MapHub<ChatHub>("/chatHub");

    await app.RunAsync();
}

// ---------------------------------------------------------------------------
// MASAÜSTÜ MODU (ince istemci)
// ---------------------------------------------------------------------------
static void RunDesktopClient(string serverUrl)
{
    // OutputType=WinExe konsolu tamamen gizliyor — bu sadece bizim
    // Console.WriteLine'larımızı değil, Photino'nun kendi loglamasını ve
    // yakalanmamış bir istisnanın stack trace'ini de görünmez yapıyor.
    // Tüm konsol çıktısını bir log dosyasına yönlendiriyoruz.
    var logPath = Path.Combine(Path.GetTempPath(), "revo-debug.log");
    var logWriter = new StreamWriter(logPath, append: false) { AutoFlush = true };
    Console.SetOut(logWriter);
    Console.SetError(logWriter);
    Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] REVO masaüstü istemcisi başlıyor. Sunucu: {serverUrl}");

    try
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "wwwroot", "favicon.ico");

        // Custom title bar'ı native olarak sürüklemek için kullanılan Win32
        // sabitleri. Lambda içinde kullanılmadan ÖNCE tanımlanmış olmaları
        // gerekiyor (CS0841).
        const uint WM_NCLBUTTONDOWN = 0x00A1;
        var HTCAPTION = (IntPtr)2;

        // ÖNEMLİ: top-level statements ile yazılmış bir giriş noktası STA
        // (Single-Threaded Apartment) DEĞİLDİR. Photino'nun penceresi bir HWND
        // olarak açılır ama içindeki WebView2 kontrolü STA olmayan bir thread'de
        // içerik render edemez — sonsuza kadar beyaz kalır.
        // (tryphotino/photino.NET issue #180 ve #52.) Bu yüzden pencerenin tüm
        // yaşam döngüsü açıkça STA'ya ayarlanmış ayrı bir thread'de çalışır.
        Exception? windowThreadException = null;
        var windowThread = new Thread(() =>
        {
            try
            {
                var windowBuilder = new PhotinoWindow()
                    .SetLogVerbosity(2)
                    .SetTitle("REVO")
                    // Mikrofon / ekran paylaşımı izin isteklerini otomatik onayla.
                    // WebView2 normalde her seferinde bir izin balonu gösteriyor;
                    // chromeless pencerede bu balon garip duruyor ve bazı
                    // durumlarda hiç görünmeden istek düşüyordu.
                    .SetGrantBrowserPermissions(true)
                    // Karşı tarafın sesi <audio> elemanıyla çalınıyor. Otomatik
                    // oynatma kapalıyken tarayıcı, kullanıcı sayfaya tıklamadan
                    // sesi başlatmıyor — sesli sohbette bu "karşımdakini
                    // duymuyorum" olarak ortaya çıkıyor.
                    .SetMediaAutoplayEnabled(true)
                    // Chromeless=true iken Photino'nun doğrulaması hem
                    // UseOsDefaultLocation hem UseOsDefaultSize'ın açıkça false
                    // olmasını VE gerçek bir boyut+konum verilmesini şart koşuyor.
                    .SetUseOsDefaultLocation(false)
                    .SetUseOsDefaultSize(false)
                    .SetSize(new Size(1320, 860))
                    .Center();

                // İkon dosyası eksikse SetIconFile() istisna fırlatıp tüm
                // uygulamayı çökertiyordu — sadece dosya gerçekten varsa
                // ayarlıyoruz.
                if (File.Exists(iconPath))
                {
                    windowBuilder = windowBuilder.SetIconFile(iconPath);
                }
                else
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] UYARI: İkon bulunamadı ({iconPath}), varsayılanla devam ediliyor.");
                }

                var window = windowBuilder.SetChromeless(true);

                // wwwroot/js/titlebar.js içinden window.external.sendMessage(...)
                // ile gelen komutlar. Sayfa artık uzak sunucudan geliyor ama
                // Photino köprüsü hangi origin olursa olsun enjekte ediliyor.
                window.RegisterWebMessageReceivedHandler((sender, message) =>
                {
                    switch (message)
                    {
                        case "titlebar:minimize":
                            window.Minimized = true;
                            break;

                        case "titlebar:maximize-toggle":
                            window.Maximized = !window.Maximized;
                            break;

                        case "titlebar:close":
                            window.Close();
                            break;

                        case "titlebar:drag-start":
                            // OS'in kendi pencere sürükleme mekanizması
                            // (WM_NCLBUTTONDOWN + HTCAPTION). JS tarafında
                            // mousemove dinleyip pencereyi manuel taşımaktan çok
                            // daha akıcı — WebView2 tabanlı custom title bar'larda
                            // standart teknik budur.
                            ReleaseCapture();
                            SendMessage(window.WindowHandle, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
                            break;
                    }

                    // Her komuttan sonra güncel maximize durumunu JS'e geri
                    // gönderiyoruz (büyüt/geri yükle ikonu senkronu için).
                    window.SendWebMessage($"titlebar:state:{(window.Maximized ? "maximized" : "normal")}");
                });

                // ?desktop=1 işareti: sayfa tarafındaki titlebar.js bu sayede
                // masaüstü penceresinde olduğunu KESİN olarak biliyor. Photino
                // köprüsünün (window.external) hazır olup olmadığına bakan
                // tespit yarış koşuluna açıktı ve şerit bazen hiç görünmüyordu.
                var launchUrl = serverUrl;
                launchUrl += (launchUrl.Contains('?') ? "&" : "?") + "desktop=1";

                Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] Pencere hazır (STA thread), yükleniyor: {launchUrl}");
                window.Load(new Uri(launchUrl));
                window.WaitForClose();
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] Pencere kapandı.");
            }
            catch (Exception ex)
            {
                windowThreadException = ex;
            }
        });

        // STA yalnızca Windows'ta anlamlı; OperatingSystem kontrolü hem doğru
        // davranış hem de CA1416 platform uyarısını temizler.
        if (OperatingSystem.IsWindows())
        {
            windowThread.SetApartmentState(ApartmentState.STA);
        }

        windowThread.Start();
        windowThread.Join(); // ana thread, pencere kapanana kadar burada bekler

        if (windowThreadException is not null)
        {
            throw windowThreadException;
        }
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] HATA:\n{ex}");

        // MessageBox user32.dll'e bağlı — Windows dışında çağrılırsa
        // DllNotFoundException fırlatır ve asıl hatanın üstünü örter.
        // Buraya normalde sadece Windows'ta gelinir, ama hata yolunun kendisi
        // hata üretmemeli.
        if (OperatingSystem.IsWindows())
        {
            MessageBox(
                IntPtr.Zero,
                $"REVO başlatılamadı:\n\n{ex.Message}\n\nDetaylı log: {logPath}",
                "REVO - Başlatma Hatası",
                0x10);
        }
    }
}

[DllImport("user32.dll", CharSet = CharSet.Unicode)]
static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

[DllImport("user32.dll")]
static extern bool ReleaseCapture();

[DllImport("user32.dll", CharSet = CharSet.Unicode)]
static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
