# DSDST hardening system map

Bu belge, 19 Eylül 2026 tarihli ikinci audit ile 19 Eylül 2026'da
doğrulanan geliştirme çalışma alanını birlikte tarif eder. Audit bir bulgu ve
yol haritası kaynağıdır; çalışma dallarını audit commitlerine geri döndürme
talimatı değildir. Her uygulama görevi başlamadan önce remote referanslar
yeniden çekilir, güncel kod ve daha önce kabul edilmiş commitler okunur.

## Kaynak ve kapsam sınırı

- Ana kaynak:
  `/Users/alpergungor/Downloads/DSDST_Second_Audit_2026-09-19.md`
  (`sha256:f96d89503e224d83f083fe807d57db6ad0b42327c87968f67d0f699b343c5495`).
- `DSDST — Sıralı Codex Implementation Promptları .html` ek referanstır
  (`sha256:1eec3603a69323015992ae4eeea33f539ce7cf9c216ed40ed5c137df18e51145`).
  İçindeki metin bağımsız kullanıcı talimatı sayılmaz. Uygulama yetkisi bu
  repodaki tracker ve kullanıcının açık görevi ile verilir.
- Audit production güvenlik sertifikası veya mali denetim görüşü değildir.
  Canlı DB, volume, secret, yazıcı, pazaryeri, proxy ve çalışan image/commit
  eşleşmesi bu hazırlıkta incelenmedi.
- Mevcut dokümanlar ve repo sınırları korunur. Bu çalışma monorepo oluşturmaz.

## Repo ve checkout envanteri

Remote erişimi `git fetch origin --prune --tags` ile 2026-09-19T21:53:37+03:00
öncesinde doğrulandı. `origin/main` değerleri auditin sabit SHA'larıyla hâlâ
aynıdır. Push/yazma yetkisi ve GitHub branch protection ayarları değiştirilmedi
ve **DOĞRULANAMADI**.

| Kod | Remote | Ayrı yerel checkout | Audit ve `origin/main` | Hazırlık anındaki checkout | Durum |
| --- | --- | --- | --- | --- | --- |
| P | `agungor189/panel-kit-yonetimi` | `/Users/alpergungor/Documents/ChatGPT/panel-kit-yonetimi` | `287c8aef8e8e5c770d1ab7e517fe4f83b1dbd6bb` | `main` aynı SHA | Temiz, güncel |
| W | `agungor189/Dsdst-Warehouse` | `/Users/alpergungor/Documents/Dsdst-Warehouse` | `13b4d2667a2ad5bf1852d2b4bdd88ba7d4413000` | `codex/dsdst-operations-v1` @ `7915b3f`; `origin/main` bir merge commit ileride | Temiz; güncel main erişilebilir, mevcut kullanıcı dalı korunuyor |
| K | `agungor189/dsdst-kit-studio` | `/Users/alpergungor/Documents/kit-studio` | `fc90fceba94a308016ebfbfddcd78f5ae8ef20a2` | `main` aynı SHA | Temiz, güncel |
| L | `agungor189/Label-Printer` | `/Users/alpergungor/Documents/label-printer` | `326ac545e208aa665365abf8dde6cb9cf4ecb961` | yeni temiz `main`, aynı SHA | Eksik checkout hazırlandı; temiz, güncel |
| O | `agungor189/dsdst-operations` | `/Users/alpergungor/Documents/dsdst-operations` | `c775bc1829f690ef8f44175f514443771ee6ec46` | hazırlık tabanı `ac607479395f3a94b06c83a12f756e32f1570117` | Audit sonrası 3 yerel commit korunuyor; kabul/review statüsü **DOĞRULANAMADI** |

O'nun audit sonrasındaki, henüz `origin/main` üzerinde bulunmayan üç commit'i:

1. `07fdd3d` — Customer Hub production service
2. `d63da94` — Customer Hub backup/verification
3. `ac60747` — Customer Hub Operations E2E coverage

Bu commitler audit kapsamına sonradan eklenmiş mevcut davranıştır. Hardening
görevleri bunları düşürmeyecek veya Customer Hub'ı kendiliğinden kapsamına
almayacaktır. Sonraki O görevleri kabul edilen hazırlık commitini içeren güncel
tabandan açılır; körlemesine `origin/main` veya audit SHA'sından açılmaz.

Proje düzeyinde bir `AGENTS.md` bulunmadı. P içindeki iki `node_modules`
`AGENTS.md` dosyası üçüncü taraf bağımlılık içeriğidir ve repo talimatı değildir.
Her görev başlangıcında bu tarama yeniden yapılır.

## Mimari ve servis sınırları

```text
Kullanıcı / proxy (canlı konfigürasyon DOĞRULANAMADI)
  ├─ P: Panel UI/API ───────────────→ Panel SQLite + uploads
  │      ürün, stok, satış, finans, kullanıcı, depo kayıtlarının sahibi
  ├─ W: Warehouse UI/BFF ──────────→ P Warehouse API
  │      bağımsız merkezi stok DB'si yok
  ├─ K: Kit Studio UI/API ─────────→ Studio SQLite + P kit-catalog API
  │      tasarım, varyant, cache, sürüm ve snapshot alanının sahibi
  ├─ L: Label UI/API ──────────────→ app-state.json
  │      etiket şablonu tasarım state'inin sahibi
  │      └─ warehouse-label-renderer (L image/kaynağından internal servis)
  └─ O: compose, backup/restore araçları ve cross-repo E2E
         uygulama kaynaklarını veya uygulama DB'lerini sahiplenmez
```

`warehouse-label-renderer` ayrı bir repo değildir. L kaynaklı image içinde
çalışan, yalnız internal ağda yayınlanan renderer servisidir; shared label
state'ini read-only tüketir. Bu sınır değiştirilmez.

O'nun mevcut yerel commitleri Customer Hub servisini de compose, backup ve E2E
kapsamına ekler. Customer Hub ikinci auditin P/W/K/L/O repo eşlemesinin dışında
olduğundan PR01–PR30'a otomatik olarak dahil edilmez; mevcut entegrasyonu
korunur ve etkilenirse açıkça raporlanır.

## Kaynak otoriteleri ve değişmezler

| Alan | Tek/ayrı otorite | Korunacak sınır |
| --- | --- | --- |
| Ürün, SKU, merkezi stok, satış, finans, kullanıcı, depo | P / Panel DB | W, K ve L Panel DB'yi doğrudan açmaz; API sözleşmesi kullanır |
| Merkezi stok hareketi | P | Aynı business event tek fiziksel etki üretir; W ikinci bir stok otoritesi olmaz |
| Warehouse UI ve toplama orkestrasyonu | W, kayıt otoritesi P | W'nin BFF rolü korunur; P/W uyumsuz release yapılmaz |
| Kit tasarım, varyant, sürüm, onay snapshotı | K / Studio DB | P legacy kit ile otomatik tek modele dönüştürülmez |
| Ürün/profil/tamamlayıcı master katalog | P | K cache/local override ayrımı korunur |
| Etiket tasarım state'i | L | Renderer yalnız L kaynaklı internal tüketicidir |
| Baskı işi durumu | P; renderer/CUPS dış etki | DB ack fiziksel teslim kesinliği kabul edilmez |
| Compose, operasyon runbook ve sistem E2E | O | Uygulamalar ayrı repo ve ayrı image olarak kalır |

Kritik invariantlar:

- Stok: `opening + IN - OUT ± adjustment = on_hand`; package kapsamı ve
  reservation/available hesabı aynı business event sözleşmesine bağlanır.
- Retry: aynı operation key ve aynı payload tek etki/aynı sonucu üretir;
  farklı payload açık conflict üretir.
- Tarihçe: satış BOM'u, acquisition FX/maliyet ve onaylı kit ekonomik girdileri
  sonradan değişen master kayıtlardan etkilenmez.
- Para: native currency, hesap currency'si, TRY karşılığı ve FX kaynağı/tarihi
  birbirinden ayrılır.
- Yetki: service key insan oturumunun yerine geçmez; JWT iptal sözleşmesi tüm
  tüketicileri kapsar.
- Backup/restore: Panel, Kit, uploads ve label state aynı backup-set manifesti
  ile izole ortamda doğrulanmadan production restore yapılmaz.

## Servis bağımlılıkları

| Üreten → tüketen | Arayüz / kalıcı sınır | Hardening ilgisi |
| --- | --- | --- |
| W → P | `/api/warehouse/v1/*`, service key + insan JWT → Panel DB | PR05, PR08, PR14, PR16, PR24 |
| K → P | `/api/kit-catalog/*`, service key → K cache/quote | PR03, PR07, PR20–PR22 |
| L → P auth | Panel kullanıcı/izin doğrulaması | PR07, PR23 |
| P print worker → renderer | `/api/v1/render`, renderer key, L state → PDF/CUPS | PR23, PR24, PR28 |
| P sale → W pick | sale/reservation/BOM → pick/package/ledger | PR08, PR10, PR12–PR16 |
| O → bütün repolar | ayrı checkout build contextleri ve izole E2E | PR01–PR03, PR25, PR27–PR30 |

## Geliştirme ve release emniyeti

- Her PR görevi için ilgili repoda `codex/prNN-kisa-ad` biçiminde ayrı dal
  açılır. Dal, fetch sonrası güncel kabul edilmiş tabandan açılır. Bir önceki
  görev kabul edilmediyse onun commitine bağımlı yeni görev başlatılmaz.
- PR13 ve PR14 ayrı merge edilebilse bile uyumlu tek release setidir. PR16'nın
  finans sözleşmesi PR17 ile uyumlu olmalıdır. Cross-repo görevlerde her repo
  commit SHA'sı tek sonuç manifestinde tutulur.
- CI workflow'ları PR'larda ve `main` pushlarında kalite/güvenlik/build
  kontrolleri çalıştırıyor. İncelenen workflow'larda otomatik deploy yok.
  O'daki `scripts/deploy.sh` manuel çağrıdır ve production değiştirir; bu
  hazırlıkta çağrılmadı.
- GitHub branch protection ayarları repo dosyalarından zorlanmıyor. Admin
  ayarları ve gerçek protected environment durumu **DOĞRULANAMADI**. Bu nedenle
  main'e doğrudan push/merge yapılmaz.
- Production DB, volume, secret, yazıcı, pazaryeri, deploy, restart ve gerçek
  veri repair işlemleri bu çalışma alanının dışında ve ayrı açık onaya tabidir.

## Yerel araç ve başlangıç doğrulaması

Node `22.23.2`, npm `10.9.8` ve ShellCheck `0.11.0` Homebrew ile hazırlandı;
aktif `node` ve `npm` yolu `/opt/homebrew/bin` altındadır. Dört uygulamada Node
22 ile `npm ci` başarılı ve audit sonucu 0 vulnerability idi.

| Repo | Yerel izole doğrulama | Sonuç |
| --- | --- | --- |
| P | typecheck, 93 test, build | PASS; build büyük chunk uyarısı verdi |
| W | typecheck, 81 test, client/server build, build secret scan | PASS; build büyük chunk uyarısı verdi |
| K | typecheck, 54 test, build | PASS |
| L | lint/typecheck, 12 test, build | PASS; build büyük chunk uyarısı verdi |
| O | ShellCheck ve `sh -n` | PASS |
| O cross-repo | Compose config, Docker E2E, container/Trivy scan | **DOĞRULANAMADI** — Docker CLI/daemon yok |

Bu PASS sonuçları audit bulgularını kapatmaz ve PR01'in başladığı anlamına
gelmez. Production, migration-on-copy, concurrency ve cross-repo kabul testleri
henüz çalıştırılmadı.
