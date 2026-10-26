# Google AI Mode → Cursor Agent

Google'ın arama sonuçlarındaki **AI Mode**'unu Cursor'ın agent'ına **araç** olarak bağlar.

```
Cursor Agent (beyin: function calling + dev tools)
      │
      ├── read_file / write / terminal / grep ...   (Cursor'ın kendi araçları)
      │
      └── google_ai_mode("güncel soru")  ──▶  motor  ──▶  google.com
                                              │
                              ┌───────────────┴───────────────┐
                              │                               │
                     HTTP motoru (~1-2s)              Chromium (~10-20s)
                     düz fetch + folwr                yedek / ağır durumlar
```

Cursor zaten gerçek bir agent'tır: function calling, agent döngüsü ve yerel
araçlar onda var. Eksik olan tek parça **canlı web bilgisiydi** — bu proje onu
AI Mode üzerinden sağlar.

---

## İki motor: tarayıcısız (hızlı) ve Chromium (yedek)

Projenin en önemli bulgusu: **AI Mode tarayıcı olmadan da okunabiliyor.**

`/search?udm=50` sayfası, cevabı getiren `folwr` isteği için gereken **tüm
token'ları** (`garc`, `mlro`, `mlros`, `srtst`, `stkp`, `ei`, `xsrf`) HTML'deki
`data-*` özniteliklerinde hazır veriyor. Yani tarayıcı gerekmiyor:

```
GET /search?q=...&udm=50  →  token'ları ayıkla
GET /async/folwr?...      →  cevap HTML'i
```

| | Tarayıcısız (HTTP) | Chromium |
|---|---|---|
| Süre | **~0.8-2.5 s** | ~10-20 s |
| RAM | ~50 MB | ~400 MB |
| Süreç | yok | Chrome + profil |
| Kırılganlık | token'lara bağlı | DOM seçicilerine bağlı |
| Risk | IP hız sınırı | captcha, bot koruması |

**Varsayılan `hybrid`:** önce HTTP denenir; Google IP'yi geçici olarak
sınırlarsa (`THROTTLED`) otomatik Chromium'a düşülür, sistem hiç durmaz.

```powershell
$env:AIM_ENGINE = "hybrid"   # varsayılan
$env:AIM_ENGINE = "http"     # yalnız tarayıcısız
$env:AIM_ENGINE = "browser"  # yalnız Chromium
```

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
npm run login            # görünür tarayıcı: çerez/giriş
npm run export-cookies   # cookies.json üret (tarayıcısız motor için)
```

Açılan pencerede çerez ekranını kabul et, bir soru sorup AI Mode'un çalıştığını
gör, gerekirse giriş yap. Sonra terminalde **Enter**.

> `npm run export-cookies` profildeki Google çerezlerini `cookies.json`'a yazar.
> Tarayıcısız motor bunları kullanır. Çerezler aylarca geçerlidir; süresi
> dolduğunda aynı komutu tekrar çalıştırmak yeterli.
>
> **Google hesabıyla giriş yapman önerilir:** anonim kullanımda IP hız sınırı
> daha agresif uygulanıyor.

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
| `npm run export-cookies` | Profil çerezlerini `cookies.json`'a aktarır |
| `npm run ask -- "soru"` | Terminalden tek soru |
| `npm run debug -- "soru"` | Teşhis: sayfa HTML'i + ekran görüntüsü |
| `npm run agent -- "görev"` | Kural tabanlı agent döngüsü (dosya araçları) |
| `npm test` | Birim testleri (ağ gerekmez) |
| `npm start` | (Opsiyonel) OpenAI uyumlu HTTP endpoint, `:8787` |

---

## Nasıl çalışıyor?

### Tarayıcısız motor (`src/http-engine.js`)

1. `GET /search?q=...&udm=50` → HTML (≈525 KB)
2. `data-garc`, `data-lro-token`, `data-lro-signature`, `data-srtst`, `data-stkp`,
   `data-ei`, `data-xsrf-folwr-token` özniteliklerini ayıkla
3. `GET /async/folwr?...` → cevap HTML'i (≈475 KB)
4. Cevap gövdesi `class="n6owBd"` paragrafından başlar; arayüz kuyruğu
   ("Panoya kopyalandı", paylaşım menüsü) doğal sınır olarak kesilir
5. Kaynak kartları `<!--TgQPHd|||[[...]]-->` yorumlarından yapısal olarak çıkarılır

### Chromium motoru (`src/engine.js`)

1. `launchPersistentContext` ile kalıcı profil
2. Cevap **yazılırken** `innerText` canlı örneklenir → `onDelta` ile akıtılır
3. Bitince "Kopyala" düğmesiyle tam markdown alınır (tablolar bozulmaz)
4. Kaynaklar `/goto?url=...` 302 yönlendirmesinden çözülür

### Agent protokolü (`src/prompt.js`)

AI Mode function calling yapamaz ama **sınav sorusu** çerçevesinde tek satırlık
komut üretiyor:

```
Sinav sorusu: Bir ajan read_file(path) write_file(path,content) araclarini
kullaniyor. Gorev: "package.json oku" ... Cevap formati: ARAC: ad | arg="deger"
```

`parseProtocol` bunu OpenAI `tool_calls` formatına çevirir; Cursor/Cline gerçek
araç çağrısı olarak görür.

**Ölçülen kısıtlar (hepsi test edildi):**
- AI Mode kimlik dayatmasını ("sen bir ajansın") reddediyor → boş cevap
- **Çok satırlı sorguda cevap üretmiyor** → sorgular tek satıra indirilir
- Araç listesi JSON olarak gömülünce arama bozuluyor

---

## Sınırlar

- **Hız sınırı (en önemli):** Google art arda hızlı isteklerde AI Mode
  kapsayıcısını göndermeyi bırakıyor (`THROTTLED`). İstekler arası bekleme
  varsayılan 1.5 s; artırılabilir. Sınır IP bazlıdır, çerez silmek çözmez.
  Kalıcı çözüm: Google hesabıyla giriş + makul istek sıklığı.
- **Hız:** HTTP ~1-2.5 s, Chromium ~10-20 s
- **Sıralı:** istekler tek tek işlenir (paralel istekler sınırı hızlandırır)
- **ToS riski:** Google otomatik erişimi yasaklar
- **Kırılganlık:** HTTP yolu token özniteliklerine, Chromium yolu DOM
  seçicilerine bağlı. İkisi de değişebilir (`npm run debug` ile incele)
- **Araç çağırma:** AI Mode *kendi* araçlarını çağırır (Arama, Python, Görsel)
  ama dışarıdan tanımlanan araçları çağıramaz

## Ayarlar

PowerShell ile geçersiz kılınabilir:

```powershell
$env:AIM_ENGINE = "http"
$env:AIM_MIN_INTERVAL_MS = "3000"
$env:AIM_HEADLESS = "1"
$env:AIM_PROFILE_DIR = "C:\aim-profile"
$env:AIM_MAX_SOURCES = "6"
```

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `AIM_ENGINE` | `hybrid` | `hybrid` \| `http` \| `browser` |
| `AIM_MIN_INTERVAL_MS` | `1500` | HTTP motorunda istekler arası bekleme |
| `AIM_HEADLESS` | `0` | Chromium'u arka planda çalıştır |
| `AIM_PROFILE_DIR` | `%LOCALAPPDATA%\google-ai-mode-profile` | Chrome profili |
| `AIM_DATA_DIR` | proje kökü | `cookies.json` konumu |
| `AIM_ANSWER_TIMEOUT` | `40000` | Chromium cevap bekleme (ms) |
| `AIM_SOURCES` | `1` | `0` = kaynak ekleme |
| `AIM_MAX_SOURCES` | `6` | En fazla kaynak |
| `AIM_PORT` | `8787` | Sadece `npm start` için |
