// Disposable Docker recovery drill only. Production recovery never deletes sources.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {main,verify}=require('./volumes.cjs');
const {sha}=require('./migrate.cjs');
const alpine='alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
async function run() {
  const suffix=randomUUID(),source='opendx22-synthetic-'+suffix,prefix='opendx22-restore-'+suffix,target=prefix+'_'+source;
  const root=await fs.mkdtemp(join(tmpdir(),'opendx22-volumes-')),backup=join(root,'backup');
  try {
    docker(['volume','create',source]);
    docker(['run','--rm','--network','none','--mount','type=volume,source='+source+',target=/data',alpine,'sh','-c','printf synthetic-original-trust-state > /data/anchor']);
    await main(['backup',backup,source,'--writers-stopped']);
    const raw=await fs.readFile(join(backup,'volumes.json')),pin=sha(raw);
    await main(['verify',backup,pin]);await assert.rejects(verify(backup,'f'.repeat(64)));
    await main(['restore',backup,pin,prefix]);
    const read=name=>docker(['run','--rm','--network','none','--read-only','--mount','type=volume,source='+name+',target=/data,readonly',alpine,'cat','/data/anchor']);
    assert.equal(read(source),'synthetic-original-trust-state');assert.equal(read(target),read(source));
    await assert.rejects(main(['restore',backup,pin,prefix]));
    await fs.appendFile(join(backup,source+'.tar'),'corrupted');await assert.rejects(verify(backup,pin));
    console.log('PASS disposable volume read-only backup, independent hash, exact isolated restore, source preservation, existing-target refusal and corrupted-tar rejection');
  } finally {
    // Only the two explicit random synthetic volumes created above are removed.
    for(const name of [source,target]) {try{docker(['volume','rm',name]);}catch{/* report remains a failed drill if earlier assertions fail */}}
    if(root.startsWith(join(tmpdir(),'opendx22-volumes-'))) await fs.rm(root,{recursive:true,force:true});
  }
}
run().catch(()=>{console.error('SYNTHETIC_VOLUME_DRILL_FAILED');process.exitCode=1;});
