// Migration landing (WT-10M, docs/plans/2026-10-30-per-task-worktrees.md §7.3): --land-branch /
// -LandBranch lands a branch on main as ONE gated merge commit C, whose tree is M = merge-tree(B, tip)
// and whose parents are exactly [B, tip], with no lease and no daemon RPC of any kind. One case list
// for both wrappers:
//   node postflight-migration.cjs <sh|ps1> <wrapper> <fake-proxy> <parent-tmp> <engine>
// The fake-proxy argument is unused: MOE_PROXY_PATH is a tripwire this suite writes, which logs every
// launch and request and answers each request with an error, so any RPC leaves its log behind.
// `<this file> gate` is every case's qualityGate. MOE_MIGRATION_ONLY=<case,...> runs a subset,
// MOE_KEEP_MIGRATION_FIXTURE=1 keeps the fixture.
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const BR='moe/work-mig',SUBJECT=`chore(migration): land ${BR} on main`,e=process.env;
const read=f=>fs.readFileSync(f,'utf8'),write=(f,b)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);};
function run(dir,args,input){
  const r=cp.spawnSync('git',['-C',dir,...args],{encoding:'utf8',input,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  if(r.status!==0)throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr||r.error).trim()}`);
  return r.stdout.trim();
}
const git=(dir,...a)=>run(dir,a),has=(dir,a,b)=>cp.spawnSync('git',['-C',dir,'merge-base','--is-ancestor',a,b]).status===0;
// A peer commit on REPO's main, made with plumbing: main's tree with FILES added or replaced.
function peer(repo,files){
  const old=git(repo,'rev-parse','refs/heads/main');
  const keep=git(repo,'ls-tree','refs/heads/main').split('\n').filter(l=>!(l.split('\t')[1] in files));
  const add=Object.entries(files).map(([f,b])=>`100644 blob ${run(repo,['hash-object','-w','--stdin'],b)}\t${f}`);
  const c=git(repo,'-c','user.name=Moe Peer','-c','user.email=peer@test.local','commit-tree',run(repo,['mktree'],[...keep,...add].join('\n')+'\n'),'-p',old,'-m','peer');
  git(repo,'update-ref','refs/heads/main',c,old);
  return c;
}
if(process.argv[2]==='gate'){
  // Logs `<HEAD^{tree}> <whether ./.moe exists>`. MIG_GATE=fail exits 1; peer (peer-once: its first run
  // only) lands a peer commit on MIG_ORIGIN's main; offline renames origin away (the push and the reconcile
  // fail); checkout checks main out in the project.
  fs.appendFileSync(e.MIG_LOG,`${git('.','rev-parse','HEAD^{tree}')} ${fs.existsSync('.moe')}\n`);
  const n=read(e.MIG_LOG).split('\n').filter(Boolean).length;
  if(e.MIG_GATE==='peer'||(e.MIG_GATE==='peer-once'&&n===1))peer(e.MIG_ORIGIN,{[`peer-${n}.txt`]:`peer ${n}\n`});
  if(e.MIG_GATE==='offline')fs.renameSync(e.MIG_ORIGIN,e.MIG_ORIGIN+'.away');
  if(e.MIG_GATE==='checkout')git(e.MIG_DIR,'checkout','-q','main');
  process.exit(e.MIG_GATE==='fail'?1:0);
}

const [platform,wrapper,,parent,engine]=process.argv.slice(2),win=platform==='ps1',winHost=process.platform==='win32';
if(!['sh','ps1'].includes(platform)||!engine){
  console.error('usage: node postflight-migration.cjs <sh|ps1> <wrapper> <fake-proxy> <parent-tmp> <engine>');process.exit(2);
}
const LIMIT=Number(e.MOE_POSTFLIGHT_TIMEOUT_SEC||180)*1000,root=fs.mkdtempSync(path.join(parent,'moe mig '));
const home=path.join(root,'home'),wtmp=path.join(root,'tmp'),TRIP=path.join(root,'tripwire.cjs'),TRIP_LOG=TRIP+'.log';
const fwd=s=>win?s:s.replace(/\\/g,'/'),GATE=`"${fwd(process.execPath)}" "${fwd(__filename)}" gate`;
// Hermetic: the seat's own MOE_*/CLAUDE* session vars and a hook's GIT_* never reach the wrapper.
const inherited=Object.fromEntries(Object.entries(e).filter(([k])=>!/^(MIG_|MOE_|CLAUDE|BASH_ENV$|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY)$)/i.test(k)));
const L=JSON.stringify(TRIP_LOG);
write(TRIP,`const fs=require('fs');fs.appendFileSync(${L},'launch '+JSON.stringify(process.argv.slice(2))+'\\n');let buf='';
process.stdin.on('data',d=>{buf+=d;for(let i;(i=buf.indexOf('\\n'))>=0;buf=buf.slice(i+1)){const l=buf.slice(0,i).trim();if(!l)continue;
  fs.appendFileSync(${L},l+'\\n');let id=null;try{id=JSON.parse(l).id;}catch{}
  if(id!=null)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:'migration tripwire'}})+'\\n');}});
`);
fs.mkdirSync(home);fs.mkdirSync(wtmp);
const gates=p=>fs.existsSync(p.log)?read(p.log).split(/\r?\n/).filter(Boolean):[];
const settings=s=>JSON.stringify({id:'proj-mig',name:'Migration',settings:{qualityGateScope:'epicFinal',...s}});

// main holds a.txt, b.txt and .moe/project.json; BR (checked out, so main is not) adds 2 commits; then a
// peer commit lands on origin's main (on local main without an origin), so B is never the branch base.
function repo(name,{remote=true,conflict=false}={}){
  const dir=path.join(root,name),origin=path.join(root,name+'-origin.git');
  write(path.join(dir,'.moe','project.json'),settings({qualityGate:GATE}));
  write(path.join(dir,'.moe','daemon.json'),JSON.stringify({port:9876,projectPath:dir}));
  write(path.join(dir,'a.txt'),'a\n');write(path.join(dir,'b.txt'),'b\n');
  git(root,'init','-q',dir);git(dir,'symbolic-ref','HEAD','refs/heads/main');
  for(const [k,v] of [['core.autocrlf','false'],['user.name','Moe Test'],['user.email','moe@test.local']])git(dir,'config',k,v);
  git(dir,'add','a.txt','b.txt','.moe/project.json');git(dir,'commit','-qm','base');git(dir,'checkout','-qb',BR);
  write(path.join(dir,conflict?'a.txt':'b.txt'),'work\n');git(dir,'commit','-qam','work 1');
  write(path.join(dir,'c.txt'),'c\n');git(dir,'add','c.txt');git(dir,'commit','-qm','work 2');
  if(remote){git(root,'init','-q','--bare',origin);git(dir,'remote','add','origin',origin);git(dir,'push','-q','origin','main');}
  const base=git(dir,'rev-parse','main');
  peer(remote?origin:dir,conflict?{'a.txt':'peer\n'}:{'p.txt':'p\n'});
  return {name,dir,origin,remote,base,tip:git(dir,'rev-parse',BR),log:path.join(root,name+'-gate.log')};
}

let runs=0;
function launch(p,branch,knobs){
  const args=win?['-NoProfile','-File',wrapper,'-Project',p.dir,'-WorkerId','worker-mig','-NoStartDaemon','-LandBranch',branch]
    :[wrapper,'--project',p.dir,'--worker-id','worker-mig','--no-start-daemon','--land-branch',branch];
  const env={...inherited,MOE_PROXY_PATH:TRIP,MOE_NODE_COMMAND:process.execPath,MOE_DISABLE_HEARTBEAT:'1',MOE_LAND_NET_BACKOFF_SEC:'0',
    MOE_POSTFLIGHT_TEST_ALLOW_WORKTREE_WRAPPER:'1',HOME:home,USERPROFILE:home,TMPDIR:wtmp,TMP:wtmp,TEMP:wtmp,MIG_LOG:p.log,MIG_ORIGIN:p.origin,MIG_DIR:p.dir,...knobs};
  return new Promise(res=>{
    const child=cp.spawn(engine,args,{env,stdio:['ignore','pipe','pipe'],detached:!winHost,windowsHide:true});let log='';
    child.stdout.on('data',d=>{log+=d;});child.stderr.on('data',d=>{log+=d;});
    const timer=setTimeout(()=>{if(winHost)cp.spawnSync('taskkill',['/T','/F','/PID',String(child.pid)],{stdio:'ignore'});
      else try{process.kill(-child.pid,'SIGKILL');}catch{}},LIMIT);
    child.on('close',(code,signal)=>{clearTimeout(timer);res({code,signal,log});});
  });
}
// One wrapper run and what every run must leave as it found it: no RPC reached the tripwire, the
// source branch did not move, and no rescue ref or receipt journal exists.
async function mig(p,branch,want,knobs={}){
  fs.rmSync(TRIP_LOG,{force:true});
  const r=await launch(p,branch,knobs),tail=r.log.split(/\r?\n/).slice(-30).join('\n'),receipts=path.join(p.dir,'.git','moe','receipt');
  write(path.join(root,`run-${++runs}-${p.name}.log`),r.log);
  assert.ok(r.code===want&&r.signal===null,`[${p.name}] ${branch}: exit ${r.code} (${r.signal}), want ${want}\n${tail}`);
  assert.ok(!fs.existsSync(TRIP_LOG),`[${p.name}] an RPC or CLI reached the tripwire:\n${fs.existsSync(TRIP_LOG)?read(TRIP_LOG):''}\n${tail}`);
  assert.equal(git(p.dir,'rev-parse','refs/heads/'+BR),p.tip,`[${p.name}] the source branch moved\n${tail}`);
  assert.equal(git(p.dir,'for-each-ref','refs/moe/rescue'),'',`[${p.name}] a rescue ref\n${tail}`);
  assert.deepEqual(fs.existsSync(receipts)?fs.readdirSync(receipts):[],[],`[${p.name}] a receipt journal\n${tail}`);
  return {log:r.log,tail};
}
// A failure publishes nothing: origin's main holds no migration commit, and no main ref holds the tip.
function unpublished(p,r){
  const refs=[[p.dir,'refs/heads/main'],[p.dir,'refs/remotes/origin/main'],[p.origin,'refs/heads/main']].slice(0,p.remote?3:1);
  for(const [d,ref] of refs)assert.ok(!has(d,p.tip,ref),`[${p.name}] ${ref} of ${d} holds the tip\n${r.tail}`);
  if(p.remote)assert.ok(!git(p.origin,'log','--format=%s','refs/heads/main').split('\n').includes(SUBJECT),`[${p.name}] origin holds a migration commit\n${r.tail}`);
}
// A refusal before any fetch: its code, no gate run, refs/remotes/origin/main still at the base
// although origin's main moved, and nothing published.
function refused(p,r,code){
  assert.ok(r.log.includes(code)&&!r.log.includes('MOE_MIGRATION_LANDED'),`[${p.name}] want ${code}\n${r.tail}`);
  assert.deepEqual([gates(p).length,git(p.dir,'rev-parse','refs/remotes/origin/main')],[0,p.base],`[${p.name}] a gate run or a fetch\n${r.tail}`);
  unpublished(p,r);
}
// A landing: C is main (origin's, and the local mirror), its tree is the suite's own merge-tree of B and
// the tip, its parents are exactly [B, tip], the subject is fixed, and the last gate ran on C's tree without .moe.
function landed(p,b,r,gateRuns){
  const c=git(p.remote?p.origin:p.dir,'rev-parse','refs/heads/main'),tree=git(p.dir,'rev-parse',c+'^{tree}'),g=gates(p);
  assert.ok(r.log.includes(`MOE_MIGRATION_LANDED branch=${BR} target=main base=${b} commit=${c}`),`[${p.name}] no MOE_MIGRATION_LANDED for ${c} on ${b}\n${r.tail}`);
  assert.deepEqual([git(p.dir,'rev-parse','refs/heads/main'),tree,git(p.dir,'rev-list','--parents','-n1',c),git(p.dir,'log','-1','--format=%s',c)],
    [c,git(p.dir,'merge-tree','--write-tree',b,p.tip).split('\n')[0],`${c} ${b} ${p.tip}`,SUBJECT],`[${p.name}] main, tree, parents, subject\n${r.tail}`);
  assert.deepEqual([g.length,g.at(-1)],[gateRuns,`${tree} false`],`[${p.name}] gate runs ${JSON.stringify(g)}\n${r.tail}`);
  return c;
}

const cases={
  async clean(){
    const p=repo('clean'),b=git(p.origin,'rev-parse','main'),c=landed(p,b,await mig(p,BR,0),1),r=await mig(p,BR,0);
    assert.ok(r.log.includes('MOE_COMMIT_NOTHING_TO_COMMIT')&&!r.log.includes('MOE_MIGRATION_LANDED'),`[clean] the rerun\n${r.tail}`);
    assert.deepEqual([git(p.origin,'rev-parse','main'),gates(p).length],[c,1],`[clean] the rerun published or gated\n${r.tail}`);
  },
  // No origin: B is the local main and publication an update-ref CAS, which round 1 loses to a peer
  // commit its gate lands; round 2 lands on that peer commit.
  async local(){
    const p=repo('local',{remote:false}),b=git(p.dir,'rev-parse','main'),r=await mig(p,BR,0,{MIG_GATE:'peer-once',MIG_ORIGIN:p.dir});
    const b2=git(p.dir,'rev-parse','main^1');assert.equal(git(p.dir,'rev-parse',b2+'^'),b,`[local] B of round 2\n${r.tail}`);landed(p,b2,r,2);
  },
  async 'no-gate'(){
    const p=repo('no-gate');
    for(const [s,knobs] of [[{},{}],[{qualityGate:GATE},{MOE_DISABLE_QUALITY_GATE:'1'}]]){
      write(path.join(p.dir,'.moe','project.json'),settings(s));refused(p,await mig(p,BR,1,knobs),'MOE_MIGRATION_NO_GATE');
    }
  },
  async 'bad-args'(){
    const p=repo('bad-args');
    for(const b of ['moe/nope','main','bad..name'])refused(p,await mig(p,b,2),'MOE_MIGRATION_BAD_ARGS');
    git(p.dir,'checkout','-q','main');refused(p,await mig(p,BR,1),'MOE_LAND_TARGET_CHECKED_OUT');
  },
  async conflict(){
    const p=repo('conflict',{conflict:true}),r=await mig(p,BR,1);
    assert.match(r.log,/MOE_COMMIT_FAILED_CONFLICT[^\n]*a\.txt/,`[conflict]\n${r.tail}`);assert.equal(gates(p).length,0,r.tail);unpublished(p,r);
  },
  async 'gate-fail'(){
    const p=repo('gate-fail'),r=await mig(p,BR,1,{MIG_GATE:'fail'});
    assert.ok(r.log.includes('MOE_COMMIT_FAILED_GATE'),`[gate-fail]\n${r.tail}`);assert.equal(gates(p).length,1,r.tail);unpublished(p,r);
  },
  // sh only (Windows has no SIGTERM to send): the gate signals the wrapper, $PPID. An interrupted migration
  // exits 130, never the loop's "Agent stopped." exit 0, and the EXIT trap removes the gate worktree.
  ...(win?{}:{async signal(){
    const p=repo('signal');write(path.join(p.dir,'.moe','project.json'),settings({qualityGate:`${GATE}; kill -TERM $PPID; sleep 30`}));
    const r=await mig(p,BR,130),wts=git(p.dir,'worktree','list','--porcelain').split('\n').filter(l=>l.startsWith('worktree ')).length;
    assert.ok(!/Agent stopped|MOE_MIGRATION_LANDED/.test(r.log),`[signal]\n${r.tail}`);
    assert.deepEqual([gates(p).length,wts],[1,1],`[signal] gate runs, worktrees\n${r.tail}`);unpublished(p,r);
  }}),
  // main is checked out while the gate runs: the re-check before publication refuses.
  async 'checked-out'(){
    const p=repo('checked-out'),r=await mig(p,BR,1,{MIG_GATE:'checkout'});
    assert.ok(r.log.includes('MOE_LAND_TARGET_CHECKED_OUT'),`[checked-out]\n${r.tail}`);assert.equal(gates(p).length,1,r.tail);unpublished(p,r);
  },
  // Every gate run lands a peer commit, so both rounds' non-forced pushes are rejected.
  async contention(){
    const p=repo('contention'),b=git(p.origin,'rev-parse','main'),r=await mig(p,BR,1,{MIG_GATE:'peer'});
    assert.ok(r.log.includes('MOE_COMMIT_FAILED_REF_CONTENTION'),`[contention]\n${r.tail}`);assert.equal(gates(p).length,2,r.tail);
    assert.deepEqual([git(p.origin,'rev-parse','main~2'),git(p.origin,'log','-2','--format=%s','main')],[b,'peer\npeer'],`[contention] origin's main\n${r.tail}`);
    unpublished(p,r);
  },
  // Round 1's push is rejected; round 2 merges and gates again on the first peer commit, and lands.
  async 'peer-once'(){
    const p=repo('peer-once'),b=git(p.origin,'rev-parse','main'),r=await mig(p,BR,0,{MIG_GATE:'peer-once'}),b2=git(p.origin,'rev-parse','main^1');
    assert.deepEqual([git(p.origin,'rev-parse',b2+'^'),git(p.origin,'log','-1','--format=%s',b2)],[b,'peer'],`[peer-once] B of round 2\n${r.tail}`);
    landed(p,b2,r,2);assert.notEqual(gates(p)[0],gates(p)[1],`[peer-once] round 2 gated the same tree\n${r.tail}`);
  },
  // origin's pre-receive hook refuses every push: [remote rejected] is final after one round.
  async 'remote-rejected'(){
    const p=repo('remote-rejected');write(path.join(p.origin,'hooks','pre-receive'),'#!/bin/sh\nexit 1\n');fs.chmodSync(path.join(p.origin,'hooks','pre-receive'),0o755);
    const r=await mig(p,BR,1);assert.ok(r.log.includes('MOE_PUSH_FAILED'),`[remote-rejected]\n${r.tail}`);assert.equal(gates(p).length,1,r.tail);unpublished(p,r);
  },
  // origin vanishes during the gate: the push and the reconcile fetch both fail, so nothing local moves and
  // nothing claims success; with origin back, a rerun lands.
  async unknown(){
    const p=repo('unknown'),b=git(p.origin,'rev-parse','main'),r=await mig(p,BR,1,{MIG_GATE:'offline'});
    assert.ok(r.log.includes('MOE_PUSH_OUTCOME_UNKNOWN')&&!r.log.includes('MOE_MIGRATION_LANDED'),`[unknown]\n${r.tail}`);
    assert.deepEqual([git(p.dir,'rev-parse','main'),git(p.dir,'rev-parse','refs/remotes/origin/main')],[b,b],`[unknown] a local ref moved\n${r.tail}`);
    fs.renameSync(p.origin+'.away',p.origin);unpublished(p,r);landed(p,b,await mig(p,BR,0),2);
  },
};

(async()=>{
  const names=Object.keys(cases).filter(n=>!e.MOE_MIGRATION_ONLY||e.MOE_MIGRATION_ONLY.split(',').includes(n));let failed=0;
  for(const n of names){
    try{await cases[n]();console.log(`[migration] ${n} ok`);}
    catch(err){failed++;console.log(`[migration] ${n} FAILED: ${String(err.message).split('\n')[0]}`);console.error(err.message);}
  }
  assert.equal(failed,0,`${failed} of ${names.length} migration cases failed`);
  console.log(`PASS migration landing scenarios: ${names.length}`);
})().catch(err=>{console.error('MIGRATION FIXTURE '+root);console.error(err.message);process.exitCode=1;})
  .finally(()=>{if(!e.MOE_KEEP_MIGRATION_FIXTURE)fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
