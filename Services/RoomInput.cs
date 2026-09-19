namespace RevoApp.Services;

public static class RoomInput
{
    public const int MaximumUsernameLength = 24;
    public const int MaximumPasswordLength = 128;
    public const int MaximumMessageLength = 2000;
    public const int MaximumAvatarLength = 96 * 1024;

    public static string? NormalizeUsername(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var username = new string(value.Where(character => !char.IsControl(character)).ToArray()).Trim();
        if (username.Length == 0) return null;
        if (username.Length <= MaximumUsernameLength) return username;
        var length = char.IsHighSurrogate(username[MaximumUsernameLength - 1])
            ? MaximumUsernameLength - 1 : MaximumUsernameLength;
        return username[..length];
    }

    public static string? NormalizeAvatar(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > MaximumAvatarLength) return null;
        // Profiles are local thumbnails; never request arbitrary remote URLs.
        var separator = value.IndexOf(',');
        if (separator < 0 || value[..separator] is not
            ("data:image/jpeg;base64" or "data:image/png;base64" or "data:image/webp;base64")) return null;
        var encoded = value.AsSpan(separator + 1);
        var bytes = new byte[encoded.Length];
        return Convert.TryFromBase64Chars(encoded, bytes, out var written) && written > 0 ? value : null;
    }
}
