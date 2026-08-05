using System.Drawing;
using Microsoft.AspNetCore.SignalR;
using Photino.NET;
using RevoApp.Hubs;
using RevoApp.Services;

var builder = WebApplication.CreateBuilder(args);

// MVC ve SignalR hizmetlerini ekliyoruz
<<<<<<< HEAD
builder.Services.AddControllersWithViews(); 
=======
builder.Services.AddControllersWithViews(); // MVC Controller'lar için gerekli servis
// Varsayılan mesaj boyutu limiti (32KB), JoinRoom'a gömülen base64 profil
// resmi için dar olabiliyor; küçük bir pay ile yükseltiyoruz.
>>>>>>> 76b24f0ea3375f1aef4ffee6cff88ce6c9fea87f
builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 128 * 1024;
});

// Odaları tutan servis
builder.Services.AddSingleton<RoomManager>();

<<<<<<< HEAD
// Masaüstü modu
const string desktopUrl = "http://localhost:57841";
=======
// Masaüstü modu (varsayılan): exe çift tıklanınca Kestrel arka planda, sabit
// yerel bir portta dinler; Photino penceresi doğrudan o adrese bakar.
// "--web" argümanıyla çalıştırılırsa (ör. bir sunucuya deploy ederken) eski
// tarayıcı tabanlı davranışa döner ve rastgele/atanan porttan dinler.
const string desktopUrl = "http://127.0.0.1:57841";
>>>>>>> 76b24f0ea3375f1aef4ffee6cff88ce6c9fea87f
var isDesktop = !args.Contains("--web");
if (isDesktop)
{
    builder.WebHost.UseUrls(desktopUrl);
}

var app = builder.Build();

// Statik dosyaları sunmak için gerekli ayar
app.UseStaticFiles();

// Routing ayarlarını yapalım
app.UseRouting();

app.MapControllerRoute(
    name: "room",
    pattern: "oda/{roomCode}",
    defaults: new { controller = "Chat", action = "Login" });

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Chat}/{action=Login}"); 

// SignalR hub
app.MapHub<ChatHub>("/chatHub");

if (isDesktop)
{
<<<<<<< HEAD
    var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
    var readyTcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    lifetime.ApplicationStarted.Register(() => readyTcs.TrySetResult());

    await app.StartAsync();
    await readyTcs.Task; 

    // İKON YÜKLEMESİ KALDIRILDI, DEVTOOLS EKLENDİ
=======
    // Kestrel'i arka planda başlatıp gerçek bir native pencere içinde
    // gösteriyoruz — exe çalıştırıldığında tarayıcı sekmesi değil, kendi
    // ikonu/başlığı/görev çubuğu girdisi olan bir REVO penceresi açılır.
    await app.StartAsync();

    var iconPath = Path.Combine(AppContext.BaseDirectory, "wwwroot", "favicon.ico");

>>>>>>> 76b24f0ea3375f1aef4ffee6cff88ce6c9fea87f
    var window = new PhotinoWindow()
        .SetTitle("REVO")
        .SetUseOsDefaultSize(false)
        .SetSize(new Size(1320, 860))
<<<<<<< HEAD
        .SetDevToolsEnabled(true) // F12 için gerekli kod eklendi
        .Load(new Uri(desktopUrl));

    window.WaitForClose();
=======
        .SetIconFile(iconPath)
        .Load(desktopUrl);

    window.WaitForClose(); // Pencere kapanana kadar burada bekler.
>>>>>>> 76b24f0ea3375f1aef4ffee6cff88ce6c9fea87f

    await app.StopAsync();
}
else
{
<<<<<<< HEAD
    await app.RunAsync();
}
=======
    // Klasik web modu (deploy senaryosu): dotnet RevoApp.dll --web
    await app.RunAsync();
}
>>>>>>> 76b24f0ea3375f1aef4ffee6cff88ce6c9fea87f
