/* Video Downloader API: wraps yt-dlp. Endpoints: GET /info?url=  and  GET /download?url=&format= */
const express=require('express'),{spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const app=express(),PORT=process.env.PORT||3000,ORIGIN=process.env.ALLOWED_ORIGIN||'*',MAX_SEC=+process.env.MAX_SECONDS||3600,MAX_JOBS=+process.env.MAX_JOBS||2;
const HOSTS=/^(?:[\w-]+\.)*(youtube\.com|youtu\.be|facebook\.com|fb\.watch|instagram\.com|tiktok\.com|twitter\.com|x\.com)$/i;
const base=['--no-playlist','--no-warnings'];
app.set('trust proxy',1);
app.use((req,res,next)=>{res.set('Access-Control-Allow-Origin',ORIGIN);res.set('Access-Control-Expose-Headers','Content-Disposition');next()});
/* simple rate limit: 20 requests per minute per IP */
const hits=new Map();
app.use((req,res,next)=>{const now=Date.now(),a=(hits.get(req.ip)||[]).filter(t=>now-t<60000);a.push(now);hits.set(req.ip,a);
  if(a.length>20)return res.status(429).json({error:'Too many requests. Please wait a minute.'});next()});
setInterval(()=>hits.clear(),600000).unref();
const okUrl=u=>{try{const x=new URL(u);return /^https?:$/.test(x.protocol)&&HOSTS.test(x.hostname)}catch{return false}};
const run=(args,ms=120000)=>new Promise((ok,no)=>{const p=spawn('yt-dlp',args);let o='',e='';const t=setTimeout(()=>p.kill('SIGKILL'),ms);
  p.stdout.on('data',d=>o+=d);p.stderr.on('data',d=>e+=d);p.on('error',no);p.on('close',c=>{clearTimeout(t);c===0?ok(o):no(new Error(e.slice(-300)))})});
const mb=b=>+(b/1048576).toFixed(1);
app.get('/',(q,r)=>r.send('Video Downloader API is running.'));
app.get('/info',async(req,res)=>{
  const u=req.query.url;if(!okUrl(u))return res.status(400).json({error:'Unsupported link'});
  try{
    const j=JSON.parse(await run([...base,'-J','--',u])),D=j.duration||0,fm=j.formats||[];
    if(D>MAX_SEC)return res.status(413).json({error:'This video is too long.'});
    const vids=fm.filter(f=>f.vcodec&&f.vcodec!=='none'&&f.height),H=Math.max(0,...vids.map(f=>f.height));
    const aud=Math.max(0,...fm.filter(f=>f.vcodec==='none').map(f=>f.filesize||f.filesize_approx||0));
    const size=f=>f.filesize||f.filesize_approx||(f.tbr?f.tbr*125*D:0);
    const out=[];
    [[1080,'Full HD'],[720,'HD'],[480,'SD'],[360,'Low']].forEach(([h,tag])=>{
      if(h>H&&!(h===360&&!out.length))return;
      const c=vids.filter(f=>f.height<=h).sort((a,b)=>b.height-a.height||(b.tbr||0)-(a.tbr||0))[0];if(!c)return;
      out.push({id:h+'p',label:h+'p',tag,audio:false,size:mb(size(c)+aud)||mb(D*h*600)})});
    out.push({id:'MP3 192 kbps',label:'MP3 192 kbps',tag:'Audio',audio:true,size:mb(D*24000)});
    out.push({id:'M4A',label:'M4A',tag:'Audio',audio:true,size:mb(aud||D*16000)});
    res.json({title:j.title,duration:D,thumbnail:j.thumbnail||'',formats:out});
  }catch(e){res.status(422).json({error:'Could not read this video. It may be private or unavailable.'})}});
let jobs=0;
app.get('/download',async(req,res)=>{
  const u=req.query.url,f=String(req.query.format||'');if(!okUrl(u))return res.status(400).send('Unsupported link');
  const m=f.match(/^(\d{3,4})p$/);let args;
  if(m){const h=+m[1];args=['-f',`bv*[height<=${h}]+ba/b[height<=${h}]/b`,'--merge-output-format','mp4']}
  else if(f.startsWith('MP3'))args=['-x','--audio-format','mp3','--audio-quality','192K'];
  else if(f==='M4A')args=['-x','--audio-format','m4a'];
  else return res.status(400).send('Bad format');
  if(jobs>=MAX_JOBS)return res.status(503).send('Server is busy. Please try again in a moment.');
  jobs++;const id='vd-'+crypto.randomBytes(8).toString('hex'),tmp=os.tmpdir();
  const clean=()=>fs.readdirSync(tmp).filter(n=>n.startsWith(id)).forEach(n=>fs.rmSync(path.join(tmp,n),{force:true}));
  try{
    await run([...base,'--match-filter',`duration<=${MAX_SEC}`,...args,'-o',path.join(tmp,id+'.%(ext)s'),'--',u],600000);
    const file=fs.readdirSync(tmp).find(n=>n.startsWith(id)&&!/\.(part|ytdl)$/.test(n));
    if(!file)throw new Error('no file');
    res.download(path.join(tmp,file),'video-downloader'+path.extname(file),()=>{clean();jobs--});
  }catch(e){clean();jobs--;if(!res.headersSent)res.status(422).send('Download failed. The video may be private, too long or unavailable.')}});
app.listen(PORT,()=>console.log('API on '+PORT));
