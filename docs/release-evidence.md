# DSDST release evidence

Bu belge PR01'in redaksiyonlu release kanıt sözleşmesidir. Amaç bir Git
checkout'unu çalışan sürüm sanmak değil; çalışan P, W, K, L ve L kaynaklı
`warehouse-label-renderer` için runtime commit, immutable image digest, şema,
yapılandırma, volume, network ve port eşleşmesini aynı kanıt setinde kurmaktır.

Bu repodaki örnek manifest gerçek runtime kanıtı değildir:

- Şablon: `evidence/release-evidence.redacted.json`
- JSON Schema: `schemas/release-evidence.schema.json`
- Doğrulayıcı: `scripts/validate-release-evidence.mjs`
- Fixture testleri: `tests/release-evidence.test.mjs`

## Kanıt kuralları

1. `git rev-parse HEAD`, remote branch SHA'sı, audit SHA'sı veya build context
   SHA'sı tek başına çalışan commit değildir. Runtime commit yalnız çalışan
   image'ın OCI revision label'ından yazılır. `commit.evidence_source` serbest
   metin değildir; collector capture kimliği, Compose service kimliği, tam
   container ID, image reference/ID/digest, OCI source repository ve revision
   bağlarını birlikte taşır. Aynı collector kaydı config fingerprint, read-only
   schema version, volume, network ve port gözlemlerini de aynı capture ve
   container kimliğine bağlar. Bu alanların tamamı provenance kaydıyla birebir
   eşleşmelidir. Label veya collector kaydı yoksa SHA `NOT VERIFIED` kalır. Git
   HEAD dahil başka kaynak türleri reddedilir.
2. Tag (`latest`, semver veya commit tagı) immutable image digest değildir.
   `runtime.image.digest` yalnız registry `RepoDigest` kanıtından doldurulur.
   Çalışan container'ın immutable image ID'si ayrıca tutulur; image ID registry
   digest yerine geçirilmez. Compose service label'ı, container'ın declared
   reference'ı, image'ın aynı reference'ı taşıması ve OCI source repository
   label'ı servis sözleşmesiyle eşleşmelidir.
3. Bilinmeyen alan silinmez, boş bırakılmaz ve tahmin edilmez; tam olarak
   `NOT VERIFIED` yazılır. Stateless alanlarda yalnız şemada izin verilen
   `NOT APPLICABLE` kullanılır.
4. Manifest hiçbir secret veya yapılandırma değeri içermez. Her servisin izinli
   config anahtarları validator içinde sabit authoritative allowlist'tir;
   manifest bu listeyi kuramaz veya genişletemez. Fingerprint collector aynı
   allowlist'i koddan okur. Allowlist dışındaki değerler hash girdisine alınmaz.
5. L ve renderer aynı repository, runtime commit, image reference, image digest
   ve label state kaynağını kullanmalıdır. Renderer state'i `ro`, yalnız
   `internal` networkte ve host portu olmadan tüketir.
6. `evidence_status: VERIFIED`, bütün `NOT VERIFIED` alanlar kapatılmadan,
   `runtime_access: READ-ONLY AUTHORIZED` kaydedilmeden ve her runtime gözlemi
   aynı collector capture/container kaydıyla eşleşmeden doğrulayıcıdan geçmez.
7. Bu süreç deploy, restart, image pull/build, migration veya veri yazısı
   çalıştırmaz. Runtime değiştirildiğinde eski manifest yeni release için
   yeniden kullanılmaz.

Doğrulayıcı gerçek production runtime'a erişmeden fiziksel gerçekliği tek
başına kanıtlayamaz. Runtime collector/provenance yoksa sonuç `NOT VERIFIED`
kalır. `VERIFIED` yalnız ayrı collector kaydı mevcutken ve container, Compose
service, declared/observed image reference, immutable image ID, registry digest,
OCI source/revision, config fingerprint, schema, mount, network ve port
eşleşmeleri başarılı olduğunda üretilir. Capture kimliği tam gözlem setinin
SHA-256 değerinden türetilir ve her servis kaydında tekrarlanır. Sentetik veya
kullanıcı tarafından doldurulmuş manifest tek başına `VERIFIED` üretmez;
sentetik pozitif testler production kanıtı değildir.

## Beklenen compose eşlemesi

Aşağıdaki değerler `compose.prod.yml` beyanıdır; canlıda gözlendiği anlamına
gelmez. Gözlenen değerler manifestin ayrı `observed` alanlarına yazılır.

| Servis | Kaynak | Şema | Declared volumes | Networks | Port |
| --- | --- | --- | --- | --- | --- |
| `dsdst-panel` | P | SQLite | `/data` rw, `/app/uploads` rw, `/backups` rw | edge, internal | loopback `${PANEL_PORT:-3000}` → 3000/tcp |
| `dsdst-warehouse` | W | Yok | Yok | edge, internal | loopback `${WAREHOUSE_PORT:-3006}` → 3006/tcp |
| `dsdst-kit-studio` | K | SQLite | `/data` rw, `/app/uploads` rw | edge, internal | loopback `${KIT_STUDIO_PORT:-3012}` → 3012/tcp |
| `label-printer` | L | JSON state v? | `/app/data` rw | edge, internal | loopback `${LABEL_PRINTER_PORT:-3013}` → 3000/tcp |
| `warehouse-label-renderer` | L | Yok | aynı `/app/data` ro | internal | yalnız internal 3010/tcp |

## Yetki verilirse kullanılabilecek salt-okunur toplama komutları

Bu komutlar bu PR sırasında çalıştırılmadı. Docker socket ve production host
erişimi ayrıca açık yetki ister. Yetkili operatör komutları debug tracing
(`set -x`), `tee` veya terminal kaydı olmadan çalıştırmalıdır.

Önce yetkili hostta yalnız dosya konumlarını tanımla:

```sh
# Bash oturumunda: başarısız Docker komutundan sahte hash üretilmesini engeller.
set -euo pipefail
EVIDENCE_COMPOSE_FILE=/approved/path/dsdst-operations/compose.prod.yml
EVIDENCE_ENV_FILE=/approved/secret-store/runtime.env
```

Tam runtime provenance kaydını collector ile üret. Collector `docker compose
ps`, `docker inspect`, `docker image inspect` ve stateful servislerde yalnız
read-only schema/version sorgusu için exact container ID ile `docker exec`
kullanır; container oluşturmaz, başlatmaz, restart etmez veya veri yazmaz. Çıktı
manifestten ayrı tutulur:

```sh
node scripts/collect-runtime-provenance.mjs \
  "$EVIDENCE_COMPOSE_FILE" "$EVIDENCE_ENV_FILE" \
  > /approved/redacted/runtime-provenance.json
```

Collector her servis için tek ve tam container ID ister; aynı ID'nin iki
serviste kullanımını reddeder. `com.docker.compose.service`, `.Config.Image`,
çalışan immutable `.Image` ID'si, bu ID'nin aynı RepoTag/RepoDigest kaydı ile
`org.opencontainers.image.source` ve `org.opencontainers.image.revision`
label'larını birlikte kontrol eder. Aynı container inspect kaydından yalnız
authoritative allowlist değerlerinin config fingerprint'ini, persistent mount
mapping/source kimliklerini, networkleri ve port bindinglerini üretir. Config
değerlerini, secret/unknown environment değerlerini ve gerçek volume source
path/name değerlerini çıktıya koymaz.

Volume kimliği `SHA256(JSON.stringify([Type, Source]))` biçimindedir. `/tmp`
tmpfs persistent volume sayılmaz. Docker network adları (`dsdst-edge`,
`dsdst-internal`) manifestteki Compose anahtarlarına (`edge`, `internal`)
normalize edilir. Renderer için host binding veya `edge` ağı görülürse collector
fail-closed durur. Farklı kaynak repolar aynı image ID/digest'i paylaşamaz; L ve
renderer farklı container ID'leriyle aynı source/revision/image setini ve aynı
label-state source kimliğini taşımalıdır.

`volumes.declared[].source_id` yetkili operatör tarafından beklenen deployment
mount planından aynı hash algoritmasıyla elde edilir. `observed[].source_id`
yalnız collector kaydından gelir. Beklenen kimlik gözlenenden körlemesine
kopyalanmaz; beklenen plan bilinmiyorsa alan `NOT VERIFIED` kalır. Alias, hedef,
mod ve kaynak kimliği birlikte karşılaştırılır; L–renderer kaynak kimlikleri
ayrıca eşit olmalıdır.

Bu PR'ın port sözleşmesi Compose varsayılanlarıdır: 127.0.0.1 üzerinde
P=3000, W=3006, K=3012, L=3013; renderer internal 3010. Farklı host portu
veya bind adresi olan kurulumlar otomatik kabul edilmez; sözleşme ve testlerin
ayrı review ile güncellenmesi gerekir. Observed portlar sayısal olmalıdır.

Collector Panel ve Kit Studio SQLite dosyalarını `readonly: true` ve
`fileMustExist: true` ile açıp yalnız son migration version alanını; Label
Printer state dosyasından yalnız version alanını okur. Sorgu başarısızsa, version
yoksa veya sonuç beklenen şekilden saparsa capture başarısız olur. Stateful
serviste `compose.prod.yml` schema kanıtı değildir. W ve renderer bağımsız kalıcı
şema sahibi değildir; collector bunları `none` / `NOT APPLICABLE` olarak aynı
capture kaydına bağlar.

## Yasak toplama biçimleri

Aşağıdakiler secret veya kişisel/operasyonel veri sızdırabileceği için kanıt
toplama prosedüründe kullanılmaz:

- `.env`, secret-store veya backup dosyalarını okumak/kopyalamak;
- `docker inspect` çıktısının tamamını kaydetmek;
- `docker compose config` çıktısının tamamını kaydetmek;
- container içinde `env`, `printenv` veya uygulama config dump çalıştırmak;
- SQLite tablo içeriği, müşteri kaydı, ürün/satış verisi veya label state'in
  tamamını sorgulamak;
- `docker compose up`, `pull`, `build`, `restart`, `exec` ile veri yazan komut,
  migration veya restore çalıştırmak.

## Manifest doldurma ve doğrulama

1. Redaksiyonlu şablon kopyalanır; orijinal şablon korunur.
2. Her runtime alanı yalnız karşılık gelen salt-okunur kanıtla doldurulur.
3. Commit, image, config, schema ve observed volume/network/port alanları aynı
   collector provenance kaydıyla birebir doldurulur. Source repository, Compose
   service, capture/container ID, image ID/digest, OCI revision veya runtime
   observation bağlarından biri eksikse ilgili runtime kanıtı yazılmaz.
4. Stateful schema kanıt kaynağı `runtime-collector` olmalıdır. Manifestte elle
   yazılmış fingerprint/schema/topology veya declared alandan kopyalanmış
   `observed` değer collector kaydı yerine geçmez.
5. Herhangi bir alan eksikse `NOT VERIFIED` bırakılır ve manifest statusü
   değiştirilmez.
6. Doğrulayıcı çalıştırılır:

```sh
npm ci --ignore-scripts
node scripts/validate-release-evidence.mjs evidence/release-evidence.redacted.json
node --test tests/release-evidence.test.mjs
```

Yukarıdaki örnek manifest `NOT VERIFIED` olduğundan provenance dosyası istemez.
Yetkili runtime kaydının doğrulanması ikinci argümanı zorunlu kullanır:

```sh
node scripts/validate-release-evidence.mjs \
  /approved/redacted/release-evidence.json \
  /approved/redacted/runtime-provenance.json
```

`VERIFIED` manifest provenance argümanı olmadan reddedilir. Provenance kaydı da
manifestteki capture zamanı, tam gözlem setinden türetilen capture kimliği ve her
servisin container/image/config/schema/topology alanlarıyla tam eşleşmelidir.

Doğrulayıcı eksik commit/digest/provenance alanını, yeniden kullanılan container
kimliğini, yanlış Compose service veya source repository'yi, declared/observed
image farkını, eksik runtime observation'ı, başka capture/container kanıtını,
fabricated config/schema/topology alanlarını, L–renderer provenance farkını,
authoritative config allowlist sapmasını ve bilinmeyen içeren `VERIFIED`
manifesti reddeder.

## Bu PR'ın kanıt durumu

- P/W/K/L/renderer gerçek runtime commitleri: **NOT VERIFIED**
- Registry image digestleri: **NOT VERIFIED**
- Production şema sürümleri: **NOT VERIFIED**
- Runtime config fingerprintleri: **NOT VERIFIED**
- Gözlenen volume/network/portlar: **NOT VERIFIED**
- Deploy, restart, migration ve veri etkisi: **YOK**

Bu nedenle örnek manifestin doğru durumu `NOT VERIFIED`'dır. Yerel Git
checkoutları erişilebilir olsa da çalışan sürüm olarak raporlanmamıştır.
