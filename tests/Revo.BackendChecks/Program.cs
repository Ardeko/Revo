using System.Collections.Concurrent;
using System.Net;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using RevoApp.Helpers;
using RevoApp.Hubs;
using RevoApp.Services;

var passed = 0;
await Check("Room membership, moderator transfer, reconnect grace and expiry", () =>
{
    var fixture = new Fixture();
    var room = fixture.Rooms.CreateRoom("", "correct password");
    Assert(!fixture.Rooms.ValidatePassword(room, "wrong"), "Wrong password accepted");
    Assert(fixture.Rooms.ValidatePassword(room, "correct password"), "Correct password rejected");
    Assert(fixture.Rooms.TryGetRoom("  " + room.Code.ToLowerInvariant() + " ", out _), "Room code was not normalized");
    var first = fixture.Rooms.AddUser(room, "a", "Ada")!;
    var second = fixture.Rooms.AddUser(room, "b", "Bora")!;
    Assert(first.IsModerator && first.ExistingUsers.Count == 0, "Initial join is inconsistent");
    Assert(second.ExistingUsers.Single().ConnectionId == "a", "Second peer did not receive first peer");
    Assert(fixture.Rooms.AddUser(room, "a", "Ada")!.AlreadyJoined, "Repeated join is not idempotent");
    Assert(fixture.Rooms.ShareRoom("a", "b"), "Peers in one room cannot signal");
    Assert(!fixture.Rooms.ShareRoom("a", "a"), "Self signaling accepted");
    var departure = fixture.Rooms.RemoveUser("a");
    Assert(departure.NewModeratorConnectionId == "b", "Moderator was not transferred");
    fixture.Rooms.RemoveUser("b");
    Assert(fixture.Rooms.TryGetRoom(room.Code, out _), "Last disconnect destroyed room before reconnect");
    Assert(fixture.Rooms.AddUser(room, "c", "Cem")!.IsModerator, "Reconnected room has no moderator");
    fixture.Rooms.RemoveUser("c");
    fixture.Clock.Advance(RoomManager.EmptyRoomLifetime + TimeSpan.FromSeconds(1));
    Assert(!fixture.Rooms.TryGetRoom(room.Code, out _), "Unused room was not expired");
    Assert(fixture.Rooms.TryGetRoom(RoomManager.PublicRoomCode, out _), "Public room expired");
    return Task.CompletedTask;
});

await Check("Concurrent joins assign exactly one offer initiator per peer pair", () =>
{
    var fixture = new Fixture();
    var room = fixture.Rooms.CreateRoom("", null);
    var joins = new ConcurrentDictionary<string, RoomJoin>();
    Parallel.For(0, 24, index => joins[index.ToString()] = fixture.Rooms.AddUser(room, index.ToString(), "Peer " + index)!);
    Assert(joins.Values.Count(join => join.IsModerator) == 1, "Concurrent joins created multiple moderators");
    foreach (var first in joins.Keys)
        foreach (var second in joins.Keys.Where(key => string.CompareOrdinal(key, first) > 0))
            Assert(joins[first].ExistingUsers.Any(peer => peer.ConnectionId == second)
                != joins[second].ExistingUsers.Any(peer => peer.ConnectionId == first), "Peer pair has zero or two offer initiators");
    return Task.CompletedTask;
});

await Check("Hub canonical groups, room switch, validation and cross-room signaling", async () =>
{
    var fixture = new Fixture();
    var firstRoom = fixture.Rooms.CreateRoom("", null);
    var secondRoom = fixture.Rooms.CreateRoom("", "secret");
    var ada = fixture.Hub("a");
    var bora = fixture.Hub("b");
    var cem = fixture.Hub("c");
    await ada.JoinRoom(firstRoom.Code.ToLowerInvariant(), "  Ada\n  ", null, "https://tracking.example/avatar.png");
    Assert(fixture.Groups.Added.Contains(("a", firstRoom.Code)), "Group code was not canonicalized");
    Assert(firstRoom.Users["a"].Username == "Ada" && firstRoom.Users["a"].AvatarUrl is null, "Hub bypasses input validation");
    await bora.JoinRoom(firstRoom.Code, "Bora", null, null);
    await cem.JoinRoom(secondRoom.Code, "Cem", "secret", null);
    fixture.Clients.Events.Clear();
    await ada.SendOffer("c", "offer");
    await ada.SendAnswer("c", "answer");
    await ada.SendICECandidate("c", "candidate");
    Assert(fixture.Clients.Events.Count == 0, "Signaling escaped the caller's room");
    await ada.SendOffer("b", "offer");
    Assert(fixture.Clients.Events.Single().Method == "ReceiveOffer", "Same-room signaling was blocked");
    await ada.JoinRoom(secondRoom.Code, "Ada", "wrong", null);
    Assert(fixture.Rooms.GetRoomForConnection("a") == firstRoom, "Rejected join lost existing membership");
    await ada.JoinRoom(secondRoom.Code, "Ada", "secret", null);
    Assert(!firstRoom.Users.ContainsKey("a") && secondRoom.Users.ContainsKey("a"), "Room switch leaked membership");
    Assert(fixture.Groups.Removed.Contains(("a", firstRoom.Code)), "Old SignalR group leaked");
    fixture.Clients.Events.Clear();
    await ada.JoinRoom(secondRoom.Code, "Ada", "secret", null);
    Assert(!fixture.Clients.Events.Any(item => item.Method is "ExistingUsers" or "UserJoined"), "Repeated join renegotiated every peer");
    await Throws<HubException>(() => ada.SendMessage(new string('a', 2001)));
    await cem.KickUser("a");
    Assert(fixture.Rooms.GetRoomForConnection("a") is null, "Kicked user kept room membership");
    fixture.Clients.Events.Clear();
    await ada.SendOffer("c", "offer");
    Assert(fixture.Clients.Events.Count == 0, "Kicked user can still signal");
});

await Check("TURN normalization, instance cache, safe fallback and failure backoff", async () =>
{
    const string payload = """{"iceServers":{"urls":["stun:stun.cloudflare.com:3478","turn:turn.cloudflare.com:53?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"temporary-user","credential":"temporary-pass"}}""";
    var transport = new StubHttp(HttpStatusCode.OK, payload);
    var turn = MakeTurn(transport);
    var json = await turn.GetIceServersJsonAsync();
    using var parsed = JsonDocument.Parse(json);
    Assert(parsed.RootElement.GetProperty("relayAvailable").GetBoolean(), "Valid TURN marked unavailable");
    Assert(parsed.RootElement.GetProperty("iceServers")[0].GetProperty("urls").GetArrayLength() == 2, "Blocked port 53 was retained");
    await turn.GetIceServersJsonAsync();
    Assert(transport.Calls == 1, "TURN credential cache missed");
    var failing = new StubHttp(HttpStatusCode.ServiceUnavailable, "upstream failure");
    var otherTurn = MakeTurn(failing);
    var fallback = await otherTurn.GetIceServersJsonAsync();
    await otherTurn.GetIceServersJsonAsync();
    Assert(failing.Calls == 1, "TURN failure did not back off");
    Assert(!JsonDocument.Parse(fallback).RootElement.GetProperty("relayAvailable").GetBoolean(), "Service instances leaked cached credentials");
    var malformed = MakeTurn(new StubHttp(HttpStatusCode.OK, "{\"iceServers\":[]} "));
    Assert(!JsonDocument.Parse(await malformed.GetIceServersJsonAsync()).RootElement.GetProperty("relayAvailable").GetBoolean(), "Malformed upstream JSON exposed as valid ICE config");
    using var canceled = new CancellationTokenSource();
    canceled.Cancel();
    await Throws<OperationCanceledException>(() => otherTurn.GetIceServersJsonAsync(canceled.Token));
});

await Check("Malformed password hashes and avatar limits fail closed", () =>
{
    Assert(!PasswordHelper.Verify("password", "bad.hash.content"), "Malformed hash accepted");
    Assert(!PasswordHelper.Verify("password", "999999999.AA==.AA=="), "Unsafe iteration count accepted");
    Assert(RoomInput.NormalizeAvatar("data:image/svg+xml;base64,PHN2Zz4=") is null, "SVG avatar accepted");
    Assert(RoomInput.NormalizeAvatar("data:image/png;base64,invalid") is null, "Malformed base64 accepted");
    Assert(RoomInput.NormalizeAvatar("data:image/png;base64,AA==") is not null, "Valid thumbnail rejected");
    Assert(RoomInput.NormalizeUsername(new string('x', 23) + "😀")!.Length == 23, "Username truncation split a surrogate pair");
    return Task.CompletedTask;
});

Console.WriteLine($"Backend checks passed: {passed}/5");
return;

async Task Check(string name, Func<Task> check)
{
    await check();
    passed++;
    Console.WriteLine("PASS " + name);
}
static void Assert(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
static async Task Throws<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T) { return; }
    throw new InvalidOperationException("Expected " + typeof(T).Name);
}
static TurnCredentialService MakeTurn(StubHttp transport) => new(transport,
    new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
    { ["Turn:KeyId"] = "test-key", ["Turn:ApiToken"] = "test-token" }).Build(), NullLogger<TurnCredentialService>.Instance);

sealed class Fixture
{
    public readonly RecordingClients Clients = new();
    public readonly RecordingGroups Groups = new();
    public readonly ManualClock Clock = new();
    public RoomManager Rooms { get; }
    public Fixture() => Rooms = new RoomManager(new FakeHubContext(Clients, Groups), NullLogger<RoomManager>.Instance, Clock);
    public ChatHub Hub(string id) => new(Rooms) { Clients = Clients, Groups = Groups, Context = new FakeCaller(id) };
}
sealed class ManualClock : TimeProvider
{
    private DateTimeOffset _now = DateTimeOffset.UtcNow;
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan interval) => _now += interval;
}
sealed class FakeHubContext(RecordingClients clients, RecordingGroups groups) : IHubContext<ChatHub>
{
    public IHubClients Clients => clients;
    public IGroupManager Groups => groups;
}
sealed class FakeCaller(string id) : HubCallerContext
{
    public override string ConnectionId => id;
    public override string? UserIdentifier => null;
    public override ClaimsPrincipal? User => null;
    public override IDictionary<object, object?> Items { get; } = new Dictionary<object, object?>();
    public override IFeatureCollection Features { get; } = new FeatureCollection();
    public override CancellationToken ConnectionAborted => CancellationToken.None;
    public override void Abort() { }
}
sealed class RecordingGroups : IGroupManager
{
    public readonly List<(string Connection, string Group)> Added = [];
    public readonly List<(string Connection, string Group)> Removed = [];
    public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default)
    { Added.Add((connectionId, groupName)); return Task.CompletedTask; }
    public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default)
    { Removed.Add((connectionId, groupName)); return Task.CompletedTask; }
}
sealed class RecordingClients : IHubCallerClients, IHubClients
{
    public readonly ConcurrentBag<(string Target, string Method, object?[] Arguments)> Events = [];
    private IClientProxy Proxy(string target) => new Recorder(target, Events);
    public IClientProxy Caller => Proxy("caller");
    public IClientProxy Others => Proxy("others");
    public IClientProxy All => Proxy("all");
    public IClientProxy AllExcept(IReadOnlyList<string> excludedConnectionIds) => Proxy("all-except");
    public IClientProxy Client(string connectionId) => Proxy(connectionId);
    public IClientProxy Clients(IReadOnlyList<string> connectionIds) => Proxy("clients");
    public IClientProxy Group(string groupName) => Proxy("group:" + groupName);
    public IClientProxy Groups(IReadOnlyList<string> groupNames) => Proxy("groups");
    public IClientProxy GroupExcept(string groupName, IReadOnlyList<string> excludedConnectionIds) => Proxy("group-except:" + groupName);
    public IClientProxy OthersInGroup(string groupName) => Proxy("others:" + groupName);
    public IClientProxy User(string userId) => Proxy("user:" + userId);
    public IClientProxy Users(IReadOnlyList<string> userIds) => Proxy("users");
}
sealed class Recorder(string target, ConcurrentBag<(string Target, string Method, object?[] Arguments)> events) : IClientProxy
{
    public Task SendCoreAsync(string method, object?[] args, CancellationToken cancellationToken = default)
    { events.Add((target, method, args)); return Task.CompletedTask; }
}
sealed class StubHttp(HttpStatusCode status, string body) : HttpMessageHandler, IHttpClientFactory
{
    public int Calls { get; private set; }
    public HttpClient CreateClient(string name) => new(this, disposeHandler: false);
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Calls++;
        return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body) });
    }
}
