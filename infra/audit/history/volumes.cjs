// Linux/WSL host operator tool. Read-only backup and restore into NEW volumes.
// No volume removal or in-place overwrite command exists in this tool.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createReadStream}=require('node:fs');
const {execFileSync}=require('node:child_process');
const alpine='alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8';
const volumeName=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file) {const hash=createHash('sha256');for await(const bytes of createReadStream(file)) hash.update(bytes);return hash.digest('hex');}
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});
async function verify(dir,pin) {
  if(!/^[0-9a-f]{64}$/.test(pin||'')) throw Error('Independently retained backup manifest hash required');
  const raw=await fs.readFile(path.join(dir,'volumes.json'));if(sha(raw)!==pin) throw Error('Backup manifest mismatch');
  const manifest=JSON.parse(raw);
  if(manifest.version!=='OPENDX-VOLUMES-1' || !Array.isArray(manifest.volumes)) throw Error('Invalid backup manifest');
  for(const item of manifest.volumes) {
    if(!volumeName.test(item.name) || await fileHash(path.join(dir,item.name+'.tar'))!==item.sha256) throw Error('Volume archive mismatch');
  }
  return manifest;
}
async function main(args=process.argv.slice(2)) {
  const [mode,directory,pinOrNames,prefix]=args,dir=path.resolve(directory||'.');
  if(mode==='backup') {
    const names=(pinOrNames||'').split(',');
    if(!names.length || !names.every(name=>volumeName.test(name)) || args[3]!=='--writers-stopped') throw Error('Explicit existing volume names and --writers-stopped acknowledgement required');
    // Verify all named volumes BEFORE Docker could auto-create a typo. Operators
    // also stop external writers and retain a matching pg_dump and object store.
    for(const name of names) docker(['volume','inspect',name]);
    await fs.mkdir(dir,{recursive:false,mode:0o700});
    const volumes=[];
    for(const name of names) {
      docker(['run','--rm','--network','none','--read-only','--mount','type=volume,source='+name+',target=/source,readonly',
        '--mount','type=bind,source='+dir+',target=/backup',alpine,'tar','-cf','/backup/'+name+'.tar','-C','/source','.']);
      volumes.push({name,sha256:await fileHash(path.join(dir,name+'.tar'))});
    }
    const raw=JSON.stringify({version:'OPENDX-VOLUMES-1',volumes})+'\n';
    await fs.writeFile(path.join(dir,'volumes.json'),raw,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({volumes:names.length,backupManifestSha256:sha(raw)}));return;
  }
  if(!['verify','restore'].includes(mode)) throw Error('Use backup, verify or restore');
  const manifest=await verify(dir,pinOrNames);
  if(mode==='restore') {
    if(!volumeName.test(prefix||'')) throw Error('Explicit isolated restore prefix required');
    const targets=manifest.volumes.map(item=>prefix+'_'+item.name);
    if(targets.some(name=>!volumeName.test(name) || manifest.volumes.some(item=>item.name===name))) throw Error('Invalid restore target');
    for(const target of targets) {
      let exists=false;try{docker(['volume','inspect',target]);exists=true;}catch(error){
        if(!String(error.stderr).includes('no such volume')) throw error;
      }
      if(exists) throw Error('Restore refuses an existing target volume');
    }
    for(const [index,item] of manifest.volumes.entries()) {
      docker(['volume','create',targets[index]]);
      docker(['run','--rm','--network','none','--read-only','--mount','type=volume,source='+targets[index]+',target=/restore',
        '--mount','type=bind,source='+dir+',target=/backup,readonly',alpine,'tar','-xf','/backup/'+item.name+'.tar','-C','/restore']);
    }
    console.log(JSON.stringify({restoredVolumes:targets,originalVolumesRetained:true}));
  } else console.log(JSON.stringify({verified:true,volumes:manifest.volumes.length}));
}
if(require.main===module) main().catch(()=>{console.error('HISTORY_VOLUME_OPERATION_FAILED: original volumes were retained; do not accept partial recovery.');process.exitCode=1;});
module.exports={main,verify};
