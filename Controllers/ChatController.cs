using System;
using Microsoft.AspNetCore.Mvc;
using RevoApp.Services;

namespace RevoApp.Controllers;

public class ChatController : Controller
{
    private readonly RoomManager _roomManager;

    public ChatController(RoomManager roomManager)
    {
        _roomManager = roomManager;
    }

    // Giriş ekranı: kullanıcı adı gir + "Oda Kur" ya da "Oda Kodu ile Katıl".
    // roomCode parametresi opsiyonel: /oda/{roomCode} linkine tıklanınca
    // form kod alanı otomatik doldurulmuş gelsin diye.
    public IActionResult Login(string? roomCode)
    {
        ViewBag.PrefilledRoomCode = roomCode;
        var isPublic = string.IsNullOrWhiteSpace(roomCode)
            || string.Equals(roomCode, RoomManager.PublicRoomCode, StringComparison.OrdinalIgnoreCase);
        ViewBag.LobbyMode = isPublic ? "public" : "join";
        SetPublicCount();
        return View();
    }

    // Not: Hub tarafında da şifre kontrolü tekrarlanıyor (bkz. ChatHub.JoinRoom).
    // Buradaki kontrol sadece kullanıcıya erken, sayfa yenilemeden geri bildirim
    // vermek için — asıl güvenlik sınırı Hub'da.
    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult CreateRoom(string? username, string? password)
    {
        username = NormalizeUsername(username);
        if (username is null)
        {
            ModelState.AddModelError("", "Lütfen bir kullanıcı adı girin.");
            ViewBag.LobbyMode = "create";
            SetPublicCount();
            return View("Login");
        }

        // Kurucunun SignalR ConnectionId'si burada henüz yok (Hub bağlantısı
        // sayfa yüklendikten sonra client tarafında kurulacak). Bu yüzden
        // "kurucu" bilgisi ilk JoinRoom çağrısında Hub içinde belirlenir —
        // orada odayı YENİ oluşturan kullanıcı otomatik moderatör kabul edilmez,
        // bunun yerine CreateRoom burada odayı yaratıp CreatedByConnectionId'yi
        // boş bırakır, Hub ilk katılan kişiyi (ki bu kurucudur) moderatör atar.
        if (password?.Length > RoomInput.MaximumPasswordLength)
        {
            ModelState.AddModelError("", "Oda şifresi en fazla 128 karakter olabilir.");
            ViewBag.LobbyMode = "create";
            SetPublicCount();
            return View("Login");
        }
        Models.Room room;
        try { room = _roomManager.CreateRoom(creatorConnectionId: "", password); }
        catch (InvalidOperationException exception)
        {
            ModelState.AddModelError("", exception.Message);
            ViewBag.LobbyMode = "create";
            SetPublicCount();
            return View("Login");
        }

        // TempData'nın şifreli HttpOnly çerezi, oda şifresini URL'e koymadan
        // Index'e taşır. Oda koduyla birlikte korunarak sayfa yenilemeyi destekler.
        TempData["RoomPassword"] = password;
        TempData["RoomPasswordCode"] = room.Code;

        return RedirectToAction("Index", new { username, room = room.Code });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    public IActionResult JoinRoom(string? username, string roomCode, string? password)
    {
        username = NormalizeUsername(username);
        if (username is null)
        {
            ModelState.AddModelError("", "Lütfen bir kullanıcı adı girin.");
            ViewBag.PrefilledRoomCode = roomCode;
            ViewBag.LobbyMode = string.Equals(roomCode, RoomManager.PublicRoomCode, StringComparison.OrdinalIgnoreCase)
                ? "public"
                : "join";
            SetPublicCount();
            return View("Login");
        }

        if (string.IsNullOrWhiteSpace(roomCode) || !_roomManager.TryGetRoom(roomCode, out var room) || room is null)
        {
            ModelState.AddModelError("", "Oda bulunamadı.");
            ViewBag.PrefilledRoomCode = roomCode;
            ViewBag.LobbyMode = "join";
            SetPublicCount();
            return View("Login");
        }

        if (!_roomManager.ValidatePassword(room, password))
        {
            ModelState.AddModelError("", "Şifre hatalı.");
            ViewBag.PrefilledRoomCode = roomCode;
            ViewBag.LobbyMode = "join";
            SetPublicCount();
            return View("Login");
        }

        TempData["RoomPassword"] = password;
        TempData["RoomPasswordCode"] = room.Code;

        return RedirectToAction("Index", new { username, room = room.Code });
    }

    // Aktif odaların listesi — kod, kullanıcı sayısı, şifreli olup olmadığı.
    public IActionResult Rooms()
    {
        var rooms = _roomManager.GetActiveRooms();
        return View(rooms);
    }

    public IActionResult Index(string? username, string? room)
    {
        username = NormalizeUsername(username);
        if (username is null || string.IsNullOrWhiteSpace(room))
            return RedirectToAction("Login");

        if (!_roomManager.TryGetRoom(room, out var found) || found is null)
            return RedirectToAction("Login");

        ViewBag.Username = username;
        ViewBag.RoomCode = found.Code;
        ViewBag.RoomName = found.Name;
        // Keep the last room credential in the encrypted, HttpOnly TempData
        // cookie so refresh works. Never reuse it for a different room.
        ViewBag.RoomPassword = TempData.Peek("RoomPasswordCode") as string == found.Code
            ? TempData.Peek("RoomPassword") as string : null;
        return View();
    }

    private static string? NormalizeUsername(string? username)
    {
        return RoomInput.NormalizeUsername(username);
    }

    private void SetPublicCount()
    {
        _roomManager.TryGetRoom(RoomManager.PublicRoomCode, out var publicRoom);
        var users = publicRoom?.Users.Values.ToList() ?? [];
        ViewBag.PublicCount = users.Count;
        ViewBag.PublicNames = users
            .Select(u => u.Username)
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Take(3)
            .ToList();
    }
}
