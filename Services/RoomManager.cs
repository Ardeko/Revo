using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR;
using RevoApp.Helpers;
using RevoApp.Hubs;
using RevoApp.Models;

namespace RevoApp.Services;

// Membership and the initial peer snapshot change together, so concurrent
// joins cannot both start a WebRTC offer for the same pair of participants.
public sealed class RoomManager
{
    private readonly object _sync = new();
    private readonly Dictionary<string, Room> _rooms = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _memberships = new(StringComparer.Ordinal);
    private readonly IHubContext<ChatHub> _hubContext;
    private readonly ILogger<RoomManager> _logger;
    private readonly TimeProvider _clock;

    public const string PublicRoomCode = "GENEL";
    public const int MaximumRooms = 256;
    public static readonly TimeSpan EmptyRoomLifetime = TimeSpan.FromMinutes(10);
    private const string CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public RoomManager(IHubContext<ChatHub> hubContext, ILogger<RoomManager> logger, TimeProvider? clock = null)
    {
        _hubContext = hubContext;
        _logger = logger;
        _clock = clock ?? TimeProvider.System;
        _rooms[PublicRoomCode] = new Room
        {
            Code = PublicRoomCode,
            Name = "Açık Frekans",
            IsPermanent = true
        };
    }

    public Room CreateRoom(string creatorConnectionId, string? password)
    {
        if (password?.Length > RoomInput.MaximumPasswordLength)
            throw new ArgumentException("Oda şifresi en fazla 128 karakter olabilir.", nameof(password));

        Room room;
        lock (_sync)
        {
            PruneEmptyRooms();
            if (_rooms.Count >= MaximumRooms)
                throw new InvalidOperationException("Şu an çok fazla oda açık. Biraz sonra tekrar dene.");
            string code;
            do { code = GenerateCode(); } while (_rooms.ContainsKey(code));
            room = new Room
            {
                Code = code, Name = code, CreatedByConnectionId = creatorConnectionId,
                CreatedAt = _clock.GetUtcNow().UtcDateTime, EmptySince = _clock.GetUtcNow(),
                PasswordHash = string.IsNullOrWhiteSpace(password) ? null : PasswordHelper.Hash(password)
            };
            _rooms.Add(code, room);
        }
        NotifyRoomsChanged();
        return room;
    }

    public bool TryGetRoom(string? code, out Room? room)
    {
        lock (_sync)
        {
            PruneEmptyRooms();
            return _rooms.TryGetValue(NormalizeCode(code), out room);
        }
    }

    public bool ValidatePassword(Room room, string? password) =>
        !room.HasPassword || (!string.IsNullOrEmpty(password)
            && password.Length <= RoomInput.MaximumPasswordLength
            && PasswordHelper.Verify(password, room.PasswordHash!));

    public RoomJoin? AddUser(Room room, string connectionId, string username, string? avatarUrl = null)
    {
        RoomJoin result;
        lock (_sync)
        {
            if (!_rooms.TryGetValue(room.Code, out var current) || !ReferenceEquals(current, room)) return null;
            if (_memberships.TryGetValue(connectionId, out var previousCode))
            {
                if (previousCode != room.Code) return null;
                return new RoomJoin(room.CreatedByConnectionId == connectionId, [], true);
            }
            var existingUsers = room.Users.Select(entry => new PeerSnapshot(
                entry.Key, entry.Value.Username, entry.Value.AvatarUrl,
                entry.Value.IsMuted, entry.Value.IsDeafened, entry.Value.IsCameraOn,
                entry.Value.IsScreenSharing, entry.Value.CameraStreamId, entry.Value.ScreenStreamId)).ToList();
            room.Users[connectionId] = new Participant(username, avatarUrl);
            _memberships[connectionId] = room.Code;
            room.EmptySince = null;
            if (string.IsNullOrEmpty(room.CreatedByConnectionId)) room.CreatedByConnectionId = connectionId;
            result = new RoomJoin(room.CreatedByConnectionId == connectionId, existingUsers, false);
        }
        NotifyRoomsChanged();
        return result;
    }

    public RoomDeparture RemoveUser(string connectionId)
    {
        RoomDeparture result;
        lock (_sync)
        {
            if (!_memberships.Remove(connectionId, out var roomCode)
                || !_rooms.TryGetValue(roomCode, out var room)
                || !room.Users.TryRemove(connectionId, out var participant))
                return new RoomDeparture(null, null, null);
            string? newModerator = null;
            if (room.CreatedByConnectionId == connectionId)
            {
                room.CreatedByConnectionId = room.Users.Keys.Order(StringComparer.Ordinal).FirstOrDefault() ?? "";
                newModerator = string.IsNullOrEmpty(room.CreatedByConnectionId) ? null : room.CreatedByConnectionId;
            }
            if (room.Users.IsEmpty) room.EmptySince = _clock.GetUtcNow();
            result = new RoomDeparture(room, participant.Username, newModerator);
        }
        NotifyRoomsChanged();
        return result;
    }

    public Room? GetRoomForConnection(string connectionId)
    {
        lock (_sync)
            return _memberships.TryGetValue(connectionId, out var code) ? _rooms.GetValueOrDefault(code) : null;
    }

    public bool ShareRoom(string sender, string target)
    {
        if (string.IsNullOrWhiteSpace(target) || target.Length > 128 || sender == target) return false;
        lock (_sync)
            return _memberships.TryGetValue(sender, out var senderRoom)
                && _memberships.TryGetValue(target, out var targetRoom) && senderRoom == targetRoom;
    }

    public IReadOnlyList<Room> GetActiveRooms()
    {
        lock (_sync)
        {
            PruneEmptyRooms();
            return _rooms.Values.OrderByDescending(room => room.IsPermanent)
                .ThenByDescending(room => room.Users.Count).ThenBy(room => room.CreatedAt).ToList();
        }
    }

    public IReadOnlyList<object> GetActiveRoomsSummary() => GetActiveRooms().Select(room => (object)new
    {
        code = room.Code, name = room.Name, userCount = room.Users.Count,
        hasPassword = room.HasPassword, isPermanent = room.IsPermanent
    }).ToList();

    private void PruneEmptyRooms()
    {
        var cutoff = _clock.GetUtcNow() - EmptyRoomLifetime;
        foreach (var room in _rooms.Values.Where(room => !room.IsPermanent && room.Users.IsEmpty
                     && room.EmptySince <= cutoff).ToList()) _rooms.Remove(room.Code);
    }

    private void NotifyRoomsChanged() => _ = BroadcastRoomsChangedAsync();

    private async Task BroadcastRoomsChangedAsync()
    {
        try { await _hubContext.Clients.All.SendAsync("RoomListChanged", GetActiveRoomsSummary()); }
        catch (Exception exception) { _logger.LogWarning(exception, "Oda listesi güncellenemedi."); }
    }

    public static string NormalizeCode(string? code) => code?.Trim().ToUpperInvariant() ?? "";

    private static string GenerateCode()
    {
        Span<char> buffer = stackalloc char[6];
        for (var i = 0; i < buffer.Length; i++) buffer[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)];
        return new string(buffer);
    }
}

public sealed record PeerSnapshot(string ConnectionId, string Username, string? AvatarUrl, bool Muted,
    bool Deafened, bool Camera, bool Screen, string? CameraStreamId, string? ScreenStreamId);
public sealed record RoomJoin(bool IsModerator, IReadOnlyList<PeerSnapshot> ExistingUsers, bool AlreadyJoined);
public sealed record RoomDeparture(Room? Room, string? Username, string? NewModeratorConnectionId);
