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
        public async Task JoinRoom(string roomCode, string username, string? password)
        {
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

            await Groups.AddToGroupAsync(Context.ConnectionId, roomCode);
            _roomManager.AddUser(room, Context.ConnectionId, username);

            // Oda az önce kurulduysa (Controller'da CreatedByConnectionId henüz
            // ConnectionId bilinmediği için boş bırakılmıştı) ilk katılan kişi
            // otomatik olarak moderatör kabul edilir.
            if (string.IsNullOrEmpty(room.CreatedByConnectionId))
            {
                room.CreatedByConnectionId = Context.ConnectionId;
            }

            var isModerator = room.CreatedByConnectionId == Context.ConnectionId;

            // Yeni katılana, kendisi hariç odada zaten bulunan herkesin listesini gönder.
            // WebRTC bağlantısını başlatma (offer gönderme) görevi HER ZAMAN yeni katılana
            // ait: böylece aynı çift için iki taraftan birden offer gönderilip
            // çakışması (glare) engellenmiş olur.
            var existingUsers = room.Users
                .Where(kvp => kvp.Key != Context.ConnectionId)
                .Select(kvp => new { connectionId = kvp.Key, username = kvp.Value })
                .ToList();

            await Clients.Caller.SendAsync("JoinedRoom", roomCode, isModerator);
            await Clients.Caller.SendAsync("ExistingUsers", existingUsers);

            // Odadaki diğer herkese yeni katılımcıyı duyur (onlar bağlantı başlatmayacak,
            // sadece yeni kişinin offer'ını bekleyecekler).
            await Clients.OthersInGroup(roomCode).SendAsync("UserJoined", Context.ConnectionId, username);
        }

        // Metin mesajı gönderimi — artık sadece çağıranın odasına gidiyor.
        public async Task SendMessage(string message)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;

            var username = room.Users.TryGetValue(Context.ConnectionId, out var name) ? name : "Bilinmeyen";
            await Clients.Group(room.Code).SendAsync("ReceiveMessage", username, message);
        }

        // Mikrofon aç/kapa durumunu SADECE aynı odadaki diğerlerine bildir.
        public async Task ToggleMute(bool isMuted)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;

            await Clients.OthersInGroup(room.Code).SendAsync("UserMuteChanged", Context.ConnectionId, isMuted);
        }

        // Odayı kuran kişi, istenmeyen bir kullanıcıyı odadan atabilir.
        public async Task KickUser(string targetConnectionId)
        {
            var room = _roomManager.GetRoomForConnection(Context.ConnectionId);
            if (room is null) return;

            if (room.CreatedByConnectionId != Context.ConnectionId) return; // sadece kurucu atabilir

            if (room.Users.TryGetValue(targetConnectionId, out var targetUsername))
            {
                await Clients.Client(targetConnectionId).SendAsync("KickedFromRoom");
                await Groups.RemoveFromGroupAsync(targetConnectionId, room.Code);
                room.Users.TryRemove(targetConnectionId, out _);
                await Clients.Group(room.Code).SendAsync("UserLeft", targetConnectionId, targetUsername);
            }
        }

        // --- WebRTC sinyalleşmesi (değişmedi — zaten hedefe özel gönderiliyordu) ---

        public async Task SendOffer(string targetConnectionId, string offer)
        {
            await Clients.Client(targetConnectionId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);
        }

        public async Task SendAnswer(string targetConnectionId, string answer)
        {
            await Clients.Client(targetConnectionId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);
        }

        public async Task SendICECandidate(string targetConnectionId, string candidate)
        {
            await Clients.Client(targetConnectionId).SendAsync("ReceiveICECandidate", Context.ConnectionId, candidate);
        }

        // Kullanıcının bağlantısı koptuğunda diğerlerine haber ver ki kendi
        // taraflarındaki peer connection'ı kapatıp arayüzden temizleyebilsinler.
        // Oda boş kalırsa RoomManager odayı otomatik siler.
        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            var (room, username, _) = _roomManager.RemoveUser(Context.ConnectionId);
            if (room is not null && username is not null)
            {
                await Clients.OthersInGroup(room.Code).SendAsync("UserLeft", Context.ConnectionId, username);
            }
            await base.OnDisconnectedAsync(exception);
        }
    }
}
