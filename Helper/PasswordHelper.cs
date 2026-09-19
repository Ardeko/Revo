using System;
using System.Security.Cryptography;

namespace RevoApp.Helpers
{
    // Oda şifreleri için basit ve bağımlılıksız bir hash mekanizması.
    // BCrypt/Identity paketi eklemeye gerek kalmasın diye .NET'in kendi
    // PBKDF2 implementasyonu (Rfc2898DeriveBytes) kullanılıyor.
    // Format: "{iterasyon}.{salt-base64}.{hash-base64}"
    public static class PasswordHelper
    {
        private const int SaltSize = 16;
        private const int HashSize = 32;
        private const int Iterations = 100_000;

        public static string Hash(string password)
        {
            var salt = RandomNumberGenerator.GetBytes(SaltSize);
            var hash = Rfc2898DeriveBytes.Pbkdf2(password, salt, Iterations, HashAlgorithmName.SHA256, HashSize);
            return $"{Iterations}.{Convert.ToBase64String(salt)}.{Convert.ToBase64String(hash)}";
        }

        public static bool Verify(string password, string storedHash)
        {
            var parts = storedHash.Split('.', 3);
            if (parts.Length != 3) return false;

            if (!int.TryParse(parts[0], out var iterations) || iterations is < 1 or > 1_000_000) return false;
            try
            {
                var salt = Convert.FromBase64String(parts[1]);
                var expectedHash = Convert.FromBase64String(parts[2]);
                if (salt.Length != SaltSize || expectedHash.Length != HashSize) return false;
                var actualHash = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, HashSize);
                return CryptographicOperations.FixedTimeEquals(actualHash, expectedHash);
            }
            catch (FormatException) { return false; }
        }
    }
}
