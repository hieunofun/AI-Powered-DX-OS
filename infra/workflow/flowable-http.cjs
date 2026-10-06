// Shared authenticated operator/CI transport. Credentials and bodies are never logged.
const base=(process.env.FLOWABLE_URL||'http://localhost:8088/flowable-rest/service').replace(/\/$/,'');
const username=process.env.FLOWABLE_USERNAME||'workflow-service';
const password=process.env.FLOWABLE_PASSWORD||'flowable_dev_only_password';
async function engine(path,options={}) {
  const response=await fetch(base+path,{...options,signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Basic '+Buffer.from(username+':'+password).toString('base64'),...options.headers}});
  if(!response.ok) throw new Error('Flowable HTTP '+response.status+' at '+path.split('?')[0]);
  const text=await response.text();
  if(options.raw) return text;
  return text?JSON.parse(text):null;
}
module.exports={engine};

