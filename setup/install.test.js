'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Real filesystem effects are confined to a fresh temp directory. Slow/external
// MySQL and child-process boundaries are controlled; orchestration is production code.
const exported = require('./install.js');
function fixture(t, options = {}) {
  assert.equal(typeof exported.createInstaller, 'function', 'installer must expose isolated orchestration without running on import');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'glimmer-install-'));
  const backend=path.join(root,'后端源码'); fs.mkdirSync(backend);
  fs.writeFileSync(path.join(backend,'.env.example'),'PORT=3000\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_USER=root\nDB_PASSWORD=placeholder\nDB_NAME=peizhe\nJWT_SECRET=placeholder\nDEEPSEEK_API_KEY=placeholder\n');
  const mysqlBase=path.join(root,'mysql'); fs.mkdirSync(path.join(mysqlBase,'bin'),{recursive:true});
  fs.writeFileSync(path.join(mysqlBase,'bin',process.platform==='win32'?'mysqld.exe':'mysqld'),'fixture');
  const calls=[], output=[]; let listening=false, auth='';
  const child=new EventEmitter(); child.exitCode=null;child.killed=false;child.unref=()=>{};child.kill=()=>{child.killed=true;};
  const io={
    log:m=>output.push(m),
    portOpen:async port=> options.occupied?.includes(port)||listening,
    installDeps:async()=>calls.push(['deps']),
    dependencies:()=>({dotenv:require('../后端源码/node_modules/dotenv'),mysql:{createConnection:async config=>{
      calls.push(['connect',{...config}]);
      if(options.connectError)throw Object.assign(Error('do not print password '+config.password),{code:'ER_ACCESS_DENIED_ERROR'});
      if(config.password!==auth)throw Object.assign(Error('bad auth'),{code:'ER_ACCESS_DENIED_ERROR'});
      return {query:async(sql,args)=>{
        calls.push(['query',sql,args]);
        if(sql.startsWith('SELECT'))return [[{port:options.identityPort||3318,uuid:options.wrongUuid?'foreign':'11111111-1111-1111-1111-111111111111'}]];
        if(sql.startsWith('ALTER USER'))auth=args[0];
        return [[]];
      },end:async()=>{}};
    }}}),
    spawnSync:(file,args,opts)=>{calls.push(['sync',file,args,opts]); if(args.includes('--initialize-insecure')){fs.mkdirSync(path.join(opts.cwd,'mysql'));fs.writeFileSync(path.join(opts.cwd,'auto.cnf'),'server-uuid=11111111-1111-1111-1111-111111111111\n');}return {status:options.scriptFailure&&args.includes(options.scriptFailure)?1:0};},
    spawn:(file,args,opts)=>{calls.push(['spawn',file,args,opts]);listening=true;return child;},
    sleep:async()=>{},
  };
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const env={MYSQL_BASEDIR:mysqlBase,MYSQL_DATA_DIR:path.join(root,'fresh-data')};
  const build=(args=[],extra={})=>exported.createInstaller({root,args,env:{...env,...extra},io});
  return {root,backend,calls,output,child,build,env,io,setAuth:value=>{auth=value;}};
}

test('--check does not install, start, connect, initialize, or write',async t=>{
  const f=fixture(t);await f.build(['--check','--private-port','3318']).run();
  assert.equal(f.calls.length,0); assert.equal(fs.existsSync(f.env.MYSQL_DATA_DIR),false);
  assert.equal(fs.existsSync(path.join(f.backend,'.env')),false);
});
test('invalid ports stop before every side effect',async t=>{
  const f=fixture(t);await assert.rejects(()=>f.build(['--private-port=0']).run(),/port|端口/i);
  assert.equal(f.calls.length,0);
});
test('existing configuration cannot be replaced by private installation',async t=>{
  const f=fixture(t);const p=path.join(f.backend,'.env');fs.writeFileSync(p,'DB_PASSWORD=original-secret\nDB_PORT=3307\n');
  await assert.rejects(()=>f.build(['--force-private']).run(),/已有|已存在/);
  assert.equal(fs.readFileSync(p,'utf8'),'DB_PASSWORD=original-secret\nDB_PORT=3307\n');assert.equal(f.calls.length,0);
});
test('existing configuration requires explicit existing-instance authorization',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.backend,'.env'),'DB_PASSWORD=original-secret\nDB_PORT=3307\n');
  await f.build([]).run();assert.equal(f.calls.length,0);
});
test('occupied explicit private port cannot trigger initialization or authentication',async t=>{
  const f=fixture(t,{occupied:[3318]});await assert.rejects(()=>f.build(['--private-port=3318']).run(),/占用/);
  assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.env.MYSQL_DATA_DIR),false);
});
test('preexisting data directory is never initialized or assigned a password',async t=>{
  const f=fixture(t);fs.mkdirSync(f.env.MYSQL_DATA_DIR);fs.writeFileSync(path.join(f.env.MYSQL_DATA_DIR,'keep'),'original');
  await assert.rejects(()=>f.build(['--private-port=3318']).run(),/已存在/);assert.equal(f.calls.length,0);
});
test('foreign UUID aborts before ALTER USER and stops only owned process',async t=>{
  const f=fixture(t,{wrongUuid:true});await assert.rejects(()=>f.build(['--private-port=3318']).run(),/归属|UUID/);
  assert.equal(f.calls.some(c=>c[0]==='query'&&c[1].startsWith('ALTER')),false);assert.equal(f.child.killed,true);
});
test('fresh installation verifies UUID, sets password in memory, and persists exact instance',async t=>{
  const f=fixture(t);await f.build(['--private-port=3318']).run();
  const config=require('../后端源码/node_modules/dotenv').parse(fs.readFileSync(path.join(f.backend,'.env')));
  assert.equal(config.DB_PORT,'3318');assert.equal(config.DB_HOST,'127.0.0.1');assert.equal(config.MYSQL_DATA_DIR.replaceAll('\\','/'),f.env.MYSQL_DATA_DIR.replaceAll('\\','/'));
  assert.ok(config.DB_PASSWORD.length>=32);assert.equal(config.DEEPSEEK_API_KEY,'');
  const alter=f.calls.find(c=>c[0]==='query'&&c[1].startsWith('ALTER'));
  assert.equal(alter[1],"ALTER USER 'root'@'localhost' IDENTIFIED BY ?");assert.equal(alter[2][0],config.DB_PASSWORD);
  assert.ok(f.calls.findIndex(c=>c[0]==='query'&&c[1].startsWith('SELECT'))<f.calls.indexOf(alter));
  for(const c of f.calls.filter(c=>['sync','spawn'].includes(c[0])))assert.equal(JSON.stringify(c.slice(1,3)).includes(config.DB_PASSWORD),false);
  assert.equal(f.output.join('\n').includes(config.DB_PASSWORD),false);
  const init=f.calls.find(c=>c[0]==='sync'&&c[2].includes('--initialize-insecure'));assert.equal(init[2][0],'--no-defaults');assert.ok(init[2].includes('--datadir=.'));
  const launch=f.calls.find(c=>c[0]==='spawn');assert.equal(launch[3].cwd,f.env.MYSQL_DATA_DIR);assert.ok(launch[2].includes('--mysqlx=0'));assert.ok(launch[2].includes('--bind-address=127.0.0.1'));
  if(process.platform==='win32')assert.ok(launch[2].includes('--no-monitor'),'owned ChildProcess must be the actual server for failure cleanup');
});
test('existing instance preserves config, respects actual user/host/name, and never changes auth',async t=>{
  const f=fixture(t,{identityPort:3318});const original='DB_HOST=127.0.0.2\nDB_PORT=3318\nDB_USER=app\nDB_PASSWORD="has # spaces"\nDB_NAME=custom_db\n';fs.writeFileSync(path.join(f.backend,'.env'),original);f.setAuth('has # spaces');
  await f.build(['--use-existing']).run();
  const connection=f.calls.find(c=>c[0]==='connect')[1];assert.equal(connection.user,'app');assert.equal(connection.host,'127.0.0.2');assert.equal(connection.password,'has # spaces');
  assert.equal(f.calls.some(c=>c[0]==='query'&&c[1].startsWith('ALTER')),false);assert.equal(f.calls.some(c=>c[0]==='spawn'),false);
  assert.equal(fs.readFileSync(path.join(f.backend,'.env'),'utf8'),original);
  assert.equal(f.calls.some(c=>c[0]==='sync'&&c[2].includes('scripts/seed-demo.js')),false,'existing user data must never be rebuilt by installation');
  const script=f.calls.find(c=>c[0]==='sync'&&c[2].includes('scripts/init-db.js'));assert.equal(script[3].env.DB_NAME,'custom_db');
});

test('fresh install does not run destructive demo-data generator implicitly',async t=>{
  const f=fixture(t);await f.build(['--private-port=3318']).run();
  assert.equal(f.calls.some(c=>c[0]==='sync'&&c[2].includes('scripts/seed-demo.js')),false);
});
test('authentication failure never guesses another password or discloses it',async t=>{
  const f=fixture(t,{connectError:true});fs.writeFileSync(path.join(f.backend,'.env'),'DB_PASSWORD=secret-value\nDB_PORT=3318\n');
  await assert.rejects(()=>f.build(['--use-existing']).run(),e=>!e.message.includes('secret-value'));
  assert.equal(f.calls.filter(c=>c[0]==='connect').length,1);assert.equal(f.calls.some(c=>c[0]==='spawn'),false);
});
test('schema failure stops subsequent scripts and retains generated recovery config',async t=>{
  const f=fixture(t,{scriptFailure:'scripts/migrate.js'});await assert.rejects(()=>f.build(['--private-port=3318']).run(),/migrate/);
  assert.equal(f.calls.some(c=>c[0]==='sync'&&c[2].includes('scripts/seed-demo.js')),false);
  assert.equal(fs.existsSync(path.join(f.backend,'.env')),true);assert.equal(f.child.killed,true);
});

test('invalid environment PORT fails before installing dependencies',async t=>{
  const f=fixture(t);await assert.rejects(()=>f.build(['--private-port=3318'],{PORT:'70000'}).run(),/端口/);
  assert.equal(f.calls.length,0);
});
test('paths with apostrophes are preserved exactly in generated config',async t=>{
  const f=fixture(t);const dir=path.join(f.root,"owner's data");
  await f.build(['--private-port=3318'],{MYSQL_DATA_DIR:dir}).run();
  const config=require('../后端源码/node_modules/dotenv').parse(fs.readFileSync(path.join(f.backend,'.env')));
  assert.equal(config.MYSQL_DATA_DIR,dir.replaceAll('\\','/'));
});
test('port mismatch aborts auth even if UUID matches',async t=>{
  const f=fixture(t,{identityPort:3319});await assert.rejects(()=>f.build(['--private-port=3318']).run(),/归属/);
  assert.equal(f.calls.some(c=>c[0]==='query'&&c[1].startsWith('ALTER')),false);
});
test('system database override is used consistently by verification and schema scripts',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.backend,'.env'),'DB_PORT=3307\nDB_USER=old\nDB_PASSWORD=old-secret\n');f.setAuth('override-secret');
  await f.build(['--use-existing'],{DB_PORT:'3318',DB_USER:'override',DB_PASSWORD:'override-secret'}).run();
  const connection=f.calls.find(c=>c[0]==='connect')[1];assert.equal(connection.port,3318);assert.equal(connection.user,'override');
  const script=f.calls.find(c=>c[0]==='sync');assert.equal(script[3].env.DB_PORT,'3318');assert.equal(script[3].env.DB_PASSWORD,'override-secret');
});
