using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.AspNetCore.SignalR;
using Photino.NET;
using RevoApp.Hubs;
using RevoApp.Services;

// OutputType=WinExe konsolu tamamen gizliyor — bu sadece bizim
// Console.WriteLine'larımızı değil, Photino'nun kendi dahili loglamasını da
// (varsayılan LogVerbosity=2, kendi içinde Console.WriteLine kullanıyor) ve
// yakalanmamış bir istisna anında normalde görünecek stack trace'i de
// görünmez yapıyor. Geçici olarak TÜM konsol çıktısını bir log dosyasına
// yönlendiriyoruz ki "beyaz ekran" gibi sorunlarda neler olduğunu görebilelim.
var logPath = Path.Combine(Path.GetTempPath(), "revo-debug.log");
var logWriter = new StreamWriter(logPath, append: false) { AutoFlush = true };
Console.SetOut(logWriter);
Console.SetError(logWriter);
Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] REVO başlatılıyor. Args: {string.Join(' ', args)}");

var builder = WebApplication.CreateBuilder(args);

// MVC ve SignalR hizmetlerini ekliyoruz
builder.Services.AddControllersWithViews(); // MVC Controller'lar için gerekli servis
// Varsayılan mesaj boyutu limiti (32KB), JoinRoom'a gömülen base64 profil
// resmi için dar olabiliyor; küçük bir pay ile yükseltiyoruz.
builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 128 * 1024;
});

// Odaları tutan servis — tekil (Singleton) olmalı çünkü tüm bağlantılar
// aynı oda listesini paylaşmak zorunda.
builder.Services.AddSingleton<RoomManager>();

// Masaüstü modu (varsayılan): exe çift tıklanınca Kestrel arka planda, sabit
// yerel bir portta dinler; Photino penceresi doğrudan o adrese bakar.
// "--web" argümanıyla çalıştırılırsa (ör. bir sunucuya deploy ederken) eski
// tarayıcı tabanlı davranışa döner ve rastgele/atanan porttan dinler.
const string desktopUrl = "http://127.0.0.1:57841";
var isDesktop = !args.Contains("--web");
if (isDesktop)
{
    builder.WebHost.UseUrls(desktopUrl);
}

var app = builder.Build();

// Statik dosyaları (css, js, img) sunmak için gerekli ayar
app.UseStaticFiles();

// Routing ayarlarını yapalım (Sayfa yönlendirme)
app.UseRouting();

// /oda/ABC123 gibi davet linkleri Login sayfasını, oda kodu önceden
// dolu şekilde açsın diye ayrı bir route. "default" route'undan ÖNCE
// tanımlanmalı, aksi halde eşleşmeden önce default kuralı devreye girer.
app.MapControllerRoute(
    name: "room",
    pattern: "oda/{roomCode}",
    defaults: new { controller = "Chat", action = "Login" });

// Controller Route ayarları
app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Chat}/{action=Login}");  // Ana sayfanın yönlendirilmesi

// SignalR hub'ını burada tanımlıyoruz
app.MapHub<ChatHub>("/chatHub");

// Custom title bar'ı native olarak sürüklemek için kullanılan Win32 sabitleri.
// Kullanılmadan önce (window oluşturulmadan önce) tanımlanmış olmaları
// gerekiyor — top-level statements dosyasında yerel değişkenler/sabitler,
// bir lambda içinde referans verilse bile, tanımlandıkları noktadan önce
// kullanılamıyor (CS0841).
const uint WM_NCLBUTTONDOWN = 0x00A1;
IntPtr HTCAPTION = (IntPtr)2;

if (isDesktop)
{
    try
    {
        // app.StartAsync() çağrısı Kestrel'in başlayacağını SÖYLER ama asenkron
        // olarak başlar — pencere o sırada URL'yi yüklemeye kalkınca henüz hazır
        // olmayan sunucudan beyaz/hata sayfası alır. IHostApplicationLifetime ile
        // "gerçekten dinlemeye başladım" sinyalini bekliyoruz, ardından pencereyi açıyoruz.
        var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
        var readyTcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lifetime.ApplicationStarted.Register(() => readyTcs.TrySetResult());

        await app.StartAsync();
        await readyTcs.Task; // Kestrel gerçekten dinlemeye başlayana kadar bekle
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] Kestrel dinliyor: {desktopUrl}");

        var iconPath = Path.Combine(AppContext.BaseDirectory, "wwwroot", "favicon.ico");
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] BaseDirectory: {AppContext.BaseDirectory}");
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] İkon yolu: {iconPath} (dosya var mı: {File.Exists(iconPath)})");

        // ÖNEMLİ: top-level statements + await kullanan bir giriş noktası (bizimki)
        // derleyici tarafından "async Task Main" olarak derlenir ve bu thread STA
        // (Single-Threaded Apartment) DEĞİLDİR. Photino'nun native penceresi bir
        // HWND olarak açılır (senin logunda gördüğümüz gibi) ama içindeki WebView2
        // kontrolü STA olmayan bir thread'de asla içerik render edemez — sonsuza
        // kadar beyaz kalır. Doğrulanmış kaynak: tryphotino/photino.NET issue #180
        // ve #52. Çözüm: pencerenin TÜM yaşam döngüsünü (oluştur → yükle →
        // WaitForClose) apartment durumu açıkça STA'ya ayarlanmış ayrı bir thread
        // üzerinde çalıştırmak, ana thread o bitene kadar Join() ile bekler.
        Exception? windowThreadException = null;
        var windowThread = new Thread(() =>
        {
            try
            {
                var windowBuilder = new PhotinoWindow()
                    .SetLogVerbosity(2)
                    .SetTitle("REVO")
                    // GEÇİCİ: sesli odaya bağlanma sorununu teşhis edebilmek için
                    // DevTools'u açıyoruz. Pencerede sağ tık > İncele (ya da F12)
                    // ile gerçek JS/console hatasını görebilirsin — mikrofon izni
                    // reddi, getUserMedia istisnası, SignalR hatası vb. Sorunu
                    // bulduktan sonra bu satırı kaldırabilirsin.
                    .SetDevToolsEnabled(true)
                    // Chromeless=true iken Photino'nun kendi doğrulaması hem
                    // UseOsDefaultLocation hem UseOsDefaultSize'ın açıkça false
                    // olmasını VE gerçek bir boyut+konum verilmesini şart koşuyor
                    // (aksi halde "Startup Parameters Are Not Valid" hatası
                    // fırlatıyor). Center() ile Left/Top'u OS'e bırakmadan kendimiz
                    // hesaplatıyoruz.
                    .SetUseOsDefaultLocation(false)
                    .SetUseOsDefaultSize(false)
                    .SetSize(new Size(1320, 860))
                    .Center();

                // Debug klasöründen (wwwroot kopyalanmamış) çalıştırılırsa ya da
                // ikon dosyası herhangi bir sebeple eksikse SetIconFile() istisna
                // fırlatıp tüm uygulamayı çökertiyordu — sadece dosya gerçekten
                // varsa ikon ayarlıyoruz, yoksa Windows'un varsayılan ikonuyla
                // devam ediyoruz.
                if (File.Exists(iconPath))
                {
                    windowBuilder = windowBuilder.SetIconFile(iconPath);
                }
                else
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] UYARI: İkon dosyası bulunamadı, varsayılan ikonla devam ediliyor.");
                }

                var window = windowBuilder
                    // Native title bar / kenarlıkları tamamen kaldırıyoruz.
                    // Kapatma/küçültme/büyütme ve sürükleme artık tamamen
                    // wwwroot/js/titlebar.js + aşağıdaki mesaj handler'ı üzerinden.
                    .SetChromeless(true);

                // wwwroot/js/titlebar.js içinden window.external.sendMessage(...) ile
                // gönderilen komutları burada dinliyoruz. Basit string komutlar
                // kullanıyoruz (JSON'a gerek yok, IPC'yi hafif tutmak için).
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
                            // OS'in kendi pencere sürükleme mekanizmasını devreye
                            // sokuyoruz (WM_NCLBUTTONDOWN + HTCAPTION). Bu, JS
                            // tarafında mousemove'u dinleyip pencereyi manuel
                            // taşımaktan çok daha akıcı ve gecikmesiz çalışır —
                            // Electron/WebView2 tabanlı custom title bar'larda
                            // standart teknik budur.
                            ReleaseCapture();
                            SendMessage(window.WindowHandle, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
                            break;

                        default:
                            // Pencere durumu değişince JS tarafına haber veriyoruz ki
                            // maximize/restore ikonu doğru görünsün.
                            break;
                    }

                    // Her komuttan sonra güncel maximize durumunu JS'e geri
                    // gönderiyoruz (ikon senkronizasyonu için).
                    window.SendWebMessage($"titlebar:state:{(window.Maximized ? "maximized" : "normal")}");
                });

                Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] Pencere yapılandırıldı (STA thread), WaitForClose çağrılıyor…");
                window.Load(new Uri(desktopUrl));
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

        await app.StopAsync();
    }
    catch (Exception ex)
    {
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff}] HATA:\n{ex}");
        MessageBox(IntPtr.Zero, $"REVO başlatılamadı:\n\n{ex.Message}\n\nDetaylı log: {logPath}", "REVO - Başlatma Hatası", 0x10);
    }
}
else
{
    // Klasik web modu (deploy senaryosu): dotnet RevoApp.dll --web
    await app.RunAsync();
}

[DllImport("user32.dll", CharSet = CharSet.Unicode)]
static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

// Custom (chromeless) title bar'ı sürüklenebilir yapmak için: JS tarafında
// mousedown anında "titlebar:drag-start" mesajı gönderiliyor, biz de fare
// yakalamayı bırakıp OS'e "sanki başlık çubuğuna tıklandı" diyoruz. Windows
// bundan sonra sürüklemeyi kendi native mekanizmasıyla devralıyor.
[DllImport("user32.dll")]
static extern bool ReleaseCapture();

[DllImport("user32.dll", CharSet = CharSet.Unicode)]
static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
