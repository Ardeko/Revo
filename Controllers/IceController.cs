using Microsoft.AspNetCore.Mvc;
using RevoApp.Services;

namespace RevoApp.Controllers;

/// <summary>
/// İstemci, RTCPeerConnection kurmadan önce buradan ICE sunucu listesini alır.
/// Kimlik bilgileri kısa ömürlüdür ve TURN anahtarının kendisi hiçbir zaman
/// tarayıcıya gitmez.
/// </summary>
[Route("ice")]
public class IceController : Controller
{
    private readonly TurnCredentialService _turn;

    public IceController(TurnCredentialService turn)
    {
        _turn = turn;
    }

    [HttpGet("servers")]
    public async Task<IActionResult> Servers(CancellationToken cancellationToken)
    {
        var json = await _turn.GetIceServersJsonAsync(cancellationToken);

        // Kimlik bilgileri kısa ömürlü — ara katmanların (CDN, proxy)
        // önbelleklemesini istemiyoruz.
        Response.Headers.CacheControl = "no-store";

        return Content(json, "application/json");
    }
}
