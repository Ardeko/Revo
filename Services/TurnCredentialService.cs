using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace RevoApp.Services;

/// <summary>
/// WebRTC'de iki taraf birbirine doğrudan bağlanmaya çalışır. STUN, tarafların
/// kendi dış IP'lerini öğrenmesini sağlar ve çoğu ev bağlantısında bu yeterlidir.
/// Ama simetrik NAT arkasındaki kullanıcılarda (bazı kurumsal ağlar, mobil
/// operatörler, çift NAT'lı bağlantılar, bazı kurumsal güvenlik duvarları)
/// doğrudan yol hiç kurulamaz — trafiğin bir aracıdan geçmesi gerekir. TURN
/// budur.
///
/// Odada 5-6 kişi varsa 15'e yakın ikili bağlantı kuruluyor demektir; içlerinden
/// EN AZ BİRİNİN doğrudan bağlanamama olasılığı tek ikiliye göre çok daha
/// yüksek. TURN olmadan "birimiz herkesi duyuyor ama diğeri duymuyor" tarzı
/// açıklanması zor arızalar kaçınılmaz hale gelir.
///
/// TURN anahtarı UZUN ÖMÜRLÜ bir sırdır ve asla tarayıcıya gönderilmemelidir;
/// eline geçen herkes senin kotandan trafik akıtabilir. Bu yüzden anahtar
/// sunucuda kalır ve her kullanıcı için kısa ömürlü kimlik bilgisi üretilir.
/// </summary>
public class TurnCredentialService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _config;
    private readonly ILogger<TurnCredentialService> _logger;

    // Cloudflare'in ürettiği kimlik bilgisi TTL süresince geçerli. Her sayfa
    // açılışında yeni istek atmak yerine sunucuda tutuyoruz — hem Cloudflare'e
    // gereksiz yük binmiyor hem odaya giriş hızlanıyor.
    private readonly SemaphoreSlim _cacheLock = new(1, 1);
    private string? _cachedJson;
    private DateTimeOffset _cachedUntil = DateTimeOffset.MinValue;
    private DateTimeOffset _credentialExpiresAt = DateTimeOffset.MinValue;
    private DateTimeOffset _retryAfter = DateTimeOffset.MinValue;
    private bool _warnedMissingConfiguration;

    private const int CredentialTtlSeconds = 6 * 60 * 60; // 6 saat
    private const int CacheSafetyMarginSeconds = 30 * 60; // bitmeden 30 dk önce yenile

    // TURN yapılandırılmamışsa buna düşüyoruz. Tek başına STUN çoğu bağlantıda
    // çalışır — sadece "her zaman" çalışmaz.
    private const string StunOnlyFallback =
        """{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478","stun:stun.l.google.com:19302"]}],"relayAvailable":false}""";

    public TurnCredentialService(
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<TurnCredentialService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _config = config;
        _logger = logger;
    }

    public async Task<string> GetIceServersJsonAsync(CancellationToken cancellationToken = default)
    {
        // Ortam değişkeni olarak: Turn__KeyId ve Turn__ApiToken
        // (Render'da Environment sekmesinden eklenecek.)
        var keyId = _config["Turn:KeyId"];
        var apiToken = _config["Turn:ApiToken"];

        if (string.IsNullOrWhiteSpace(keyId) || string.IsNullOrWhiteSpace(apiToken))
        {
            if (!_warnedMissingConfiguration)
            {
                _warnedMissingConfiguration = true;
                _logger.LogWarning("TURN yapılandırılmamış (Turn:KeyId / Turn:ApiToken boş). Kısıtlı ağlar için TURN gerekli.");
            }
            return StunOnlyFallback;
        }

        if (_cachedJson is not null && DateTimeOffset.UtcNow < _cachedUntil)
        {
            return _cachedJson;
        }

        await _cacheLock.WaitAsync(cancellationToken);
        try
        {
            // Kilidi beklerken başka bir istek zaten yenilemiş olabilir.
            if (_cachedJson is not null && DateTimeOffset.UtcNow < _cachedUntil)
            {
                return _cachedJson;
            }
            if (DateTimeOffset.UtcNow < _retryAfter) return ValidCachedCredentialsOrFallback();

            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);

            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"https://rtc.live.cloudflare.com/v1/turn/keys/{Uri.EscapeDataString(keyId)}/credentials/generate-ice-servers")
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new { ttl = CredentialTtlSeconds }),
                    Encoding.UTF8,
                    "application/json")
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiToken);

            using var response = await client.SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError(
                    "Cloudflare TURN kimlik bilgisi alınamadı ({Status}). STUN'a düşülüyor.",
                    (int)response.StatusCode);
                _retryAfter = DateTimeOffset.UtcNow.AddSeconds(30);
                return ValidCachedCredentialsOrFallback();
            }

            _credentialExpiresAt = DateTimeOffset.UtcNow.AddSeconds(CredentialTtlSeconds);
            _cachedJson = NormalizeIceServers(body, _credentialExpiresAt);
            _cachedUntil = DateTimeOffset.UtcNow.AddSeconds(CredentialTtlSeconds - CacheSafetyMarginSeconds);
            _logger.LogInformation("TURN kimlik bilgisi yenilendi, geçerlilik: {Until}", _cachedUntil);
            return _cachedJson;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            // Cloudflare'e ulaşamamak sohbeti tamamen engellememeli — STUN ile
            // devam et, kullanıcıların çoğu yine de bağlanır.
            _logger.LogError(ex, "TURN kimlik bilgisi alınırken hata. STUN'a düşülüyor.");
            _retryAfter = DateTimeOffset.UtcNow.AddSeconds(30);
            return ValidCachedCredentialsOrFallback();
        }
        finally
        {
            _cacheLock.Release();
        }
    }

    private string ValidCachedCredentialsOrFallback() =>
        _cachedJson is not null && DateTimeOffset.UtcNow < _credentialExpiresAt.AddMinutes(-1)
            ? _cachedJson : StunOnlyFallback;

    private static string NormalizeIceServers(string body, DateTimeOffset expiresAt)
    {
        using var document = JsonDocument.Parse(body);
        if (!document.RootElement.TryGetProperty("iceServers", out var input))
            throw new JsonException("TURN yanıtında iceServers alanı eksik.");
        var entries = input.ValueKind == JsonValueKind.Array ? input.EnumerateArray().ToArray() : [input];
        var servers = new List<object>();
        var relayAvailable = false;
        foreach (var entry in entries)
        {
            if (!entry.TryGetProperty("urls", out var urlsElement)) continue;
            var urls = urlsElement.ValueKind == JsonValueKind.Array
                ? urlsElement.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.String).Select(value => value.GetString()!).ToArray()
                : urlsElement.ValueKind == JsonValueKind.String ? [urlsElement.GetString()!] : [];
            // Browsers block port 53. Cloudflare also provides 3478 and 443.
            urls = urls.Where(url => (url.StartsWith("stun:", StringComparison.OrdinalIgnoreCase)
                    || url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase)
                    || url.StartsWith("turns:", StringComparison.OrdinalIgnoreCase))
                && !System.Text.RegularExpressions.Regex.IsMatch(url, @":53(?:\?|$)")).ToArray();
            if (urls.Length == 0) continue;
            var username = entry.TryGetProperty("username", out var user) && user.ValueKind == JsonValueKind.String ? user.GetString() : null;
            var credential = entry.TryGetProperty("credential", out var secret) && secret.ValueKind == JsonValueKind.String ? secret.GetString() : null;
            var hasRelay = urls.Any(url => url.StartsWith("turn:", StringComparison.OrdinalIgnoreCase)
                || url.StartsWith("turns:", StringComparison.OrdinalIgnoreCase));
            if (hasRelay && (string.IsNullOrEmpty(username) || string.IsNullOrEmpty(credential))) continue;
            relayAvailable |= hasRelay;
            servers.Add(new { urls, username, credential });
        }
        if (!relayAvailable) throw new JsonException("TURN yanıtında kullanılabilir röle bulunamadı.");
        return JsonSerializer.Serialize(new { iceServers = servers, relayAvailable, expiresAt });
    }
}
