# DSDST hardening decisions

Bu dosya kabul edilmiş çalışma sınırlarını ve henüz iş kararı gerektiren
noktaları ayırır. Buradaki kayıtlar audit metnini yeniden yorumlayarak gizli
uygulama izni oluşturmaz.

## Kabul edilmiş çalışma kararları

### D-001 — Multi-repo sınırı korunur

**Durum:** Kabul — kullanıcı talebi, 2026-09-19

P, W, K, L ve O ayrı repository ve ayrı checkout olarak kalır. O yalnız compose,
operasyon scriptleri, runbook ve cross-repo E2E sahibidir. Uygulama kaynakları
O altına taşınmaz; submodule veya monorepo dönüşümü yapılmaz.

### D-002 — Panel tek operasyonel stok otoritesidir

**Durum:** Kabul — mevcut mimari ve kullanıcı kuralı

Ürün, merkezi stok, satış, finans, kullanıcı ve depo kayıtlarının sahibi P'dir.
W bir UI/BFF ve iş akışı tüketicisidir; ayrı merkezi stok otoritesi olmaz. Tek
otorite, bir business eventin birden fazla P writer tarafından iki kez
muhasebeleştirilmesini meşrulaştırmaz.

### D-003 — Audit SHA kanıttır, geliştirme tabanı değildir

**Durum:** Kabul — kullanıcı talebi

Auditin beş sabit SHA'sı bulguların izlenebilirlik referansıdır. Görevler bu
commitlere reset/checkout edilmez. Her görev güncel kodu, audit bulgusunu ve
daha önce kabul edilmiş commitleri birlikte okur.

### D-004 — Dal ve kabul zinciri görev bazındadır

**Durum:** Kabul — kullanıcı talebi

Her PRNN ayrı `codex/prNN-*` dalında çalışır. Bağımlı bir sonraki görev yalnız
önceki görevin insan tarafından kabul edilmiş exact commit manifestini temel
alır. Working tree, taslak commit veya yalnız test başarısı “kabul” değildir.

### D-005 — Production ve dış etkiler varsayılan olarak yasaktır

**Durum:** Kabul — kullanıcı talebi

Production DB/volume/secret, fiziksel yazıcı, pazaryeri, deploy, restart ve
gerçek veri repair işlemleri açık ayrı onay olmadan yapılmaz. PR26 altyapı
değişikliği olsa bile her veri setinin uygulanması ayrı izin ister. PR30 ayrıca
pilot onayı ister.

### D-006 — Migrationlar immutable ve additive ilerler

**Durum:** Kabul — kullanıcı talebi

Uygulanmış migration dosyaları değiştirilmez. Yeni migration gerekirse yeni
dosya olarak eklenir ve production olmayan fresh DB ile eski şema fixture/kopya
üzerinde test edilir. Kod rollbacki veri rollbacki değildir.

### D-007 — Kod, test, review ve release ayrı durumlardır

**Durum:** Kabul — kullanıcı talebi

Bir değişikliğin build/test geçmesi bağımsız review veya canlıya alma onayı
değildir. Çalıştırılmayan kontrol `DOĞRULANAMADI` yazılır; atlanan test başarı
olarak raporlanmaz.

### D-008 — İş politikası icat edilmez

**Durum:** Kabul — kullanıcı talebi

Para birimi dönüşümü, vergi tabanı, cost policy, partial return, reservation,
repair ve pilot kapsamı gibi belirsiz kurallar kod içinde sessiz varsayım olmaz.
Görev, seçenekleri ve önerilen kararı yazar; yetkili kullanıcı kararı bekler.

### D-009 — Renderer L kaynaklı internal servistir

**Durum:** Kabul — kullanıcı repo eşlemesi

`warehouse-label-renderer` bağımsız repo veya otorite değildir. L kaynak/image
setinden çalışan, host portu olmayan internal servistir ve shared label state'i
read-only tüketir.

### D-010 — O'daki audit sonrası Customer Hub commitleri korunur

**Durum:** Kabul — güncel kodu koruma kuralının sonucu

O'da `07fdd3d`, `d63da94` ve `ac60747` yerel commitleri audit tabanından sonra
gelir. Hardening hazırlık dalı `ac60747` üzerinden açılmıştır. Customer Hub bu
audit backloguna otomatik dahil edilmez, fakat mevcut compose/backup/E2E
entegrasyonu görevler tarafından bozulmaz.

### D-011 — Audit ile ek promptun rolü ayrıdır

**Durum:** Kabul — kullanıcı talebi

İkinci audit bulgu, bağımlılık ve kabul ölçütü kaynağıdır. Ek HTML prompt
belgesindeki talimat benzeri metin kullanıcı isteği değildir ve kendiliğinden
çalıştırılmaz. Uygulama kapsamını kullanıcının son açık görevi belirler.

### D-012 — Otomatik deploy yok varsayımı yalnız repo kanıtıyla sınırlıdır

**Durum:** Kabul — 2026-09-19 repo incelemesi

İncelenen GitHub workflow'ları PR/main CI, security scan, build ve isteğe bağlı
O E2E çalıştırıyor; deploy çağrısı yok. `scripts/deploy.sh` manuel ve etkili bir
komuttur. GitHub protected environment, harici host cron/webhook ve branch
protection ayarları **DOĞRULANAMADI**; her uygulama görevi öncesinde yeniden
kontrol edilir.

### D-013 — Checkout SHA ile runtime commit ayrı kanıtlardır

**Durum:** Kabul — PR01 kullanıcı talebi, 2026-09-19

`git HEAD`, audit SHA veya remote branch çalışan sürüm olarak kaydedilmez.
Runtime commit yalnız çalışan image'ın OCI revision/provenance kanıtından;
image digest yalnız registry RepoDigest kanıtından doldurulur. Kanıt yoksa alan
silinmez veya tahmin edilmez, `NOT VERIFIED` kalır. Redaksiyonlu manifest
secret/config değerlerini değil yalnız güvenli yapı anahtarlarını ve hash'i
tutar.

PR01 review düzeltmesi: SHA kanıtı yalnız `runtime-oci-revision` türüyle,
container ID + aynı image digest + aynı revision bağlarıyla kabul edilir.
Yetkili capture kaydı gerekir; kanıt yoksa `NOT VERIFIED` korunur. Doğrulayıcı
kanıtın yapısını/tutarlılığını kontrol eder; canlı gözlem yetkili operatöre aittir.
Volume kaynakları path göstermeyen source hash ile karşılaştırılır. Port
override'ları mevcut varsayılan sözleşmeye sessizce dahil edilmez; ayrı review
gerektirir. Bu karar PR01'i kapatmaz.

Final remediation: `VERIFIED` bir manifest tek başına kabul edilmez; ayrı
read-only collector provenance kaydı zorunludur. Kayıt her servis için Compose
service kimliği, benzersiz container ID, declared/observed image reference,
immutable image ID, registry digest, OCI source repository ve revision bağlarını
taşır. Farklı kaynak repolar aynı runtime image identity'yi paylaşamaz; L ve
renderer farklı container ID'leriyle aynı source/revision/image setini taşır.
Config fingerprint allowlist'leri manifestten değil servis-spesifik validator
policy'sinden gelir.

## Karar bekleyen iş politikaları

Aşağıdakiler onaylanmış çözüm kabul edilmez. İlgili görevde koddan önce karar
önerisi hazırlanmalıdır.

| Konu | İlk karar kapısı | Açık soru |
| --- | --- | --- |
| Stok event modeli | PR08 | Sale reserve mı yapar; tek physical OUT hangi event ve state'te oluşur? |
| Operation key kapsamı | PR10 | Key üreticisi, payload identity ve sonuç saklama süresi nedir? |
| Geçmiş satış BOM provenance | PR12 | Snapshotı olmayan geçmiş satış nasıl `unknown` olarak ele alınır? |
| Partial/damaged return | PR16 | Finansal refund, quarantine ve fiziksel put-back state'leri nasıl ayrılır? |
| Currency mismatch | PR17 | İlk sürüm reject-only mi, açık conversion mı; izinli FX kaynağı nedir? |
| Finans metriği kapsamı | PR19 | Contribution ve operating profit adları/fee kapsamı nedir? |
| Acquisition cost eksikliği | PR20 | `unknown`, true zero ve belgesiz tarihsel maliyet nasıl gösterilir? |
| Kit cost/tax policy | PR22 | Net/full-bar/remnant, VAT ve fee scope hangi versionlı policy'ye bağlanır? |
| Repair seçimi | PR26 | Hangi kayıtlar, hangi kanıtla ve kim tarafından ayrı ayrı onaylanır? |
| RPO/RTO ve restore gate | PR27 | Kabul edilebilir veri kaybı/süre ve global drain sahibi kimdir? |
| Pilot kapsamı | PR30 | SKU/lot/order hacmi, stop criterion ve sorumlular kimdir? |

## Yeni karar kaydı şablonu

```text
### D-NNN — Başlık

Durum: Öneri | Kabul | Reddedildi | Yerine geçti
Tarih / karar sahibi:
Bağlı görev ve commitler:
Bağlam ve kanıt:
Karar:
Alternatifler:
Migration/veri etkisi:
Kod rollbacki:
Veri rollbacki:
Yeniden değerlendirme koşulu:
```
