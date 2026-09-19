using Microsoft.AspNetCore.SignalR;
using RevoApp.Services;
using System;
using System.Linq;
using System.Threading.Tasks;

namespace RevoApp.Hubs
{
    public class ChatHub : Hub
    {
        private readonly RoomManager _roomManager;

        public ChatHub(RoomManager roomManager)
        {
            _roomManager = roomManager;
        }

        // İstemci artık hangi odaya gireceğini de belirtiyor. Şifre kontrolü
        // burada tekrar yapılıyor (Controller'daki kontrol sadece ilk yönlendirme
        // için — biri linki doğrudan paylaşıp Controller'ı atlayabilir, bu yüzden
        // gerçek erişim kontrolü Hub seviyesinde olmak zorunda).
        public async Task JoinRoom(string roomCode, string username, string? password, string? avatarUrl)
        {
            var normalizedUsername = RoomInput.NormalizeUsername(username);
            if (normalizedUsername is null)
            {
                await Clients.Caller.SendAsync("JoinError", "Lütfen bir kullanıcı adı girin.");
                return;
            }
            username = normalizedUsername;
            avatarUrl = RoomInput.NormalizeAvatar(avatarUrl);
            if (!_roomManager.TryGetRoom(roomCode, out var room) || room is null)
            {
                await Clients.Caller.SendAsync("JoinError", "Oda bulunamadı.");
                return;
            }

            if (!_roomManager.ValidatePassword(room, password))
            {
                await Clients.Caller.SendAsync("JoinError", "Şifre hatalı.");
                return;
            }

            roomCode = room.Code;
            var previousRoom = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (previousRoom is not null && previousRoom.Code != roomCode) await LeaveRoom();
            await Groups.AddToGroupAsync(Context.ConnectionId, roomCode);
            var join = _roomManager.AddUser(room, Context.ConnectionId, username, avatarUrl);
            if (join is null)
            {
                await Groups.RemoveFromGroupAsync(Context.ConnectionId, roomCode);
                await Clients.Caller.SendAsync("JoinError", "Oda artık kullanılamıyor. Tekrar katılmayı dene.");
                return;
            }

            // Oda az önce kurulduysa (Controller'da CreatedByConnectionId henüz
            // ConnectionId bilinmediği için boş bırakılmıştı) ilk katılan kişi
            // otomatik olarak moderatör kabul edilir.
            var isModerator = join.IsModerator;

            // Yeni katılana, kendisi hariç odada zaten bulunan herkesin listesini gönder.
            // WebRTC bağlantısını başlatma (offer gönderme) görevi HER ZAMAN yeni katılana
            // ait: böylece aynı çift için iki taraftan birden offer gönderilip
            // çakışması (glare) engellenmiş olur.
            var existingUsers = join.ExistingUsers;

            await Clients.Caller.SendAsync("JoinedRoom", roomCode, isModerator);
            if (join.AlreadyJoined) return;
            await Clients.Caller.SendAsync("ExistingUsers", existingUsers);
            // Oda rayının ilk açılışta boş kalmaması için güncel listeyi de yolla;
            // sonraki değişiklikler zaten RoomManager'dan herkese otomatik gidiyor.
            await Clients.Caller.SendAsync("RoomListChanged", _roomManager.GetActiveRoomsSummary());

            // Odadaki diğer herkese yeni katılımcıyı duyur (onlar bağlantı başlatmayacak,
            // sadece yeni kişinin offer'ını bekleyecekler).
            await Clients.OthersInGroup(roomCode).SendAsync("UserJoined", Context.ConnectionId, username, avatarUrl);
        }

        // Kullanıcı bağlantıyı koparmadan başka bir odaya geçmek istediğinde
        // çağrılır (oda rayından tıklayınca). Hemen ardından aynı bağlantı
        // üzerinden JoinRoom çağrılacağı için burada sadece eski odadan
        // temiz bir çıkış yapıyoruz.
        public async Task LeaveRoom()
        {
            var (room, username, newModerator) = _roomManager.RemoveUser(Context.ConnectionId);
            if (room is null) return;

            await Groups.RemoveFromGroupAsync(Context.ConnectionId, room.Code);
            if (username is not null)
            {
                await Clients.OthersInGroup(room.Code).SendAsync("UserLeft", Context.ConnectionId, username);
            }
            if (newModerator is not null)
                await Clients.Client(newModerator).SendAsync("JoinedRoom", room.Code, true);
        }

        // Metin mesajı gönderimi — artık sadece çağıranın odasına gidiyor.
        public async Task SendMessage(string message)
        {
            if (string.IsNullOrWhiteSpace(message)) return;
            if (message.Length > RoomInput.MaximumMessageLength)
                throw new HubException("Mesaj en fazla 2000 karakter olabilir.");
            message = message.Trim();
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;

            var username = room.Users.TryGetValue(Context.ConnectionId, out var participant) ? participant.Username : "Bilinmeyen";
            // connectionId'yi de yolluyoruz ki istemci avatarı her mesajda yeniden
            // göndermeden, zaten önbelleğe aldığı katılımcı listesinden çözebilsin.
            await Clients.Group(room.Code).SendAsync("ReceiveMessage", Context.ConnectionId, username, message);
        }

        public async Task Typing()
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;
            await Clients.OthersInGroup(room.Code).SendAsync("UserTyping", Context.ConnectionId);
        }

        // Mikrofon aç/kapa durumunu SADECE aynı odadaki diğerlerine bildir.
        public async Task ToggleMute(bool isMuted)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;
            if (room.Users.TryGetValue(Context.ConnectionId, out var participant))
            {
                participant.IsMuted = isMuted;
            }
            await Clients.OthersInGroup(room.Code).SendAsync("UserMuteChanged", Context.ConnectionId, isMuted);
        }

        public async Task ToggleDeafen(bool isDeafened)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;
            if (room.Users.TryGetValue(Context.ConnectionId, out var participant))
            {
                participant.IsDeafened = isDeafened;
                if (isDeafened) participant.IsMuted = true;
            }
            await Clients.OthersInGroup(room.Code).SendAsync("UserDeafenChanged", Context.ConnectionId, isDeafened);
        }

        public async Task ToggleCamera(bool isOn)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;
            if (room.Users.TryGetValue(Context.ConnectionId, out var participant))
            {
                participant.IsCameraOn = isOn;
                if (!isOn) participant.CameraStreamId = null;
            }
            await Clients.OthersInGroup(room.Code).SendAsync("UserCameraChanged", Context.ConnectionId, isOn);
        }

        public async Task ToggleScreenShare(bool isOn)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;
            if (room.Users.TryGetValue(Context.ConnectionId, out var participant))
            {
                participant.IsScreenSharing = isOn;
                if (!isOn) participant.ScreenStreamId = null;
            }
            await Clients.OthersInGroup(room.Code).SendAsync("UserScreenShareChanged", Context.ConnectionId, isOn);
        }

        // WebRTC MediaStream.id SDP içindeki msid ile karşı tarafta da aynı kalır.
        // Kamera ve ekran aynı anda iki video track'i olabildiği için hangisinin
        // hangisi olduğunu bu id üzerinden eşliyoruz.
        public async Task AnnounceMedia(string kind, string streamId)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;
            if (string.IsNullOrWhiteSpace(kind) || string.IsNullOrWhiteSpace(streamId) || streamId.Length > 128) return;

            kind = kind.Trim().ToLowerInvariant();
            if (kind is not ("camera" or "screen")) return;

            if (room.Users.TryGetValue(Context.ConnectionId, out var participant))
            {
                if (kind == "camera")
                {
                    participant.IsCameraOn = true;
                    participant.CameraStreamId = streamId;
                }
                else
                {
                    participant.IsScreenSharing = true;
                    participant.ScreenStreamId = streamId;
                }
            }

            await Clients.OthersInGroup(room.Code).SendAsync("UserMediaAnnounced", Context.ConnectionId, kind, streamId);
        }

        // Odayı kuran kişi, istenmeyen bir kullanıcıyı odadan atabilir.
        public async Task KickUser(string targetConnectionId)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;

            if (room.CreatedByConnectionId != Context.ConnectionId) return; // sadece kurucu atabilir
            if (targetConnectionId == Context.ConnectionId) return;

            if (room.Users.TryGetValue(targetConnectionId, out var targetParticipant))
            {
                _roomManager.RemoveUser(targetConnectionId);
                await Groups.RemoveFromGroupAsync(targetConnectionId, room.Code);
                await Clients.Client(targetConnectionId).SendAsync("KickedFromRoom");
                await Clients.Group(room.Code).SendAsync("UserLeft", targetConnectionId, targetParticipant.Username);
            }
        }

        // --- WebRTC sinyalleşmesi (değişmedi — zaten hedefe özel gönderiliyordu) ---

        public async Task SendOffer(string targetConnectionId, string offer)
        {
            if (!_roomManager.ShareRoom(Context.ConnectionId, targetConnectionId)) return;
            if (string.IsNullOrWhiteSpace(offer) || offer.Length > 64 * 1024) throw new HubException("Geçersiz bağlantı teklifi.");
            await Clients.Client(targetConnectionId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);
        }

        public async Task SendAnswer(string targetConnectionId, string answer)
        {
            if (!_roomManager.ShareRoom(Context.ConnectionId, targetConnectionId)) return;
            if (string.IsNullOrWhiteSpace(answer) || answer.Length > 64 * 1024) throw new HubException("Geçersiz bağlantı yanıtı.");
            await Clients.Client(targetConnectionId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);
        }

        public async Task SendICECandidate(string targetConnectionId, string candidate)
        {
            if (!_roomManager.ShareRoom(Context.ConnectionId, targetConnectionId)) return;
            if (string.IsNullOrWhiteSpace(candidate) || candidate.Length > 8 * 1024) throw new HubException("Geçersiz bağlantı adayı.");
            await Clients.Client(targetConnectionId).SendAsync("ReceiveICECandidate", Context.ConnectionId, candidate);
        }

        // Kullanıcının bağlantısı koptuğunda diğerlerine haber ver ki kendi
        // taraflarındaki peer connection'ı kapatıp arayüzden temizleyebilsinler.
        // Oda boş kalırsa RoomManager odayı otomatik siler.
        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            var (room, username, newModerator) = _roomManager.RemoveUser(Context.ConnectionId);
            if (room is not null && username is not null)
            {
                await Clients.OthersInGroup(room.Code).SendAsync("UserLeft", Context.ConnectionId, username);
                if (newModerator is not null)
                    await Clients.Client(newModerator).SendAsync("JoinedRoom", room.Code, true);
            }
            await base.OnDisconnectedAsync(exception);
        }
    }
}
