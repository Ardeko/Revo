using System.Drawing;
using Microsoft.AspNetCore.SignalR;
using Photino.NET;
using RevoApp.Hubs;
using RevoApp.Services;

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

if (isDesktop)
{
    // Kestrel'i arka planda başlatıp gerçek bir native pencere içinde
    // gösteriyoruz — exe çalıştırıldığında tarayıcı sekmesi değil, kendi
    // ikonu/başlığı/görev çubuğu girdisi olan bir REVO penceresi açılır.
    await app.StartAsync();

    var iconPath = Path.Combine(AppContext.BaseDirectory, "wwwroot", "favicon.ico");

    var window = new PhotinoWindow()
        .SetTitle("REVO")
        .SetUseOsDefaultSize(false)
        .SetSize(new Size(1320, 860))
        .SetIconFile(iconPath)
        .Load(desktopUrl);

    window.WaitForClose(); // Pencere kapanana kadar burada bekler.

    await app.StopAsync();
}
else
{
    // Klasik web modu (deploy senaryosu): dotnet RevoApp.dll --web
    await app.RunAsync();
}
