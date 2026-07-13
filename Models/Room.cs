using System;
using System.Collections.Concurrent;

namespace RevoApp.Models
{
    // Bir sohbet odasını temsil eder. Artık tek global oda yerine
    // her oda kendi kodu, kendi kullanıcı listesi ve (opsiyonel) şifresiyle
    // bağımsız bir SignalR grubu olarak yaşıyor.
    public class Room
    {
        // Kullanıcıların paylaşacağı kısa kod (URL'de ve giriş formunda kullanılır).
        public string Code { get; set; } = string.Empty;

        // Görünen ad — normal odalarda Code ile aynı, Genel Oda gibi sabit
        // odalarda daha okunaklı bir isim olabilir ("Genel Oda").
        public string Name { get; set; } = string.Empty;

        // Kalıcı odalar (şu an sadece Genel Oda) boş kalsa bile silinmez.
        public bool IsPermanent { get; set; }

        // Şifre yoksa null. Asla düz metin saklanmaz — sadece hash.
        public string? PasswordHash { get; set; }

        public bool HasPassword => !string.IsNullOrEmpty(PasswordHash);

        // Odayı kuran bağlantı — moderatör yetkisi (kick) buna bakılarak veriliyor.
        // Not: kurucu ayrılırsa yetki kimseye devredilmiyor (basit tutuldu);
        // istenirse "ilk kalan kullanıcıya devret" mantığı sonradan eklenebilir.
        public string CreatedByConnectionId { get; set; } = string.Empty;

        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

        // ConnectionId -> kullanıcı adı. Oda bazlı olduğu için artık
        // ChatHub'daki eski global sözlüğün yerini bu alıyor.
        public ConcurrentDictionary<string, string> Users { get; } = new();
    }
}
