using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using RevoApp.Helpers;
using RevoApp.Models;

namespace RevoApp.Services
{
    // Program.cs'de Singleton olarak kaydedilmeli:
    //   builder.Services.AddSingleton<RoomManager>();
    //
    // Basit tutmak için kalıcılık (DB) yok — process yeniden başladığında
    // odalar sıfırlanır. Kullanım senaryosu (anlık, kur-katıl-dağıt sohbet)
    // için bu kabul edilebilir; istenirse ileride Redis/DB'ye taşınabilir.
    public class RoomManager
    {
        private readonly ConcurrentDictionary<string, Room> _rooms = new();

        // Herkese açık, her zaman var olan sabit oda. Kod olarak kullanıcı
        // dostu, çakışma ihtimali olmayan bir değer seçildi.
        public const string PublicRoomCode = "GENEL";

        private static readonly char[] CodeAlphabet =
            "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray(); // karışabilecek 0/O, 1/I çıkarıldı

        public RoomManager()
        {
            EnsurePublicRoomExists();
        }

        private void EnsurePublicRoomExists()
        {
            _rooms[PublicRoomCode] = new Room
            {
                Code = PublicRoomCode,
                Name = "Açık Frekans",
                IsPermanent = true,
                PasswordHash = null
            };
        }

        public Room CreateRoom(string creatorConnectionId, string? password)
        {
            string code;
            do
            {
                code = GenerateCode();
            } while (_rooms.ContainsKey(code));

            var room = new Room
            {
                Code = code,
                Name = code,
                CreatedByConnectionId = creatorConnectionId,
                PasswordHash = string.IsNullOrWhiteSpace(password) ? null : PasswordHelper.Hash(password)
            };

            _rooms[code] = room;
            return room;
        }

        public bool TryGetRoom(string code, out Room? room) => _rooms.TryGetValue(NormalizeCode(code), out room);

        public bool ValidatePassword(Room room, string? suppliedPassword)
        {
            if (!room.HasPassword) return true;
            if (string.IsNullOrEmpty(suppliedPassword)) return false;
            return PasswordHelper.Verify(suppliedPassword, room.PasswordHash!);
        }

        // Kullanıcı bir odaya eklenirken çağrılır (Hub tarafından JoinRoom içinde).
        public void AddUser(Room room, string connectionId, string username)
        {
            room.Users[connectionId] = username;
        }

        // Aktif odaları listelemek için (Oda Listesi sayfasında kullanılır).
        // Genel Oda her zaman en başta, ardından en kalabalık oda üstte.
        public IReadOnlyList<Room> GetActiveRooms()
        {
            return _rooms.Values
                .OrderByDescending(r => r.IsPermanent)
                .ThenByDescending(r => r.Users.Count)
                .ThenBy(r => r.CreatedAt)
                .ToList();
        }

        // Bağlantı koptuğunda ya da kullanıcı odadan çıktığında çağrılır.
        // Oda boş kalırsa otomatik olarak silinir — Genel Oda gibi kalıcı
        // odalar bu kuraldan muaf, boş kalsa da listede durmaya devam eder.
        public (Room? room, string? username, bool roomDeleted) RemoveUser(string connectionId)
        {
            foreach (var kvp in _rooms)
            {
                var room = kvp.Value;
                if (room.Users.TryRemove(connectionId, out var username))
                {
                    var deleted = false;
                    if (room.Users.IsEmpty && !room.IsPermanent)
                    {
                        _rooms.TryRemove(room.Code, out _);
                        deleted = true;
                    }
                    return (room, username, deleted);
                }
            }
            return (null, null, false);
        }

        public Room? GetRoomForConnection(string connectionId)
        {
            foreach (var kvp in _rooms)
            {
                if (kvp.Value.Users.ContainsKey(connectionId))
                    return kvp.Value;
            }
            return null;
        }

        private static string NormalizeCode(string code) => code.Trim().ToUpperInvariant();

        private static string GenerateCode(int length = 6)
        {
            Span<char> buffer = stackalloc char[length];
            for (int i = 0; i < length; i++)
            {
                var index = RandomNumberGenerator.GetInt32(CodeAlphabet.Length);
                buffer[i] = CodeAlphabet[index];
            }
            return new string(buffer);
        }
    }
}
