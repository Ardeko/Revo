; ============================================================================
; REVO — Windows kurulum betiği (Inno Setup 6.3+)
;
; Derlemek için:
;   1) Inno Setup 6'yı kur: https://jrsoftware.org/isdl.php
;   2) Uygulamayı publish et:
;        dotnet publish -c Release -r win-x64 --self-contained true
;   3) WebView2 önyükleyicisini indirip redist\ klasörüne koy:
;        https://developer.microsoft.com/microsoft-edge/webview2/
;   4) Bu dosyayı Inno Setup Compiler ile aç, Build > Compile
;   5) Çıktı: installer\REVO-Setup.exe
;
; TASARIM NOTU
; Inno'nun varsayılan sihirbazı gri, kutulu, 2005 görünümlü. REVO'nun kimliği
; ise koyu zemin + sinyal/frekans dili. Aşağıdaki [Code] bölümü sihirbazın
; tamamını yeniden boyuyor ve imza öğesi olarak CANLI BİR SPEKTRUM çiziyor:
; kurulum sürerken dalga "tarama" yapıyor, kurulum bitince sabit bir desene
; "kilitleniyor". İlerlemeyi ürünün kendi metaforuna bağlıyor — jenerik bir
; yükleme çubuğu yerine.
;
; Animasyon, Inno'nun kendi belgelediği SetTimer + CreateCallback deseniyle
; çalışıyor; her karede bitmap tuvaline dikdörtgen çiziliyor. Dış bir DLL,
; eklenti ya da hazır kare dizisi gerekmiyor.
; ============================================================================

#define MyAppName "REVO"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Ardeko Studios"
#define MyAppURL "https://ardekostudios.com"
#define MyAppExeName "RevoApp.exe"

; publish çıktısının bulunduğu klasör — kendi yoluna göre düzelt
#define SourceDir "bin\Release\net10.0\win-x64\publish"

; ---------------------------------------------------------------------------
; WebView2 önyükleyicisi iki şekilde temin edilebilir:
;
;   A) redist\MicrosoftEdgeWebview2Setup.exe dosyasını indirip koyarsan
;      kuruluma GÖMÜLÜR. Kullanıcı internetsizken bile kurulum tamamlanır.
;      Önerilen yol.
;
;   B) Dosya yoksa kurulum, gerektiği anda Microsoft'un kalıcı bağlantısından
;      (~2 MB) indirir. Derleme hata vermez.
;
; Aşağıdaki satır hangi yolun geçerli olduğunu derleme anında kendisi anlıyor —
; eskiden dosya yoksa derleme "Source file does not exist" ile duruyordu.
; ---------------------------------------------------------------------------
#define WebView2Redist "redist\MicrosoftEdgeWebview2Setup.exe"
#if FileExists(AddBackslash(SourcePath) + WebView2Redist)
  #define EmbedWebView2
#endif

[Setup]
AppId={{8F3C1A64-7B2E-4C55-9E11-A17C90D4B002}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
OutputDir=installer
OutputBaseFilename=REVO-Setup
SetupIconFile=wwwroot\favicon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=120
ShowLanguageDialog=no

; Yönetici hakkı istemiyoruz: kullanıcı klasörüne kurulum yapılınca UAC
; penceresi çıkmıyor ve kurulum tek tıkla akıyor.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Tasks]
Name: "desktopicon"; Description: "Masaüstü kısayolu oluştur"; GroupDescription: "Kısayollar"; Flags: checkedonce

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

#ifdef EmbedWebView2
; WebView2 önyükleyici (~2 MB) kuruluma gömülü — internet gerekmez.
Source: "{#WebView2Redist}"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: not IsWebView2Installed
#endif

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; WebView2 çalışma zamanı yoksa sessizce kur. Windows 11'de zaten var,
; Windows 10'da genelde Edge ile geliyor ama garantisi yok — ve yoksa
; uygulama açılışta hiçbir açıklama vermeden çöküyor.
; Check ayrıca dosyanın gerçekten yerinde olduğunu doğruluyor: gömülü
; değilse ve indirme de başarısız olduysa bu adım sessizce atlanır,
; kurulumun tamamı çökmez.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; \
    Parameters: "/silent /install"; \
    StatusMsg: "Görüntüleme bileşeni hazırlanıyor..."; \
    Flags: waituntilterminated; \
    Check: NeedsWebView2AndHaveInstaller

Filename: "{app}\{#MyAppExeName}"; \
    Description: "REVO'yu başlat"; \
    Flags: nowait postinstall skipifsilent

[Code]
// SetTimer + CreateCallback: Inno'nun kendi belgelerindeki resmi animasyon
// yöntemi. Dış bir eklentiye ihtiyaç yok.
function SetTimer(hWnd, nIDEvent, uElapse, lpTimerFunc: LongWord): LongWord;
  external 'SetTimer@user32.dll stdcall';
function KillTimer(hWnd, uIDEvent: LongWord): LongWord;
  external 'KillTimer@user32.dll stdcall';

const
  // DİKKAT: Delphi'de TColor BGR sıralı, RGB değil. Aşağıdakiler REVO'nun
  // web paletinin çevrilmiş hali (ör. amber #E3A857 -> $57A8E3).
  cBg      = $130E0B;  // #0B0E13  sayfa zemini
  cPanel   = $211A15;  // #151A21  panel
  cPanel2  = $2C231C;  // #1C232C  girdi alanları
  cBorder  = $382E26;  // #262E38  ince ayırıcı
  cText    = $E6EBED;  // #EDEBE6  ana metin
  cDim     = $A3938A;  // #8A93A3  ikincil metin
  cFaint   = $6C5E54;  // #545E6C  etiketler
  cAmber   = $57A8E3;  // #E3A857  vurgu
  cTeal    = $C0CF3E;  // #3ECFC0  sinyal

  SpectrumBars = 56;
  SpectrumH    = 74;
  TimerId      = 1;

var
  Spectrum: TBitmapImage;
  Phase: Integer;
  Locked: Boolean;      // kurulum bitti mi — dalga "kilitlenir"
  TimerHandle: LongWord;
  SineTab: array[0..63] of Integer;
#ifndef EmbedWebView2
  DownloadPage: TDownloadWizardPage;
#endif

procedure InitSineTable;
begin
  // Sin() fonksiyonuna bağımlı kalmamak için önceden hesaplanmış tablo
  // (değerler 1000 ile ölçeklenmiş).
  SineTab[0] := 0;      SineTab[1] := 98;    SineTab[2] := 195;   SineTab[3] := 290;
  SineTab[4] := 383;    SineTab[5] := 471;   SineTab[6] := 556;   SineTab[7] := 634;
  SineTab[8] := 707;    SineTab[9] := 773;   SineTab[10] := 831;  SineTab[11] := 882;
  SineTab[12] := 924;   SineTab[13] := 957;  SineTab[14] := 981;  SineTab[15] := 995;
  SineTab[16] := 1000;  SineTab[17] := 995;  SineTab[18] := 981;  SineTab[19] := 957;
  SineTab[20] := 924;   SineTab[21] := 882;  SineTab[22] := 831;  SineTab[23] := 773;
  SineTab[24] := 707;   SineTab[25] := 634;  SineTab[26] := 556;  SineTab[27] := 471;
  SineTab[28] := 383;   SineTab[29] := 290;  SineTab[30] := 195;  SineTab[31] := 98;
  SineTab[32] := 0;     SineTab[33] := -98;  SineTab[34] := -195; SineTab[35] := -290;
  SineTab[36] := -383;  SineTab[37] := -471; SineTab[38] := -556; SineTab[39] := -634;
  SineTab[40] := -707;  SineTab[41] := -773; SineTab[42] := -831; SineTab[43] := -882;
  SineTab[44] := -924;  SineTab[45] := -957; SineTab[46] := -981; SineTab[47] := -995;
  SineTab[48] := -1000; SineTab[49] := -995; SineTab[50] := -981; SineTab[51] := -957;
  SineTab[52] := -924;  SineTab[53] := -882; SineTab[54] := -831; SineTab[55] := -773;
  SineTab[56] := -707;  SineTab[57] := -634; SineTab[58] := -556; SineTab[59] := -471;
  SineTab[60] := -383;  SineTab[61] := -290; SineTab[62] := -195; SineTab[63] := -98;
end;

function Sine(Index: Integer): Integer;
begin
  // Negatif ve taşan indeksleri güvenle sarmalar.
  Index := Index mod 64;
  if Index < 0 then Index := Index + 64;
  Result := SineTab[Index];
end;

// Kurulum ilerledikçe amber'dan teal'a doğru geçen bar rengi. Bar ne kadar
// yüksekse o kadar "sinyalli" görünsün diye tepe barlar teal'a kayıyor.
function BarColor(Level, MaxLevel: Integer): Integer;
var
  R, G, B, T: Integer;
begin
  if MaxLevel <= 0 then MaxLevel := 1;
  T := (Level * 100) div MaxLevel;
  if T > 100 then T := 100;
  if T < 0 then T := 0;

  // #E3A857 (227,168,87) -> #3ECFC0 (62,207,192) arası doğrusal geçiş
  R := 227 + (((62 - 227) * T) div 100);
  G := 168 + (((207 - 168) * T) div 100);
  B := 87 + (((192 - 87) * T) div 100);

  Result := (B * 65536) + (G * 256) + R;  // TColor = BGR
end;

procedure DrawSpectrum;
var
  C: TCanvas;
  W, H, i, BarW, Gap, Level, MaxLevel, X, Y, Amp, Base: Integer;
begin
  if Spectrum = nil then Exit;

  C := Spectrum.Bitmap.Canvas;
  W := Spectrum.Bitmap.Width;
  H := Spectrum.Bitmap.Height;

  // NOT: Inno'nun Pascal Script'inde Rect() yardımcı fonksiyonu YOK (o
  // Delphi'nin Types birimine ait). Bu yüzden FillRect(Rect(...)) yerine
  // dört tam sayı alan Canvas.Rectangle kullanıyoruz. Pen.Style := psClear
  // ile kenarlık çizilmiyor, sadece Brush rengiyle dolduruluyor — yani
  // FillRect ile aynı sonuç. Koordinat mantığı da aynı: sağ ve alt sınır
  // hariç tutulur.
  C.Pen.Style := psClear;
  C.Brush.Style := bsSolid;

  // Zemin
  C.Brush.Color := cBg;
  C.Rectangle(0, 0, W, H);

  // Orta çizgi — sinyalin "sıfır ekseni"
  C.Brush.Color := cBorder;
  C.Rectangle(0, H - 1, W, H);

  BarW := 4;
  Gap := 2;
  MaxLevel := H - 10;

  // Kurulum sürerken genlik yüksek ve dalga hızlı akıyor ("tarıyor");
  // bittiğinde genlik düşüyor ve desen sabitleniyor ("kilitlendi").
  if Locked then
  begin
    Amp := MaxLevel div 5;
    Base := MaxLevel div 6;
  end
  else
  begin
    Amp := (MaxLevel * 2) div 5;
    Base := MaxLevel div 3;
  end;

  for i := 0 to SpectrumBars - 1 do
  begin
    X := 8 + i * (BarW + Gap);
    if X + BarW > W - 8 then Break;

    if Locked then
      // Kilitli durumda yavaş, sakin bir nefes alma
      Level := Base + ((Amp * Sine(Phase div 3 + i)) div 1000)
    else
      // Tarama sırasında iki farklı hızda dalga üst üste binerek organik
      // bir spektrum hissi veriyor
      Level := Base
             + ((Amp * Sine(Phase + i * 3)) div 1000)
             + ((Amp * Sine(Phase * 2 - i * 5)) div 2000);

    if Level < 3 then Level := 3;
    if Level > MaxLevel then Level := MaxLevel;

    Y := H - 1 - Level;
    C.Brush.Color := BarColor(Level, MaxLevel);
    C.Rectangle(X, Y, X + BarW, H - 1);
  end;
end;

procedure AnimationTick(H, Msg, IdEvent, Time: LongWord);
begin
  Phase := Phase + 1;
  if Phase > 100000 then Phase := 0;
  DrawSpectrum;
end;

// Inno'nun varsayılan gri sihirbazını REVO'nun koyu paletine çeviriyoruz.
procedure StyleLabel(L: TNewStaticText; Color: Integer; Size: Integer; Bold: Boolean);
begin
  if L = nil then Exit;
  L.Font.Name := 'Segoe UI';
  L.Font.Size := Size;
  L.Font.Color := Color;
  if Bold then
    L.Font.Style := [fsBold]
  else
    L.Font.Style := [];
  L.Color := cBg;
end;

// WebView2 çalışma zamanı kurulu mu? Hem makine geneli hem kullanıcı bazlı
// kayıt defteri yollarına bakıyoruz; Evergreen sürüm bilgisi burada tutuluyor.
function IsWebView2Installed: Boolean;
var
  Version: String;
begin
  Result := False;

  if RegQueryStringValue(HKLM,
      'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'pv', Version) then
    Result := (Version <> '') and (Version <> '0.0.0.0');

  if not Result then
    if RegQueryStringValue(HKCU,
        'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
        'pv', Version) then
      Result := (Version <> '') and (Version <> '0.0.0.0');
end;

// Önyükleyiciyi çalıştırmadan önce hem gerekliliğini hem varlığını doğrula.
function NeedsWebView2AndHaveInstaller: Boolean;
begin
  Result := (not IsWebView2Installed)
        and FileExists(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'));
end;

#ifndef EmbedWebView2
// Önyükleyici kuruluma gömülü değil — gerekiyorsa kurulum sırasında
// Microsoft'un kalıcı bağlantısından indiriyoruz. İndirme yalnızca WebView2
// gerçekten eksikse yapılıyor, yani kullanıcıların büyük çoğunluğu bu adımı
// hiç görmüyor.
function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpReady) and (not IsWebView2Installed) then
  begin
    DownloadPage.Clear;
    DownloadPage.Add(
      'https://go.microsoft.com/fwlink/p/?LinkId=2124703',
      'MicrosoftEdgeWebview2Setup.exe',
      '');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
      except
        // İndirme başarısız olsa bile kurulumu durdurmuyoruz: makinede
        // WebView2 zaten olabilir ya da kullanıcı sonradan kurabilir.
        // Yukarıdaki [Run] adımı dosya yoksa kendini atlıyor.
        Log('WebView2 önyükleyici indirilemedi: ' + GetExceptionMessage);
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;
#endif

procedure InitializeWizard;
begin
  InitSineTable;
  Phase := 0;
  Locked := False;

  WizardForm.Color := cBg;

  // NOT: TNewNotebook ve TNewNotebookPage sınıflarında Color özelliği
  // Pascal Script'e açılmamış — sayfa kaplarını doğrudan boyayamıyoruz.
  // Formun kendi rengi ve MainPanel yeterli kontrastı veriyor.
  WizardForm.Bevel.Visible := False;
  WizardForm.Bevel1.Visible := False;


  // Üstteki başlık şeridi
  WizardForm.MainPanel.Color := cPanel;
  StyleLabel(WizardForm.PageNameLabel, cText, 11, True);
  StyleLabel(WizardForm.PageDescriptionLabel, cDim, 9, False);
  WizardForm.PageNameLabel.Color := cPanel;
  WizardForm.PageDescriptionLabel.Color := cPanel;

  // Karşılama ve bitiş sayfaları
  StyleLabel(WizardForm.WelcomeLabel1, cText, 20, True);
  StyleLabel(WizardForm.WelcomeLabel2, cDim, 9, False);
  StyleLabel(WizardForm.FinishedHeadingLabel, cText, 20, True);
  StyleLabel(WizardForm.FinishedLabel, cDim, 9, False);

  // Ara sayfalardaki metinler
  StyleLabel(WizardForm.SelectDirLabel, cDim, 9, False);
  StyleLabel(WizardForm.SelectDirBrowseLabel, cDim, 9, False);
  StyleLabel(WizardForm.DiskSpaceLabel, cFaint, 8, False);
  StyleLabel(WizardForm.SelectTasksLabel, cDim, 9, False);
  StyleLabel(WizardForm.ReadyLabel, cDim, 9, False);
  StyleLabel(WizardForm.StatusLabel, cDim, 9, False);
  StyleLabel(WizardForm.FilenameLabel, cFaint, 8, False);

  // Girdi alanları ve listeler
  WizardForm.DirEdit.Color := cPanel2;
  WizardForm.DirEdit.Font.Color := cText;
  WizardForm.DirEdit.Font.Name := 'Segoe UI';
  WizardForm.TasksList.Color := cBg;
  WizardForm.TasksList.Font.Color := cText;
  WizardForm.TasksList.Font.Name := 'Segoe UI';
  WizardForm.ReadyMemo.Color := cPanel2;
  WizardForm.ReadyMemo.Font.Color := cDim;
  WizardForm.ReadyMemo.Font.Name := 'Consolas';
  WizardForm.RunList.Color := cBg;
  WizardForm.RunList.Font.Color := cText;
  WizardForm.RunList.Font.Name := 'Segoe UI';

  // Varsayılan sihirbaz görselini gizliyoruz — yerine spektrum geliyor.
  WizardForm.WizardBitmapImage.Visible := False;
  WizardForm.WizardBitmapImage2.Visible := False;

#ifndef EmbedWebView2
  DownloadPage := CreateDownloadPage(
    'Bileşenler hazırlanıyor',
    'REVO''nun ihtiyaç duyduğu görüntüleme bileşeni indiriliyor.',
    @OnDownloadProgress);
  StyleLabel(DownloadPage.Msg1Label, cText, 10, False);
  StyleLabel(DownloadPage.Msg2Label, cFaint, 8, False);
#endif

  // ---- İmza öğesi: canlı spektrum ----
  // Kurulum ekranının altına, buton çubuğunun hemen üstüne yerleştiriliyor;
  // her sayfada görünür kalıyor, böylece kurulum boyunca "sinyal" hep akıyor.
  Spectrum := TBitmapImage.Create(WizardForm);
  Spectrum.Parent := WizardForm;
  // TBitmapImage'da Width/Height ayarlayıcıları script'e açılmamış; bunun
  // yerine AutoSize ile görsel kendini bitmap boyutuna göre ayarlıyor.
  Spectrum.AutoSize := True;
  Spectrum.Bitmap.Width := WizardForm.Width;
  Spectrum.Bitmap.Height := SpectrumH;
  Spectrum.Left := 0;
  Spectrum.Top := WizardForm.CancelButton.Top - SpectrumH - 12;

  DrawSpectrum;

  // ~25 FPS. Daha hızlısı görsel olarak fark yaratmıyor ama zayıf
  // makinelerde kurulum ilerlemesinden CPU çalmaya başlıyor.
  TimerHandle := SetTimer(0, 0, 40, CreateCallback(@AnimationTick));
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // Bitiş sayfasında dalga "kilitlenir" — kurulumun tamamlandığını
  // ilerleme çubuğundan bağımsız olarak da anlatan bir işaret.
  if CurPageID = wpFinished then
  begin
    Locked := True;
    DrawSpectrum;
  end;
end;

procedure DeinitializeSetup;
begin
  if TimerHandle <> 0 then
    KillTimer(0, TimerHandle);
end;
