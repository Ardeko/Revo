namespace RevoApp.Models
{
    // Bir odadaki tek bir katılımcı. AvatarUrl bir data URL (küçük JPEG) olarak
    // taşınır — diske yazılmaz. Mute / sağır / kamera / ekran alanları da
    // bellekte tutulur ki odaya sonradan katılan kişi ExistingUsers ile
    // doğru ikonları ve video eşlemesini alsın.
    public class Participant
    {
        public string Username { get; set; }
        public string? AvatarUrl { get; set; }
        public bool IsMuted { get; set; }
        public bool IsDeafened { get; set; }
        public bool IsCameraOn { get; set; }
        public bool IsScreenSharing { get; set; }
        public string? CameraStreamId { get; set; }
        public string? ScreenStreamId { get; set; }

        public Participant(string username, string? avatarUrl)
        {
            Username = username;
            AvatarUrl = avatarUrl;
        }
    }
}
