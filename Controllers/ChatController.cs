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
        return View();
    }

    // Not: Hub tarafında da şifre kontrolü tekrarlanıyor (bkz. ChatHub.JoinRoom).
    // Buradaki kontrol sadece kullanıcıya erken, sayfa yenilemeden geri bildirim
    // vermek için — asıl güvenlik sınırı Hub'da.
    [HttpPost]
    public IActionResult CreateRoom(string username, string? password)
    {
        username = NormalizeUsername(username);
        if (username is null)
        {
            ModelState.AddModelError("", "Lütfen bir kullanıcı adı girin.");
            return View("Login");
        }

        // Kurucunun SignalR ConnectionId'si burada henüz yok (Hub bağlantısı
        // sayfa yüklendikten sonra client tarafında kurulacak). Bu yüzden
        // "kurucu" bilgisi ilk JoinRoom çağrısında Hub içinde belirlenir —
        // orada odayı YENİ oluşturan kullanıcı otomatik moderatör kabul edilmez,
        // bunun yerine CreateRoom burada odayı yaratıp CreatedByConnectionId'yi
        // boş bırakır, Hub ilk katılan kişiyi (ki bu kurucudur) moderatör atar.
        var room = _roomManager.CreateRoom(creatorConnectionId: "", password);

        // Şifreyi URL'e koymadan Index'e taşımak için TempData kullanılıyor —
        // tek bir redirect boyunca yaşar, Index içinde okunur okunmaz silinir.
        // Index sayfası bunu SignalR'ın JoinRoom çağrısına gömecek (bkz. Index.cshtml).
        TempData["RoomPassword"] = password;

        return RedirectToAction("Index", new { username, room = room.Code });
    }

    [HttpPost]
    public IActionResult JoinRoom(string username, string roomCode, string? password)
    {
        username = NormalizeUsername(username);
        if (username is null)
        {
            ModelState.AddModelError("", "Lütfen bir kullanıcı adı girin.");
            return View("Login");
        }

        if (string.IsNullOrWhiteSpace(roomCode) || !_roomManager.TryGetRoom(roomCode, out var room) || room is null)
        {
            ModelState.AddModelError("", "Oda bulunamadı.");
            ViewBag.PrefilledRoomCode = roomCode;
            return View("Login");
        }

        if (!_roomManager.ValidatePassword(room, password))
        {
            ModelState.AddModelError("", "Şifre hatalı.");
            ViewBag.PrefilledRoomCode = roomCode;
            return View("Login");
        }

        TempData["RoomPassword"] = password;

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

        if (!_roomManager.TryGetRoom(room, out _))
            return RedirectToAction("Login");

        ViewBag.Username = username;
        ViewBag.RoomCode = room;
        // TempData bir kez okunduğunda otomatik temizlenir — sayfa yenilendiğinde
        // (F5) burası null gelir, bu durumu Index.cshtml tarafında "JoinError" ile
        // ele alıp kullanıcıyı Login'e (kod önceden dolu) geri yönlendiriyoruz.
        ViewBag.RoomPassword = TempData["RoomPassword"] as string;
        return View();
    }

    private static string? NormalizeUsername(string? username)
    {
        username = username?.Trim();
        if (string.IsNullOrWhiteSpace(username)) return null;

        // Nick'i arayüzü bozmayacak makul bir uzunlukta tut.
        if (username.Length > 24)
            username = username.Substring(0, 24);

        return username;
    }
}
