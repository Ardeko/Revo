using Microsoft.AspNetCore.SignalR;
using RevoApp.Hubs;
using RevoApp.Services;

var builder = WebApplication.CreateBuilder(args);

// MVC ve SignalR hizmetlerini ekliyoruz
builder.Services.AddControllersWithViews(); // MVC Controller'lar için gerekli servis
builder.Services.AddSignalR(); // SignalR'ı projeye ekliyoruz

// Odaları tutan servis — tekil (Singleton) olmalı çünkü tüm bağlantılar
// aynı oda listesini paylaşmak zorunda.
builder.Services.AddSingleton<RoomManager>();

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

// Uygulamayı başlatıyoruz
app.Run();
