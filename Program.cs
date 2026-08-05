using System.Drawing;
using Microsoft.AspNetCore.SignalR;
using Photino.NET;
using RevoApp.Hubs;
using RevoApp.Services;

var builder = WebApplication.CreateBuilder(args);

// MVC ve SignalR hizmetlerini ekliyoruz
builder.Services.AddControllersWithViews(); 
builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 128 * 1024;
});

// Odaları tutan servis
builder.Services.AddSingleton<RoomManager>();

// Masaüstü modu
const string desktopUrl = "http://localhost:57841";
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
    var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
    var readyTcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    lifetime.ApplicationStarted.Register(() => readyTcs.TrySetResult());

    await app.StartAsync();
    await readyTcs.Task; 

    // İKON YÜKLEMESİ KALDIRILDI, DEVTOOLS EKLENDİ
    var window = new PhotinoWindow()
        .SetTitle("REVO")
        .SetUseOsDefaultSize(false)
        .SetSize(new Size(1320, 860))
        .SetDevToolsEnabled(true) // F12 için gerekli kod eklendi
        .Load(new Uri(desktopUrl));

    window.WaitForClose();

    await app.StopAsync();
}
else
{
    await app.RunAsync();
}