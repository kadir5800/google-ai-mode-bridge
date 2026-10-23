# Google AI Mode → Cursor Agent

Google'ın arama sonuçlarındaki **AI Mode**'unu Cursor'ın agent'ına **araç** olarak bağlar.

```
Cursor Agent (beyin: function calling + dev tools)
      │
      ├── read_file / write / terminal / grep ...   (Cursor'ın kendi araçları)
      │
      └── google_ai_mode("güncel soru")  ──▶  Playwright  ──▶  google.com
```

Cursor zaten gerçek bir agent'tır: function calling, agent döngüsü ve yerel
araçlar onda var. Eksik olan tek parça **canlı web bilgisiydi** — bu proje onu
AI Mode üzerinden sağlar.

---

## Önemli: neden "AI Mode = agent" değil?

AI Mode'a araç tanımlamak denenebilir bir şey değil, **yapısal olarak imkânsız**.
Test edildi:

| Deneme | Sonuç |
|---|---|
| JSON araç talimatı aramaya gömülü | Cevap hiç gelmedi (arama bozuldu) |
| Doğal dilde `TOOL_CALL: read_file(...)` | AI Mode reddetti |
| Araçsız normal soru | Çalıştı |

AI Mode'un kendi cevabı:

> "doğrudan `read_file(path)` adında bir dahili aracı çağırma ... yeteneğim
> bulunmuyor. **Benim kullanabileceğim belirli araçlar bana sistem tarafından
> önceden tanımlanmıştır.**"

Agent olmak için 4 şart var:

1. **Function calling** — modelin *eğitilmiş* yeteneği, prompt'la eklenemez
2. **Agent loop** — `araç çağır → sonucu modele ver → devam et` (istemci yönetir)
3. **Gerçek yürütme** — araç çalışıp sonucu modele dönmeli
4. **System prompt kontrolü** — AI Mode'da bu Google'ın elinde

AI Mode tek atımlık, durumsuz bir arama özetleyicidir. Bu yüzden **beyin değil,
araç** olur. Bu proje tam olarak bunu yapar.

---

## Kurulum

### 1. Bağımlılıklar

```powershell
npm install
```

### 2. Google oturumu (bir kez)

```powershell
npm run login
```

Açılan pencerede çerez ekranını kabul et, bir soru sorup AI Mode'un çalıştığını
gör, gerekirse giriş yap. Sonra terminalde **Enter**.

> Profil: `%LOCALAPPDATA%\google-ai-mode-profile`
> Chrome, yolunda Türkçe karakter olan `--user-data-dir` dizinlerinde açılmadığı
> için profil ASCII yolda tutulur.

### 3. Cursor'a MCP aracı olarak ekle

`C:\Users\PC\.cursor\mcp.json` içine:

```json
"google-ai-mode": {
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\Users\\PC\\Documents\\Yeni klasör\\src\\mcp-server.js"],
  "env": { "AIM_HEADLESS": "1" }
}
```

Bu eklendi. **Cursor'ı yeniden başlat**, sonra Settings → MCP'de
`google-ai-mode` yeşil olmalı.

### 4. Kullan

Cursor agent'a normal şekilde sor; güncel bilgi gerektiğinde
`google_ai_mode` aracını kendisi çağırır. Örnek:

> "2026'da en güncel Node.js LTS sürümü ne? Projemdeki sürümü güncelle."

Agent önce `google_ai_mode` ile araştırır, sonra `read_file`/`terminal` ile
projeyi günceller. **İşte agent davranışı bu.**

---

## Araçlar

| Araç | Açıklama |
|---|---|
| `google_ai_mode` | AI Mode ile web araması; kaynak linkleriyle derlenmiş cevap (~10-20 sn) |
| `google_ai_mode_login` | Tarayıcı/oturum durumunu kontrol eder (teşhis) |

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm run mcp` | MCP sunucusunu elle çalıştırır (test için) |
| `npm run login` | Görünür tarayıcı açar, oturumu kaydeder |
| `npm run ask -- "soru"` | Terminalden tek soru |
| `npm run debug -- "soru"` | Teşhis: sayfa HTML'i + ekran görüntüsü |
| `npm start` | (Opsiyonel) OpenAI uyumlu HTTP endpoint, `:8787` |

---

## Nasıl çalışıyor?

**İki katmanlı çıkarma:**
1. **Pano (asıl)** — AI Mode cevabının altındaki **Kopyala** düğmesine basılır.
   Google böylece tam markdown verir; tablolar bozulmaz.
2. **DOM (yedek)** — cevap bloğu `#aim-chrome-initial-inline-async-container`.

Bitiş tespiti: `data-complete="true"` + metnin sabitlenmesi.

**Kaynaklar:** `/goto?url=...` linkleri 302 yönlendirmesiyle gerçek adreslere
çözülür.

**Headless:** Varsayılan olarak arka planda çalışır. Google engellerse otomatik
olarak görünür pencereye geçer.

---

## Sınırlar

- **Hız:** istek başına ~10-20 saniye (gerçek tarayıcı yükleniyor)
- **Sıralı:** istekler tek tek işlenir (paralel sekmeler bot koruması tetikliyor)
- **ToS riski:** Google otomatik erişimi yasaklar. Captcha çıkarsa
  `npm run login` ile elle geçmek gerekir
- **Kırılganlık:** Google DOM'u değiştirirse seçiciler güncellenmeli
  (`npm run debug` ile incele)
- **Araç çağırma:** AI Mode *kendi* araçlarını çağırır (Arama, Python, Görsel)
  ama dışarıdan tanımlanan araçları çağıramaz

## Ayarlar

PowerShell ile geçersiz kılınabilir:

```powershell
$env:AIM_HEADLESS = "1"
$env:AIM_PROFILE_DIR = "C:\aim-profile"
$env:AIM_ANSWER_TIMEOUT = "40000"
$env:AIM_MAX_SOURCES = "6"
```

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `AIM_HEADLESS` | `0` (`mcp.json` içinde `1`) | `1` = arka planda |
| `AIM_PROFILE_DIR` | `%LOCALAPPDATA%\google-ai-mode-profile` | Chrome profili |
| `AIM_ANSWER_TIMEOUT` | `40000` | Cevap bekleme (ms) |
| `AIM_SOURCES` | `1` | `0` = kaynak ekleme |
| `AIM_MAX_SOURCES` | `6` | En fazla kaynak |
| `AIM_PORT` | `8787` | Sadece `npm start` için |
