using Microsoft.AspNetCore.Mvc;

namespace RevoApp.Controllers;

public class ChatController : Controller
{
    public IActionResult Login()
    {
        return View();
    }

    public IActionResult Index(string? username)
    {
        username = username?.Trim();

        if (string.IsNullOrWhiteSpace(username))
            return RedirectToAction("Login");

        // Nick'i arayüzü bozmayacak makul bir uzunlukta tut (client-side maxlength'e ek güvence).
        if (username.Length > 24)
            username = username.Substring(0, 24);

        ViewBag.Username = username;
        return View();
    }
}
