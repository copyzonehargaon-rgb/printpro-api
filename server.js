const express=require('express');
const cors=require('cors');
const multer=require('multer');
const fs=require('fs');
const path=require('path');
const app=express();
const PORT=process.env.PORT||10000;
const DATA=path.join(__dirname,'data'); const UP=path.join(__dirname,'uploads');
fs.mkdirSync(DATA,{recursive:true}); fs.mkdirSync(UP,{recursive:true});
const shopsFile=path.join(DATA,'shops.json'); const jobsFile=path.join(DATA,'jobs.json');
function read(f,def){try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){return def}}
function write(f,d){fs.writeFileSync(f,JSON.stringify(d,null,2))}
function norm(s){return String(s||'').trim().toUpperCase().replace(/[^A-Z0-9_]/g,'_')}
function shopIdFromSlug(slug){return 'SHOP_'+norm(slug).replace(/^SHOP_/,'')}
function defaultShop(id){return {id, key:'AGENT'+Math.floor(100000+Math.random()*900000), name:id.replace(/^SHOP_/,'').replaceAll('_',' '), created_at:new Date().toISOString(), agent_last_seen:null, agent_ready:false, printer_name:'', message:'Not connected'}}
function getShop(id,key){id=norm(id); let shops=read(shopsFile,{}); if(!shops[id]){shops[id]=defaultShop(id); if(key) shops[id].key=String(key); write(shopsFile,shops)} return shops[id]}
function saveShop(shop){let shops=read(shopsFile,{}); shops[shop.id]=shop; write(shopsFile,shops)}
function isOnline(shop){if(!shop.agent_last_seen) return false; return (Date.now()-new Date(shop.agent_last_seen).getTime())<35000}
app.use(cors({origin:'*'})); app.use(express.json({limit:'50mb'})); app.use(express.urlencoded({extended:true,limit:'50mb'})); app.use('/uploads',express.static(UP));
const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,UP), filename:(req,file,cb)=>{let safe=file.originalname.replace(/[^a-zA-Z0-9._ -]/g,'_'); cb(null,'JOB'+Date.now()+'_'+safe)}}); const upload=multer({storage});
app.get('/',(req,res)=>res.json({success:true,name:'PrintPro Render API',version:4,time:new Date().toISOString()}));
app.get('/api/health',(req,res)=>res.json({success:true,ok:true,time:new Date().toISOString()}));
app.all('/api/shop/info',(req,res)=>{let id=req.query.shop_id||req.body.shop_id||shopIdFromSlug(req.query.shop||req.body.shop||'COPY_ZONE'); let shop=getShop(id,req.query.agent_key||req.body.agent_key); res.json({success:true,shop:{...shop, online:isOnline(shop), ready:isOnline(shop)&&!!shop.agent_ready}})});
app.all('/api/agent/status',(req,res)=>{let id=req.query.shop_id||req.body.shop_id; let key=req.query.agent_key||req.body.agent_key; if(!id) return res.status(400).json({success:false,error:'shop_id required'}); let shop=getShop(id,key); if(key && shop.key!==key){shop.key=String(key)} shop.agent_last_seen=new Date().toISOString(); shop.agent_ready=String(req.query.ready??req.body.ready??'1')!=='0'; shop.printer_name=req.query.printer_name||req.body.printer_name||req.query.default_printer||req.body.default_printer||shop.printer_name||''; shop.queue=Number(req.query.queue||req.body.queue||0); shop.message=req.query.message||req.body.message||'Agent online'; saveShop(shop); res.json({success:true,message:'status saved',shop:{id:shop.id,online:true,ready:shop.agent_ready,agent_last_seen:shop.agent_last_seen,printer_name:shop.printer_name,message:shop.message,queue:shop.queue||0}})});
app.get('/api/status',(req,res)=>{let id=req.query.shop_id||shopIdFromSlug(req.query.shop||'COPY_ZONE'); let shop=getShop(id,req.query.agent_key); let online=isOnline(shop); res.json({success:true,shop:{id:shop.id,key:shop.key,name:shop.name,online,ready:online&&!!shop.agent_ready,last_seen:shop.agent_last_seen,printer_name:online?shop.printer_name:'',message:online?(shop.message||'Agent online'):'Agent offline',queue:shop.queue||0}})});
app.post('/api/jobs/create',upload.single('file'),(req,res)=>{let id=req.body.shop_id||shopIdFromSlug(req.body.shop||'COPY_ZONE'); let shop=getShop(id,req.body.agent_key); if(!req.file) return res.status(400).json({success:false,error:'file required'}); let jobs=read(jobsFile,[]); let job={id:'JOB'+new Date().toISOString().replace(/[-:.TZ]/g,'').slice(2)+Math.floor(Math.random()*900), shop_id:shop.id, file_name:req.file.originalname, saved_file:req.file.filename, file_url:req.protocol+'://'+req.get('host')+'/uploads/'+encodeURIComponent(req.file.filename), copies:Number(req.body.copies||1), color_mode:req.body.color_mode||req.body.colorMode||'bw', selected_pages:req.body.selected_pages||'', amount:Number(req.body.amount||0), status:'queued', created_at:new Date().toISOString(), updated_at:new Date().toISOString()}; jobs.push(job); write(jobsFile,jobs); res.json({success:true,job})});
app.get('/api/agent/poll',(req,res)=>{let id=req.query.shop_id; let key=req.query.agent_key; if(!id) return res.status(400).json({success:false,error:'shop_id required'}); let shop=getShop(id,key); shop.agent_last_seen=new Date().toISOString(); shop.agent_ready=true; shop.printer_name=req.query.printer_name||shop.printer_name||''; saveShop(shop); let jobs=read(jobsFile,[]); let pending=jobs.filter(j=>norm(j.shop_id)===shop.id && ['queued','pending'].includes(String(j.status||'queued'))).slice(0,1); res.json({success:true,jobs:pending})});
app.all('/api/agent/complete',(req,res)=>{let jobId=req.query.job_id||req.body.job_id||req.query.jobId||req.body.jobId; let status=req.query.status||req.body.status||'printed'; let jobs=read(jobsFile,[]); let found=false; jobs=jobs.map(j=>{if(String(j.id)===String(jobId)){j.status=status;j.updated_at=new Date().toISOString();found=true} return j}); write(jobsFile,jobs); res.json({success:true,found})});
app.get('/api/jobs/list',(req,res)=>{let id=req.query.shop_id; let jobs=read(jobsFile,[]); if(id) jobs=jobs.filter(j=>norm(j.shop_id)===norm(id)); res.json({success:true,jobs:jobs.slice(-50).reverse()})});
app.listen(PORT,()=>console.log('PrintPro Render API running on port '+PORT));
