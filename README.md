# REVO

ASP.NET Core 10 + SignalR + WebRTC ile Türkçe sesli ve yazılı sohbet. Windows masaüstü istemcisi Photino/WebView2 kullanır. Ses ve görüntü WebRTC üzerinden katılımcılar arasında iletilir; SignalR oda ve bağlantı sinyalleşmesini yönetir.

## Yerel çalıştırma

.NET 10 SDK gereklidir. Proje dizininde:

```powershell
dotnet run --no-launch-profile -- --web --urls http://127.0.0.1:5187
```

Tarayıcıda `http://127.0.0.1:5187` adresini açın. Mikrofon ve AudioWorklet için localhost veya HTTPS gerekir.

Masaüstü penceresini yerel sunucuya bağlamak için ikinci terminalde:

```powershell
dotnet run --no-launch-profile -- --server=http://127.0.0.1:5187
```

Parametresiz Windows uygulaması `Program.cs` içindeki uzak sunucuya bağlanır. Kaynak kodda yapılan değişiklikler kurulu uygulamanın bağlandığı uzak sunucuya otomatik yüklenmez. Masaüstü istemcilerine yeni arayüz ve ses motorunun ulaşması için web sunucusunun yeni sürümle yayımlanması gerekir.

## Ses davranışı

- RNNoise, 48 kHz AudioWorklet hattında çalışır. Kullanılabilir değilse tarayıcının gürültü engellemesine geri dönülür; aktif işlem durumu ayarlarda gösterilir.
- Yankı iptali, otomatik kazanç, mikrofon kazancı, giriş hassasiyeti, bas-konuş, giriş/çıkış aygıtı ve dinleme seviyesi ayrı ayarlardır.
- Mikrofon testi kulaklıkla kullanılmalıdır. Seçilen çıkış aygıtını değiştirmek tarayıcının `setSinkId` desteğine bağlıdır.
- Bas-konuş ve klavye kısayolları uygulama odaktayken çalışır; sistem genelinde kısayol değildir.
- Tarayıcı testleri sanal mikrofon/kamera kullanır. Fiziksel mikrofon, klavye/fan gürültüsü, Bluetooth aygıtı ve farklı ağlar gerçek donanımda ayrıca denenmelidir.

## TURN ve dağıtım

Kısıtlı ağlar veya bazı mobil bağlantılar için TURN gerekir. Cloudflare TURN kimlik bilgilerini yalnızca sunucu ortamında tanımlayın:

```text
Turn__KeyId=<TURN key id>
Turn__ApiToken=<API token>
```

`/ice/servers` kısa ömürlü ICE yapılandırmasını döndürür. Ana API tokenı istemciye gönderilmez. TURN yapılandırılmadığında STUN kullanılır; bu durumda tüm ağlarda bağlantı garantisi yoktur.

```powershell
dotnet publish -c Release -o artifacts/publish
```

Dockerfile sunucu modunda çalışır. Odalar bellekte tutulur; sunucu yeniden başlatıldığında geçici odalar kaybolur. Mevcut medya yapısı mesh'tir: çok büyük odalar için SFU, kalıcı hesaplar ve çok sunuculu oda durumu ayrı mimari çalışması gerektirir.

## Doğrulama

Node.js 20+ yalnızca geliştirme araçları için gereklidir. SignalR tarayıcı paketi yerelde sürümlenmiştir; uygulama açılışında CDN indirmesi gerekmez.

```powershell
npm.cmd ci
npm.cmd run vendor
npx.cmd playwright install chromium
dotnet build
npm.cmd run test:e2e
```

Playwright testleri sunucuyu otomatik başlatır; iki ayrı tarayıcı oturumuyla WebRTC paket iletimi, mesajlaşma, sessize alma, kamera, ses ayarı kalıcılığı, mikrofon izni reddi ve mobil yerleşimi doğrular. Rapor `playwright-report/index.html`, ekran görüntüleri `test-results/` altında oluşur.

SignalR varlıklarını güncellerken `package.json` sürümünü ve lockfile'ı birlikte güncelleyin, ardından `npm.cmd run vendor` çalıştırın. Microsoft istemcisinin dağıtım yöntemi: [SignalR JavaScript client](https://learn.microsoft.com/aspnet/core/signalr/javascript-client?view=aspnetcore-10.0).
