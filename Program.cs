using System.Drawing;
using Microsoft.AspNetCore.SignalR;
using Photino.NET;
using RevoApp.Hubs;
using RevoApp.Services;

// SUNUCUNUN wwwroot KLASÖRÜNÜ KESİN OLARAK EXE'NİN YANINDA ARAMASINI SAĞLIYORUZ
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
});

builder.Services.AddControllersWithViews(); 
builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 128 * 1024;
});

builder.Services.AddSingleton<RoomManager>();

const string desktopUrl = "http://localhost:57841";
var isDesktop = !args.Contains("--web");

if (isDesktop)
{
    builder.WebHost.UseUrls(desktopUrl);
}

var app = builder.Build();

app.UseStaticFiles();
app.UseRouting();

app.MapControllerRoute(
    name: "room",
    pattern: "oda/{roomCode}",
    defaults: new { controller = "Chat", action = "Login" });

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Chat}/{action=Login}"); 

app.MapHub<ChatHub>("/chatHub");

if (isDesktop)
{
    _ = Task.Run(() => app.Run());
    Thread.Sleep(500); 

    var window = new PhotinoWindow()
        .SetTitle("REVO")
        .SetUseOsDefaultSize(false)
        .SetSize(new Size(1320, 860))
        .SetDevToolsEnabled(true) 
        .Load(new Uri(desktopUrl));

    window.WaitForClose();
}
else
{
    app.Run();
}