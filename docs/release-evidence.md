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
   metin değildir: `{kind: "runtime-oci-revision", container_id, image_digest,
   revision}` nesnesidir. Revision SHA ile, image_digest çalışan image'ın
   registry digest değeriyle eşleşmelidir. Tam container ID, yetkili capture
   zamanı ve `READ-ONLY AUTHORIZED` gerekir. Label yoksa SHA `NOT VERIFIED`
   kalır. Git HEAD dahil başka kaynak türleri reddedilir.
2. Tag (`latest`, semver veya commit tagı) immutable image digest değildir.
   `runtime.image.digest` yalnız registry `RepoDigest` kanıtından doldurulur.
   Yerel image ID bir registry digest yerine geçirilmez.
3. Bilinmeyen alan silinmez, boş bırakılmaz ve tahmin edilmez; tam olarak
   `NOT VERIFIED` yazılır. Stateless alanlarda yalnız şemada izin verilen
   `NOT APPLICABLE` kullanılır.
4. Manifest hiçbir secret veya yapılandırma değeri içermez. Yapılandırma için
   yalnız izinli anahtar adları ve izinli yapılandırmanın SHA-256 fingerprint'i
   tutulur; secret değerleri hash girdisine dahi alınmaz.
5. L ve renderer aynı repository, runtime commit, image reference, image digest
   ve label state kaynağını kullanmalıdır. Renderer state'i `ro`, yalnız
   `internal` networkte ve host portu olmadan tüketir.
6. `evidence_status: VERIFIED`, bütün `NOT VERIFIED` alanlar kapatılmadan ve
   `runtime_access: READ-ONLY AUTHORIZED` kaydedilmeden doğrulayıcıdan geçmez.
7. Bu süreç deploy, restart, image pull/build, migration veya veri yazısı
   çalıştırmaz. Runtime değiştirildiğinde eski manifest yeni release için
   yeniden kullanılmaz.

Doğrulayıcı çevrimdışı kanıt sözleşmesini denetler; Docker'a bağlanmaz ve
operatörün ürettiği bir kaydın gerçekliğini kendisi tasdik edemez. `VERIFIED`
yalnız yetkili operatörün gerçekten topladığı kayıtta kullanılabilir. Sentetik
pozitif testler production kanıtı değildir.

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

Servis/container kimliğini oku; bu komut container oluşturmaz veya başlatmaz:

```sh
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" ps --status running
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" ps -q dsdst-panel
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" ps -q dsdst-warehouse
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" ps -q dsdst-kit-studio
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" ps -q label-printer
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" ps -q warehouse-label-renderer
```

Her container için çalışan image ID, beyan edilen image reference, registry
digest ve OCI revision label'ını ayrı oku. Aşağıdaki `EVIDENCE_CONTAINER_ID`
yalnız yukarıdaki `ps -q` çıktısından alınır:

```sh
docker inspect --format '{{.Image}}' "$EVIDENCE_CONTAINER_ID"
docker inspect --format '{{.Config.Image}}' "$EVIDENCE_CONTAINER_ID"
docker image inspect "$(docker inspect --format '{{.Image}}' "$EVIDENCE_CONTAINER_ID")" --format '{{json .RepoDigests}}'
docker image inspect "$(docker inspect --format '{{.Image}}' "$EVIDENCE_CONTAINER_ID")" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

`RepoDigests` boşsa digest `NOT VERIFIED` kalır. Revision label yoksa local
repo `HEAD` kullanılmaz; commit `NOT VERIFIED` kalır. OCI revision kanıtı
container ID ve aynı image'ın registry digest değeriyle birlikte kaydedilir.

Environment değerlerini ekrana vermeden izinli config fingerprint'i üret.
`EVIDENCE_SERVICE_ID` manifestteki servis ID'sidir. Bu komut O checkout'unda
çalıştırılır. Ara Docker çıktısına `tee` veya yönlendirme eklenmez:

```sh
docker inspect --format '{{json .Config.Env}}' "$EVIDENCE_CONTAINER_ID" \
  | node --input-type=module -e '
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const m=JSON.parse(readFileSync("evidence/release-evidence.redacted.json"));
const service=m.services.find(s=>s.service_id===process.argv[1]);
if(!service) process.exit(1);
let input=""; for await(const c of process.stdin) input+=c;
const allowed=new Set(service.runtime.configuration.safe_keys);
const pairs=JSON.parse(input).map(s=>[s.slice(0,s.indexOf("=")),s.slice(s.indexOf("=")+1)]).filter(([k])=>allowed.has(k)).sort(([a],[b])=>a.localeCompare(b));
console.log("sha256:"+createHash("sha256").update(JSON.stringify(pairs)).digest("hex"));
' "$EVIDENCE_SERVICE_ID"
```

Volume kaynak path/name değerlerini göstermeden kaynak kimliğini hashle.
Kimlik `SHA256(JSON.stringify([Type, Source]))` şeklindedir. Aynı hosttaki L
ve renderer aynı kimliği vermelidir. `/tmp` tmpfs persistent volume değildir
ve aşağıdaki çıktıdan çıkarılır. Host yolu çıktı veya repoya yazılmaz:

```sh
docker inspect --format '{{json .Mounts}}' "$EVIDENCE_CONTAINER_ID" \
  | node --input-type=module -e '
import {createHash} from "node:crypto";
let input="";for await(const c of process.stdin)input+=c;
console.log(JSON.stringify(JSON.parse(input).filter(m=>m.Type!=="tmpfs").map(m=>({target:m.Destination,mode:m.RW?"rw":"ro",source_id:"sha256:"+createHash("sha256").update(JSON.stringify([m.Type,m.Source])).digest("hex")}))));'
```

Network ve port eşleşmesi secret içermez:

```sh
docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$EVIDENCE_CONTAINER_ID"
docker inspect --format '{{json .NetworkSettings.Ports}}' "$EVIDENCE_CONTAINER_ID"
```

Docker gerçek network adları (`dsdst-edge`, `dsdst-internal`) manifestte
compose anahtarları (`edge`, `internal`) olarak normalize edilir. Renderer için
host binding görülürse veya `edge` ağı görülürse manifest reddedilmelidir.

`volumes.declared[].source_id` yetkili operatör tarafından beklenen deployment
mount planından aynı hash algoritmasıyla elde edilir. `observed[].source_id`
yukarıdaki runtime komutundan gelir. Beklenen kimlik gözlenenden körlemesine
kopyalanmaz; beklenen plan bilinmiyorsa alan `NOT VERIFIED` kalır. Alias,
hedef, mod ve kaynak kimliği birlikte karşılaştırılır; L–renderer kaynak
kimlikleri ayrıca eşit olmalıdır.

Bu PR'ın port sözleşmesi Compose varsayılanlarıdır: 127.0.0.1 üzerinde
P=3000, W=3006, K=3012, L=3013; renderer internal 3010. Farklı host portu
veya bind adresi olan kurulumlar otomatik kabul edilmez; sözleşme ve testlerin
ayrı review ile güncellenmesi gerekir. Observed portlar sayısal olmalıdır.

Panel SQLite migration seviyesini DB'yi read-only açarak oku:

```sh
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" exec -T dsdst-panel \
  node -e 'const Database=require("better-sqlite3");const db=new Database("/data/dsdst_panel.db",{readonly:true,fileMustExist:true});console.log(JSON.stringify(db.prepare("SELECT version,name FROM schema_migrations ORDER BY version DESC LIMIT 1").get()||null));db.close()'
```

Kit Studio migration seviyesini aynı şekilde read-only açarak oku:

```sh
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" exec -T dsdst-kit-studio \
  node -e 'const Database=require("better-sqlite3");const db=new Database("/data/dsdst-kit-studio.db",{readonly:true,fileMustExist:true});console.log(JSON.stringify(db.prepare("SELECT version,name FROM schema_migrations ORDER BY version DESC LIMIT 1").get()||null));db.close()'
```

Label state için yalnız version alanını oku; ürün, şablon veya ayar içeriğini
çıktılama:

```sh
docker compose --env-file "$EVIDENCE_ENV_FILE" -f "$EVIDENCE_COMPOSE_FILE" exec -T label-printer \
  node -e 'const fs=require("node:fs");const state=JSON.parse(fs.readFileSync("/app/data/app-state.json","utf8"));console.log(JSON.stringify({version:state.version??null}))'
```

W ve renderer bağımsız kalıcı şema sahibi değildir; bunlar `none` / `NOT
APPLICABLE` kalır. Bir DB dosyası veya writable state mount görülürse beklenen
servis eşleşmesiyle çelişir ve araştırılmadan manifest doğrulanmaz.

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
3. Commit kanıtı yukarıdaki yapılandırılmış nesnedir. Image kaynağı yalnız
   `docker image inspect`, şema kaynağı `read-only schema query` veya stateless
   servisler için `compose.prod.yml` olur. Bilinmeyenler `NOT VERIFIED` kalır.
4. Gözlenen mount/network/portlar normalize edilerek `observed` alanına yazılır.
5. Herhangi bir alan eksikse `NOT VERIFIED` bırakılır ve manifest statusü
   değiştirilmez.
6. Doğrulayıcı çalıştırılır:

```sh
npm ci --ignore-scripts
node scripts/validate-release-evidence.mjs evidence/release-evidence.redacted.json
node --test tests/release-evidence.test.mjs
```

Doğrulayıcı eksik commit/digest alanını, eksik servisleri, P/W/K/L/renderer
repo ve topology sapmasını, L–renderer commit/image farkını, secret benzeri
config anahtarlarını ve bilinmeyen içeren `VERIFIED` manifesti reddeder.

## Bu PR'ın kanıt durumu

- P/W/K/L/renderer gerçek runtime commitleri: **NOT VERIFIED**
- Registry image digestleri: **NOT VERIFIED**
- Production şema sürümleri: **NOT VERIFIED**
- Runtime config fingerprintleri: **NOT VERIFIED**
- Gözlenen volume/network/portlar: **NOT VERIFIED**
- Deploy, restart, migration ve veri etkisi: **YOK**

Bu nedenle örnek manifestin doğru durumu `NOT VERIFIED`'dır. Yerel Git
checkoutları erişilebilir olsa da çalışan sürüm olarak raporlanmamıştır.
