import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';

import {
  buildBootstrapManifest,
  finalizeBootstrapPoint,
  promoteBootstrapSuccess,
  restoreBootstrapPoint,
  signBootstrapManifest,
  stageBootstrapOffsite,
  verifyBootstrapPoint,
  verifyCandidateAgainstBootstrap,
} from '../scripts/bootstrap-lib.mjs';

const KEY = 'bootstrap-test-hmac-key-material-0123456789abcdef';
const KEY_ID = 'bootstrap-test-v1';
const dirs = [];
test.after(() => dirs.forEach((dir) => fs.rmSync(dir, {recursive: true, force: true})));

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsdst-v218-bootstrap-'));
  dirs.push(dir);
  return dir;
}
function sqlite(filePath, version) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const db = new DatabaseSync(filePath);
  db.exec('CREATE TABLE schema_migrations(version INTEGER NOT NULL); CREATE TABLE records(id INTEGER PRIMARY KEY);');
  db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(version);
  db.prepare('INSERT INTO records(id) VALUES (1)').run();
  db.close();
}
function archive(filePath, files) {
  const root = temp();
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, content);
  }
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  execFileSync('tar', ['-czf', filePath, '-C', root, '.']);
}
function legacyRuntime() {
  const src = (digit) => `sha256:${digit.repeat(64)}`;
  return {
    evidence_version: 'dsdst.legacy-runtime.v1',
    captured_at: '2026-09-23T22:00:00.000Z',
    capture_completed_at: '2026-09-23T22:00:05.000Z',
    source_provenance_state: 'UNVERIFIED_LEGACY',
    source_revision_claimed: false,
    services: [
      {service_id:'dsdst-panel',container_name:'p',container_id:'1'.repeat(64),image_reference:'dsdst-panel:operations-v1',image_id:src('a'),source_revision:null,source_revision_verified:false,mounts:[{target:'/data',mode:'rw',type:'volume',source_id:src('1')},{target:'/app/uploads',mode:'rw',type:'volume',source_id:src('2')}]},
      {service_id:'dsdst-warehouse',container_name:'w',container_id:'2'.repeat(64),image_reference:'dsdst-warehouse:operations-v1',image_id:src('b'),source_revision:null,source_revision_verified:false,mounts:[]},
      {service_id:'dsdst-kit-studio',container_name:'k',container_id:'3'.repeat(64),image_reference:'dsdst-kit-studio:operations-v1',image_id:src('c'),source_revision:null,source_revision_verified:false,mounts:[{target:'/data',mode:'rw',type:'volume',source_id:src('3')},{target:'/app/uploads',mode:'rw',type:'volume',source_id:src('4')}]},
      {service_id:'dsdst-customer-hub',container_name:'h',container_id:'4'.repeat(64),image_reference:'dsdst-customer-hub:preview',image_id:src('d'),source_revision:null,source_revision_verified:false,mounts:[{target:'/data',mode:'rw',type:'volume',source_id:src('5')}]},
      {service_id:'label-printer',container_name:'l',container_id:'5'.repeat(64),image_reference:'label-printer:operations-v1',image_id:src('e'),source_revision:null,source_revision_verified:false,mounts:[{target:'/app/data',mode:'rw',type:'volume',source_id:src('6')}]},
      {service_id:'warehouse-label-renderer',container_name:'r',container_id:'6'.repeat(64),image_reference:'label-printer:operations-v1',image_id:src('e'),source_revision:null,source_revision_verified:false,mounts:[{target:'/app/data',mode:'ro',type:'volume',source_id:src('6')}]},
    ],
  };
}
function pointFixture() {
  const root = temp();
  const point = path.join(root, 'bootstrap-fixture');
  sqlite(path.join(point, 'payload/panel/database.sqlite'), 67);
  sqlite(path.join(point, 'payload/kit/database.sqlite'), 10);
  sqlite(path.join(point, 'payload/customer-hub/database.sqlite'), 4);
  archive(path.join(point, 'payload/panel/uploads.tar.gz'), {'products/a.txt':'panel'});
  archive(path.join(point, 'payload/kit/uploads.tar.gz'), {'kit/a.txt':'kit'});
  archive(path.join(point, 'payload/label/state.tar.gz'), {'app-state.json':JSON.stringify({version:3})});
  archive(path.join(point, 'payload/customer-hub/attachments.tar.gz'), {'a.txt':'hub'});
  fs.mkdirSync(path.join(point, 'provenance'), {recursive:true});
  fs.writeFileSync(path.join(point, 'provenance/legacy-runtime.json'), JSON.stringify(legacyRuntime(), null, 2));
  const manifest = buildBootstrapManifest(point, {
    bootstrapId:'bootstrap-fixture',
    createdAt:'2026-09-23T22:00:00.000Z',
    completedAt:'2026-09-23T22:00:10.000Z',
    manifestKey:KEY,
    manifestKeyId:KEY_ID,
  });
  return {root, point, manifest};
}
function acceptFixture(fixture) {
  const candidate = path.join(fixture.point, '.manifest.final.json');
  stageBootstrapOffsite(fixture.point, candidate, {
    remoteRoot:'dsdstr2:dsdst-recovery/production/recovery-points/legacy-bootstrap/bootstrap-fixture',
    configFingerprint:`sha256:${'9'.repeat(64)}`,
    payloadPath:'dsdstr2:dsdst-recovery/production/recovery-points/legacy-bootstrap/bootstrap-fixture/payload.tar.gz.enc',
    payloadSha256:'8'.repeat(64),
    payloadSize:1234,
    persistedAt:'2026-09-23T22:01:00.000Z',
    manifestPath:'dsdstr2:dsdst-recovery/production/recovery-points/legacy-bootstrap/bootstrap-fixture/manifest.json.enc',
  }, {manifestKey:KEY, manifestKeyId:KEY_ID});
  promoteBootstrapSuccess(fixture.point, candidate, {manifestKey:KEY, manifestKeyId:KEY_ID});
  finalizeBootstrapPoint(fixture.point, candidate, {manifestKey:KEY, manifestKeyId:KEY_ID});
  return verifyBootstrapPoint(fixture.point, {manifestKey:KEY, requireAccepted:true});
}

const SOURCE_SET = {
  release:'V2-18',
  repositories:[
    {repository:'agungor189/dsdst-operations', revision:'c632d0fd8d768529795d933d3d4f1d369a26faf1'},
    {repository:'agungor189/panel-kit-yonetimi', revision:'3f90996cedc73ff6f656d264db3ee3baa0bbdd03'},
    {repository:'agungor189/Dsdst-Warehouse', revision:'525e18c508c1191c0c4e4b725bda00defd930d2f'},
    {repository:'agungor189/dsdst-kit-studio', revision:'0e0717c3f8d3f3f0af186b4c165524bc2e81724c'},
    {repository:'agungor189/Label-Printer', revision:'add3987e0eb15e8742ecac490b5eb4e78b620ce5'},
    {repository:'agungor189/dsdst-customer-hub', revision:'79834966b43daec4ca32f906534aaf11fadd9d55'},
  ],
};
function candidateRuntime({reuseLegacy=false, wrongRevision=false}={}) {
  const repo = {
    'dsdst-panel':'agungor189/panel-kit-yonetimi',
    'dsdst-warehouse':'agungor189/Dsdst-Warehouse',
    'dsdst-kit-studio':'agungor189/dsdst-kit-studio',
    'dsdst-customer-hub':'agungor189/dsdst-customer-hub',
    'label-printer':'agungor189/Label-Printer',
    'warehouse-label-renderer':'agungor189/Label-Printer',
  };
  const revision = Object.fromEntries(SOURCE_SET.repositories.map((entry)=>[entry.repository,entry.revision]));
  const serviceIds = Object.keys(repo);
  return {
    services: serviceIds.map((service_id, index) => ({
      service_id,
      source_repository:repo[service_id],
      revision: wrongRevision && service_id==='dsdst-panel' ? 'f'.repeat(40) : revision[repo[service_id]],
      image_digest:`sha256:${String(index+1).repeat(64).slice(0,64)}`,
      image_id:`sha256:${String(index+7).repeat(64).slice(0,64)}`,
      configuration:{status:'VERIFIED'},
      volumes: service_id==='dsdst-warehouse' ? [] : [{target: service_id.includes('label') || service_id.includes('renderer') ? '/app/data':'/data', source_id: reuseLegacy && service_id==='dsdst-panel' ? `sha256:${'1'.repeat(64)}` : `sha256:${String.fromCharCode(97+index).repeat(64)}`}],
      ports: service_id==='warehouse-label-renderer' ? [{exposure:'internal',host_ip:'NOT APPLICABLE'}] : [{exposure:'published',host_ip:'127.0.0.1'}],
    })),
  };
}
// Make Label and renderer share the candidate state source, as the real contract requires.
function normalizeLabel(runtime) {
  const label = runtime.services.find((s)=>s.service_id==='label-printer');
  const renderer = runtime.services.find((s)=>s.service_id==='warehouse-label-renderer');
  renderer.volumes[0].source_id = label.volumes[0].source_id;
  renderer.image_digest = label.image_digest;
  renderer.image_id = label.image_id;
  return runtime;
}

test('legacy bootstrap manifest never claims canonical recovery or Git source provenance', () => {
  const fixture = pointFixture();
  assert.equal(fixture.manifest.canonical_recovery_point, false);
  assert.equal(fixture.manifest.final_cutover_source, false);
  assert.equal(fixture.manifest.source.source_provenance_state, 'UNVERIFIED_LEGACY');
  assert.equal(fixture.manifest.source.source_revision_claimed, false);
  assert.equal(fixture.manifest.status, 'INCOMPLETE');
  assert.throws(()=>verifyBootstrapPoint(fixture.point,{manifestKey:KEY,requireAccepted:true}),/not accepted/i);
});

test('accepted bootstrap point requires encrypted persisted offsite evidence and survives isolated restore', () => {
  const fixture = pointFixture();
  const manifest = acceptFixture(fixture);
  assert.equal(manifest.status, 'SUCCESS');
  assert.equal(manifest.offsite.state, 'PERSISTED');
  assert.equal(manifest.offsite.encrypted, true);
  const target = path.join(fixture.root, 'restore', 'candidate-seed');
  const restored = restoreBootstrapPoint(fixture.point, target, {manifestKey:KEY});
  assert.equal(restored.state, 'VERIFIED_BOOTSTRAP_RESTORE');
  assert.ok(fs.existsSync(path.join(target, 'panel/data/dsdst_panel.db')));
  assert.ok(fs.existsSync(path.join(target, 'label/data/app-state.json')));
  assert.ok(fs.existsSync(path.join(target, 'customer-hub/data/attachments/a.txt')));
});

test('bootstrap manifest tampering and attempted provenance upgrade fail closed', () => {
  const fixture = pointFixture();
  const manifestPath = path.join(fixture.point,'manifest.json');
  const tampered = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  tampered.source.source_revision_claimed = true;
  fs.writeFileSync(manifestPath, JSON.stringify(tampered));
  assert.throws(()=>verifyBootstrapPoint(fixture.point,{manifestKey:KEY}),/integrity|provenance/i);

  const fixture2 = pointFixture();
  const upgraded = JSON.parse(fs.readFileSync(path.join(fixture2.point,'manifest.json'),'utf8'));
  upgraded.source.source_revision_claimed = true;
  const resigned = signBootstrapManifest(upgraded,{manifestKey:KEY,manifestKeyId:KEY_ID});
  fs.writeFileSync(path.join(fixture2.point,'manifest.json'),JSON.stringify(resigned));
  assert.throws(()=>verifyBootstrapPoint(fixture2.point,{manifestKey:KEY}),/improperly upgraded/i);
});

test('candidate verification requires exact V2-18 revisions, loopback bindings, and disjoint legacy volumes', () => {
  const fixture = pointFixture();
  acceptFixture(fixture);
  const good = normalizeLabel(candidateRuntime());
  assert.equal(verifyCandidateAgainstBootstrap(fixture.point, good, SOURCE_SET, {manifestKey:KEY}).candidate_status, 'VERIFIED_EXACT_V2_18');

  const wrong = normalizeLabel(candidateRuntime({wrongRevision:true}));
  assert.throws(()=>verifyCandidateAgainstBootstrap(fixture.point, wrong, SOURCE_SET, {manifestKey:KEY}),/revision mismatch/i);

  const reused = normalizeLabel(candidateRuntime({reuseLegacy:true}));
  assert.throws(()=>verifyCandidateAgainstBootstrap(fixture.point, reused, SOURCE_SET, {manifestKey:KEY}),/reuses a legacy production volume/i);

  const publicPort = normalizeLabel(candidateRuntime());
  publicPort.services.find((s)=>s.service_id==='dsdst-panel').ports[0].host_ip='0.0.0.0';
  assert.throws(()=>verifyCandidateAgainstBootstrap(fixture.point, publicPort, SOURCE_SET, {manifestKey:KEY}),/loopback/i);
});

test('bootstrap orchestration uses online SQLite backup and preserves normal V2-18 recovery semantics', () => {
  const root = new URL('..', import.meta.url).pathname;
  const payloadScript = fs.readFileSync(path.join(root,'scripts/bootstrap-create-payload.sh'),'utf8');
  const candidateScript = fs.readFileSync(path.join(root,'scripts/bootstrap-candidate.sh'),'utf8');
  const recoveryScript = fs.readFileSync(path.join(root,'scripts/bootstrap-create-v2-18-recovery.sh'),'utf8');
  assert.match(payloadScript,/sqlite-online-backup\.mjs[\s\S]*panel-data/);
  assert.match(payloadScript,/sqlite-online-backup\.mjs[\s\S]*kit-data/);
  assert.match(payloadScript,/sqlite-online-backup\.mjs[\s\S]*customer-hub-data/);
  assert.doesNotMatch(payloadScript,/cp .*\.db/);
  assert.match(candidateScript,/compose up -d --no-build --wait/);
  assert.match(candidateScript,/verify-candidate/);
  assert.match(candidateScript,/127\.0\.0\.1/);
  assert.match(recoveryScript,/recovery-cli\.mjs" build/);
  assert.match(recoveryScript,/verify --require-accepted/);
  assert.match(recoveryScript,/restore-drill\.sh" --full/);
  assert.doesNotMatch(recoveryScript,/cloudflare-route|cutover/);
});

test('bootstrap seeds isolated Kit, Label and Hub service principals without changing Warehouse authority', () => {
  const root = new URL('..', import.meta.url).pathname;
  const dbPath = path.join(temp(), 'panel-service-keys.sqlite');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE panel_api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_prefix TEXT,
      key_hash TEXT UNIQUE,
      last4 TEXT,
      status TEXT,
      environment TEXT,
      permissions TEXT,
      allowed_ips TEXT,
      expires_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      revoked_at TEXT
    );
  `);

  db.prepare(`
    INSERT INTO panel_api_keys
      (id,name,key_prefix,key_hash,last4,status,environment,permissions)
    VALUES
      ('warehouse-production','Warehouse Production','warehouse','existing-hash','0001','active','live','["read:warehouse_orders"]')
  `).run();

  db.close();

  execFileSync(process.execPath, [
    path.join(root, 'scripts/bootstrap-seed-service-keys.mjs'),
    dbPath,
  ], {
    env: {
      ...process.env,
      PANEL_API_HASH_SECRET: 'x'.repeat(64),
      WAREHOUSE_API_KEY: 'warehouse-existing-key',
      KIT_STUDIO_API_KEY: 'bootstrap-kit-key',
      LABEL_PRINTER_API_KEY: 'bootstrap-label-key',
      CUSTOMER_HUB_API_KEY: 'bootstrap-hub-key',
    },
  });

  const verify = new DatabaseSync(dbPath, {readOnly:true});

  const rows = verify.prepare(`
    SELECT id,name,status,environment,permissions
    FROM panel_api_keys
    ORDER BY id
  `).all();

  verify.close();

  assert.equal(rows.length, 4);

  const warehouse = rows.find((row) => row.id === 'warehouse-production');
  assert.equal(warehouse.name, 'Warehouse Production');
  assert.equal(warehouse.environment, 'live');

  const kit = rows.find((row) => row.id === 'bootstrap-v2-18-kit');
  const label = rows.find((row) => row.id === 'bootstrap-v2-18-label');
  const hub = rows.find((row) => row.id === 'bootstrap-v2-18-customer-hub');

  assert.ok(kit && label && hub);

  assert.deepEqual(JSON.parse(kit.permissions), [
    'auth:login',
    'auth:session:validate',
    'auth:session:revoke',
    'auth:password:change',
    'kit-catalog:read',
    'catalog:read',
  ]);

  for (const principal of [label, hub]) {
    assert.deepEqual(JSON.parse(principal.permissions), [
      'auth:login',
      'auth:session:validate',
      'auth:session:revoke',
      'auth:password:change',
    ]);
  }
});

test('release candidate state volumes disable Docker image copy-up', () => {
  const root = new URL('..', import.meta.url).pathname;
  const overlay = fs.readFileSync(path.join(root, 'compose.release-candidate.yml'), 'utf8');

  for (const source of [
    'candidate_panel_data',
    'candidate_panel_uploads',
    'candidate_panel_backups',
    'candidate_kit_data',
    'candidate_kit_uploads',
    'candidate_customer_hub_data',
    'candidate_customer_hub_backups',
    'candidate_label_data',
  ]) {
    const index = overlay.indexOf(`source: ${source}`);
    assert.ok(index >= 0, `${source} must exist in candidate overlay`);

    const block = overlay.slice(index, index + 180);
    assert.match(block, /nocopy:\s*true/, `${source} must disable image copy-up`);
  }
});

test('bootstrap hydration runs with temporary root privilege and hands state back to runtime node ownership', () => {
  const root = new URL('..', import.meta.url).pathname;
  const candidate = fs.readFileSync(path.join(root, 'scripts/bootstrap-candidate.sh'), 'utf8');
  const hydrate = fs.readFileSync(path.join(root, 'scripts/bootstrap-hydrate-volumes.sh'), 'utf8');

  assert.match(candidate, /docker run --rm[\s\S]{0,120}--user 0:0/);
  assert.match(candidate, /TARGET_UID=1000/);
  assert.match(candidate, /TARGET_GID=1000/);

  assert.match(hydrate, /TARGET_UID:\?TARGET_UID is required/);
  assert.match(hydrate, /TARGET_GID:\?TARGET_GID is required/);
  assert.match(hydrate, /chown -R "\$\{TARGET_UID\}:\$\{TARGET_GID\}"/);
});

test('runtime provenance ignores unbound image EXPOSE metadata but rejects unexpected published ports', async () => {
  const {collectContainerObservations} = await import('../scripts/collect-runtime-provenance.mjs');
  const {getRuntimeServicePolicies} = await import('../scripts/validate-release-evidence.mjs');

  const policy = getRuntimeServicePolicies()
    .find((entry) => entry.service_id === 'label-printer');

  const container = {
    Config: {
      Env: [
        'NODE_ENV=production',
        'PORT=3000',
        'DATA_DIR=/app/data',
        'STATE_FILE=app-state.json',
        'PANEL_API_URL=http://dsdst-panel:3000',
        'COOKIE_SECURE=false',
        'TRUST_PROXY_HOPS=0',
      ],
    },
    Mounts: [
      {
        Type: 'volume',
        Source: '/var/lib/docker/volumes/test-label/_data',
        Destination: '/app/data',
        RW: true,
      },
    ],
    NetworkSettings: {
      Networks: {
        'dsdst-edge': {},
        'dsdst-internal': {},
      },
      Ports: {
        '3000/tcp': [
          {HostIp: '127.0.0.1', HostPort: '13013'},
        ],
        '3010/tcp': null,
      },
    },
  };

  const schema = {
    kind: 'json-state',
    version: '3',
    evidence_source: 'runtime-collector',
  };

  const observation = collectContainerObservations(policy, container, schema);

  assert.equal(observation.ports.length, 1);
  assert.equal(observation.ports[0].container_port, 3000);
  assert.equal(observation.ports[0].host_ip, '127.0.0.1');

  container.NetworkSettings.Ports['3010/tcp'] = [
    {HostIp: '127.0.0.1', HostPort: '13999'},
  ];

  assert.throws(
    () => collectContainerObservations(policy, container, schema),
    /unexpected runtime port is published/i,
  );
});
