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
    private static readonly SemaphoreSlim CacheLock = new(1, 1);
    private static string? _cachedJson;
    private static DateTimeOffset _cachedUntil = DateTimeOffset.MinValue;

    private const int CredentialTtlSeconds = 6 * 60 * 60; // 6 saat
    private const int CacheSafetyMarginSeconds = 30 * 60; // bitmeden 30 dk önce yenile

    // TURN yapılandırılmamışsa buna düşüyoruz. Tek başına STUN çoğu bağlantıda
    // çalışır — sadece "her zaman" çalışmaz.
    private const string StunOnlyFallback =
        """{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478","stun:stun.l.google.com:19302"]}]}""";

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
            _logger.LogWarning(
                "TURN yapılandırılmamış (Turn:KeyId / Turn:ApiToken boş). " +
                "Sadece STUN kullanılacak — kısıtlı ağlardaki kullanıcılar bağlanamayabilir.");
            return StunOnlyFallback;
        }

        if (_cachedJson is not null && DateTimeOffset.UtcNow < _cachedUntil)
        {
            return _cachedJson;
        }

        await CacheLock.WaitAsync(cancellationToken);
        try
        {
            // Kilidi beklerken başka bir istek zaten yenilemiş olabilir.
            if (_cachedJson is not null && DateTimeOffset.UtcNow < _cachedUntil)
            {
                return _cachedJson;
            }

            var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);

            var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers")
            {
                Content = new StringContent(
                    JsonSerializer.Serialize(new { ttl = CredentialTtlSeconds }),
                    Encoding.UTF8,
                    "application/json")
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiToken);

            var response = await client.SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError(
                    "Cloudflare TURN kimlik bilgisi alınamadı ({Status}). STUN'a düşülüyor.",
                    (int)response.StatusCode);
                return StunOnlyFallback;
            }

            _cachedJson = body;
            _cachedUntil = DateTimeOffset.UtcNow.AddSeconds(CredentialTtlSeconds - CacheSafetyMarginSeconds);
            _logger.LogInformation("TURN kimlik bilgisi yenilendi, geçerlilik: {Until}", _cachedUntil);
            return body;
        }
        catch (Exception ex)
        {
            // Cloudflare'e ulaşamamak sohbeti tamamen engellememeli — STUN ile
            // devam et, kullanıcıların çoğu yine de bağlanır.
            _logger.LogError(ex, "TURN kimlik bilgisi alınırken hata. STUN'a düşülüyor.");
            return StunOnlyFallback;
        }
        finally
        {
            CacheLock.Release();
        }
    }
}
