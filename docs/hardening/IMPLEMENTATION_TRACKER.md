# DSDST hardening implementation tracker

Kaynak: `DSDST_Second_Audit_2026-09-19.md`, bölüm Z ve AA. Bu tracker uygulama
izni vermez. Kullanıcı bir PR görevini açıkça yetkilendirmeden o görevin kodu,
migrationı, veri işlemi, deployu veya sonraki görevi başlatılmaz.

## Durum modeli

Her görev dört bağımsız eksende izlenir:

- **Kod:** `BAŞLAMADI`, `ÇALIŞIYOR`, `HAZIR`, `KABUL EDİLDİ`
- **Test:** `DOĞRULANAMADI`, `KIRMIZI REGRESYON`, `PASS`, `FAIL`
- **Review:** `DOĞRULANAMADI`, `BEKLİYOR`, `KABUL`, `DEĞİŞİKLİK İSTENDİ`
- **Canlıya alma:** `YETKİ YOK`, `PLANLANDI`, `PİLOT`, `YAYINLANDI`, `GERİ ALINDI`

Kodun hazır olması review veya canlıya alma anlamına gelmez. Çalıştırılmayan
her kontrol açıkça **DOĞRULANAMADI** yazılır.

## PR01–PR30 sırası ve bağımlılıkları

| ID | Başlık | Faz | Öncelik | Repo | Bağımlılık | Kod | Test | Review | Canlıya alma |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| PR01 | Read-only runtime ve release kanıt manifesti | 0 | P1 | O | Yok | **BAŞLAMADI** | **DOĞRULANAMADI** | **DOĞRULANAMADI** | **YETKİ YOK** |
| PR02 | Kit DB tutarlı snapshot ve backup-set manifesti | 0 | P1 | O + K | PR01 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR03 | Exact business invariant test oracle | 1 | P0 | O + P/K/L | PR01 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR04 | Uploads dışı silmeyi kapat | 2 | P0 | P | PR03 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR05 | Warehouse insan okuma yetkisini doğrula | 2 | P1 | W + P | PR03 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR06 | Tekil upload byte/extension güvenliği | 2 | P1 | P | PR04 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR07 | Session iptal sözleşmesi | 2 | P1 | P + W/K/L | PR03 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR08 | Inventory ve immutable BOM kontratı | 3 | P0 | P/W/O | PR03 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR09 | Migration fail-closed ve upgrade fixtures | 4 | P1 | P + K | PR02 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR10 | Operation key ve immutable result ledger | 4 | P1 | P | PR08, PR09 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR11 | CSV opening ve inbound ayrımı | 5 | P1 | P | PR08, PR10 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR12 | Satış tüketim reçetesini snapshotla | 5 | P1 | P | PR08, PR10 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR13 | Satış rezervasyonunu gerçek stoktan ayır | 5 | P0 | P | PR08, PR10, PR12 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR14 | Paket pick tek fiziksel OUT | 5 | P0 | P + W | PR13 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR15 | Sayım clamp ve paket state | 5 | P1 | P | PR10, PR14 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR16 | Finansal iptal ve fiziksel return ayrımı | 5 | P1 | P + W | PR12, PR14, PR15 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR17 | Currency-safe sale/expense cash posting | 6 | P1 | P | PR10 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR18 | Currency-aware dashboard ve opening valuation | 6 | P1 | P | PR17 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR19 | Tek finans kapsamı ve backend türetilmiş toplamlar | 6 | P1 | P | PR17, PR18 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR20 | Acquisition maliyeti ve repair karantinası | 7 | P1 | P + K | PR17, PR19 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR21 | Onaylı kit immutable ekonomik snapshot | 7 | P1 | K | PR12, PR20 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR22 | Profil currency ve Kit tax/cost policy | 8 | P1 | P + K | PR17, PR20, PR21 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR23 | Label write queue ve CAS | 9 | P1 | L | PR03 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR24 | Print final-attempt ve unknown delivery | 9 | P1 | P + W | PR10, PR14 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR25 | Salt okunur mutabakat raporu | 10 | P1 | P + K + O | PR14–PR22 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR26 | Ayrı onaylı küçük repair batch altyapısı | 10 | P1 | P/K | PR25 + açık repair onayı | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR27 | Tam restore staging, gate ve rollback | 11 | P1 | P + O | PR02, PR09, PR21 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR28 | Desteklenen runtime ve sabit image seti | 12 | P2 | L + O + runtime sahipleri | PR03, PR27 | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR29 | Bağımsız cross-system re-audit E2E | 12 | P0 | O + bütün ilgili repolar | PR04–PR28 ilgili gerekli işler | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |
| PR30 | Pilot runbook ve günlük kontrol | 13 | P1 | O / operasyon | PR29 + açık pilot onayı | BAŞLAMADI | DOĞRULANAMADI | DOĞRULANAMADI | YETKİ YOK |

PR01 bu hazırlıkta başlatılmadı.

## Bağımlılık ve release kapıları

1. PR01, PR02 ve PR03 kanıt/test zeminidir. PR04–PR08, PR03 kabul edilmeden
   başlatılmaz.
2. PR08 ve PR09, PR10'un iki ayrı önkoşuludur. Stok akışının PR11–PR16 zinciri
   PR10 event/idempotency zeminini kullanır.
3. PR13 ve PR14 tek uyumlu release setidir. PR13 tek başına production'a
   dağıtılamaz. PR14'ten sonra PR15/PR16/PR24 ilerleyebilir.
4. Finans zinciri PR17 → PR18 → PR19 → PR20 şeklindedir. PR21 ayrıca PR12'ye,
   PR22 ise PR17/PR20/PR21'e bağlıdır.
5. PR23, stok/finans zincirinden bağımsız olarak PR03 sonrasında hazırlanabilir;
   PR24 için PR10 ve PR14 gerekir.
6. PR25, PR14–PR22 arasındaki ilgili bütün kabul edilmiş işleri ister. PR26'nın
   altyapısı ve her gerçek veri setine uygulanması ayrı açık repair onayı ister.
7. PR27, PR02/PR09/PR21; PR28, PR03/PR27; PR29 ise PR04–PR28 arasındaki ilgili
   gerekli kapanışların tamamına bağlıdır.
8. PR30 ancak PR29 kabulü ve ayrı kullanıcı pilot onayı ile ilerler.

## Her görevde zorunlu uygulama döngüsü

1. Kullanıcı yalnız ilgili PR görevini açıkça yetkilendirir.
2. İlgili audit maddesi, audit PR bölümü, güncel kaynak kod, mevcut belgeler,
   yeni bulunan `AGENTS.md` ve bağımlı kabul edilmiş commit/diffler okunur.
3. Remote referanslar fetch edilir. Audit commitine checkout/reset yapılmaz.
   Görev dalı güncel kabul edilmiş tabandan açılır.
4. Otomatik deploy/release workflow'ları ve branch hedefleri tekrar kontrol
   edilir. Main'e doğrudan merge/push yapılmaz.
5. Production dışı, izole fixture/kopyada önce hatayı yakalayan kırmızı
   regresyon yazılır. Test zayıflatılmaz, skip/xpass ile yeşil gösterilmez.
6. Yalnız görevin dar düzeltmesi uygulanır. Tek stok otoritesi ve servis
   sınırları korunur; geniş refactor/teknoloji göçü yapılmaz.
7. Uygulanmış migration değiştirilmez. Gerekirse additive migration eklenir ve
   fresh DB + eski şema fixture/kopyasında fail-closed davranış test edilir.
8. İlgili test, typecheck/lint, build ve gereken çapraz-repo testleri çalışır.
   Çalışmayan veya ortam eksikliği nedeniyle çalıştırılamayan kontrol
   **DOĞRULANAMADI** olarak kaydedilir.
9. Bağımsız review kod yazarından ayrı durum olarak kaydedilir. Review kabulü
   olmadan görev `KABUL EDİLDİ` olmaz.
10. Sonuç; değişen dosyalar, repo/commit SHA'ları, gerçek komut sonuçları,
    migration/veri etkisi, kod ve veri rollbacki, engeller ve kullanıcı
    kontrolleriyle raporlanır. Sonraki PR kendiliğinden başlamaz.

## Kabul edilen commitlerin sonraki göreve aktarılması

Her tamamlanan görev için bu dosyada veya görev sonuç ekinde aşağıdaki manifest
tutulur:

```text
Task: PRNN
Accepted-by: <insan/onay kaydı>
Repository SHAs: P=<sha> W=<sha> K=<sha> L=<sha> O=<sha>
Base SHAs read: <repo=sha listesi>
Migration/schema versions: <değişiklik veya yok>
Tests: <komut=PASS/FAIL/DOĞRULANAMADI>
Review: <KABUL/DEĞİŞİKLİK İSTENDİ/DOĞRULANAMADI>
Release set: <uyumlu SHA seti; yayın durumu ayrı>
Data impact: <yok/yalnız fixture/onay bekleyen repair>
Rollback: <kod ve veri ayrı>
```

Sonraki görev başlangıcında:

- Bu manifestteki SHA'ların yerel object store ve remote/teslim referanslarında
  bulunduğu doğrulanır.
- Bağımlı PR'ların kabul edilmiş SHA'ları yeni dalın ancestry'sinde olmalıdır;
  cross-repo bağımlılıklar exact SHA manifestiyle eşleştirilir.
- Kabul sonrası gelen yeni `main` commitleri diff edilir. Çakışma veya davranış
  değişikliği varsa audit varsayımı yeniden değerlendirilir.
- Kabul edilmemiş working tree veya review değişikliği dependency sayılmaz.
- Kod rollbacki bir commit/release geri alımıdır. Migration/veri etkisi varsa
  veri rollbacki ayrıca kanıtlanır; `git revert` veri rollbacki sayılmaz.

## Hazırlık kaydı

| Kontrol | Sonuç |
| --- | --- |
| Beş remote fetch ve audit SHA erişimi | PASS |
| Ayrı checkoutlar; monorepo yok | PASS |
| L checkout | PASS — eksik klasöre temiz clone hazırlandı |
| Node 22/npm ve dependency install | PASS — aktif sürümler `22.23.2` / `10.9.8` |
| P/W/K/L yerel test + statik kontrol + build | PASS |
| O ShellCheck + shell syntax | PASS |
| Docker Compose config/E2E/container scan | **DOĞRULANAMADI** — Docker yok |
| GitHub branch protection/protected environment | **DOĞRULANAMADI** |
| Push/yazma yetkisi | **DOĞRULANAMADI** — güvenli olmak için push denenmedi |
| Production runtime/image/schema/config | **DOĞRULANAMADI** ve bu görevin dışında |

## Görev sonuçları

Henüz kabul edilmiş hardening görevi yoktur. İlk kayıt, kullanıcı PR01'i ayrıca
yetkilendirdikten ve görev tamamlanıp review edildikten sonra eklenecektir.
