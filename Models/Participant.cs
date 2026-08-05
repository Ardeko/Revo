namespace RevoApp.Models
{
    // Bir odadaki tek bir katılımcıyı temsil eder: görünen ad + (varsa) profil
    // resmi. AvatarUrl bir data URL (base64 gömülü küçük JPEG) olarak taşınır —
    // sunucuda diske ya da veritabanına hiç yazılmaz, RoomManager'ın geri
    // kalanıyla aynı "kalıcılık yok, sadece bellekte" felsefesine uyar.
    public record Participant(string Username, string? AvatarUrl);
}
