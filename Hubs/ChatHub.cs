using Microsoft.AspNetCore.SignalR;
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading.Tasks;

namespace RevoApp.Hubs
{
    public class ChatHub : Hub
    {
        // ConnectionId -> kullanıcı adı eşlemesi.
        // Şu an tek paylaşımlı oda olduğu için tüm bağlantılar aynı sözlükte tutuluyor.
        // İleride birden fazla bağımsız oda istenirse, bu sözlük oda adına göre
        // ayrı sözlüklere (veya SignalR Groups'a) bölünebilir.
        private static readonly ConcurrentDictionary<string, string> _users = new();

        // İstemci SignalR bağlantısı kurulduktan hemen sonra bunu çağırır.
        public async Task JoinRoom(string username)
        {
            _users[Context.ConnectionId] = username;

            // Yeni katılana, kendisi hariç odada zaten bulunan herkesin listesini gönder.
            // WebRTC bağlantısını başlatma (offer gönderme) görevi HER ZAMAN yeni katılana
            // ait: böylece aynı çift için iki taraftan birden offer gönderilip
            // çakışması (glare) engellenmiş olur.
            var existingUsers = _users
                .Where(kvp => kvp.Key != Context.ConnectionId)
                .Select(kvp => new { connectionId = kvp.Key, username = kvp.Value })
                .ToList();

            await Clients.Caller.SendAsync("ExistingUsers", existingUsers);

            // Odadaki diğer herkese yeni katılımcıyı duyur (onlar bağlantı başlatmayacak,
            // sadece yeni kişinin offer'ını bekleyecekler).
            await Clients.Others.SendAsync("UserJoined", Context.ConnectionId, username);
        }

        // Metin mesajı gönderimi (herkese). Kullanıcı adı istemciden değil,
        // sunucunun tuttuğu bağlantı sözlüğünden okunur; böylece biri başka
        // birinin adını taklit ederek mesaj gönderemez.
        public async Task SendMessage(string message)
        {
            var username = _users.TryGetValue(Context.ConnectionId, out var name) ? name : "Bilinmeyen";
            await Clients.All.SendAsync("ReceiveMessage", username, message);
        }

        // Mikrofon aç/kapa durumunu odadaki diğerlerine bildir (UI'da göstermek için).
        public async Task ToggleMute(bool isMuted)
        {
            await Clients.Others.SendAsync("UserMuteChanged", Context.ConnectionId, isMuted);
        }

        // --- WebRTC sinyalleşmesi ---
        // ÖNEMLİ FARK: Bunlar artık Clients.All yerine SADECE hedef bağlantıya
        // (targetConnectionId) gönderiliyor. Eskiden herkese broadcast edildiği için,
        // 3. kişi odaya girdiğinde offer/answer/ICE mesajları birbirine karışıyor ve
        // istemcideki tek bir "peerConnection" nesnesi aynı anda birden fazla kişiyle
        // eşleşmeye çalışıyordu. Şimdi her mesaj yalnızca ilgili hedefe ulaşıyor.

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

        // Kullanıcının bağlantısı koptuğunda (sekme kapatma, ağ kopması vb.)
        // diğerlerine haber ver ki kendi taraflarındaki peer connection'ı kapatıp
        // arayüzden temizleyebilsinler. Eskiden bu hiç yapılmıyordu; bu yüzden
        // ayrılan kişiler "hayalet" bağlantı olarak kalabiliyordu.
        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            if (_users.TryRemove(Context.ConnectionId, out var username))
            {
                await Clients.Others.SendAsync("UserLeft", Context.ConnectionId, username);
            }
            await base.OnDisconnectedAsync(exception);
        }
    }
}
