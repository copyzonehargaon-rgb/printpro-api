const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

function readJson(name, fallback){
  const f = path.join(DATA_DIR, name);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e){ return fallback; }
}
function writeJson(name, data){
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}
function normShop(s){
  s = String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g,'');
  if(!s) return '';
  if(!s.startsWith('SHOP_')) s = 'SHOP_' + s;
  return s;
}
function publicBase(req){
  if(PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}
function getShop(shopId){
  const shops = readJson('shops.json', {});
  return shops[normShop(shopId)] || null;
}
function saveShop(shop){
  const shops = readJson('shops.json', {});
  shop.id = normShop(shop.id || shop.shop_id);
  shops[shop.id] = shop;
  writeJson('shops.json', shops);
  return shop;
}
function authShop(req, soft=false){
  const src = Object.assign({}, req.query, req.body);
  const id = normShop(src.shop_id || src.shopId || src.shop || src.id);
  const key = String(src.agent_key || src.agentKey || src.key || '').trim();
  let shop = getShop(id);
  if(!shop && soft && id){
    shop = { id, name: id.replace(/^SHOP_/,''), agent_key: key || ('AGENT'+Math.floor(100000+Math.random()*900000)), created_at: new Date().toISOString() };
    saveShop(shop);
  }
  if(!shop) return { ok:false, code:404, error:'Shop not found', id, key };
  if(shop.agent_key && key && key !== shop.agent_key) return { ok:false, code:403, error:'Invalid agent key', id, key };
  return { ok:true, shop, id: shop.id, key };
}
function json(res, obj, code=200){ res.status(code).type('application/json').send(JSON.stringify(obj)); }

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = (file.originalname || 'print.pdf').replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,120);
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 80 * 1024 * 1024 } });

app.get('/', (req,res)=> json(res, { success:true, name:'PrintPro Render API', version:4 }));
app.get('/api/health', (req,res)=> json(res, { success:true, time:new Date().toISOString() }));

app.post('/api/shop/create', (req,res)=>{
  const name = String(req.body.name || req.body.shop_name || req.body.shop || '').trim() || 'Shop';
  const raw = req.body.shop_id || name;
  const id = normShop(raw);
  const shops = readJson('shops.json', {});
  if(shops[id]) return json(res, { success:true, shop:shops[id], existing:true });
  const shop = { id, name, mobile:String(req.body.mobile||''), password:String(req.body.password||'123456'), agent_key:'AGENT'+Math.floor(100000+Math.random()*900000), created_at:new Date().toISOString() };
  shops[id]=shop; writeJson('shops.json', shops);
  json(res, { success:true, shop });
});
app.post('/api/shop/login', (req,res)=>{
  const id = normShop(req.body.shop_id || req.body.shop || '');
  const shop = getShop(id);
  if(!shop) return json(res, { success:false, error:'Shop not found' }, 404);
  if(shop.password && String(req.body.password||'') !== shop.password) return json(res, { success:false, error:'Wrong password' }, 403);
  json(res, { success:true, shop });
});

app.get('/api/agent/status', (req,res)=>{
  const src = req.query || {};
  const mode = String(src.mode || '').toLowerCase();
  const auth = authShop(req, true);
  if(!auth.ok) return json(res, { success:false, error:auth.error }, auth.code);
  const shop = auth.shop;
  if(mode === 'read'){
    const last = shop.agent_last_seen ? Date.parse(shop.agent_last_seen) : 0;
    const online = !!last && (Date.now() - last) <= 35000;
    return json(res, { success:true, shop: Object.assign({}, shop, { agent_online:online, agent_ready: online && !!shop.agent_ready, agent_message: online ? (shop.agent_message||'Agent online') : 'Agent offline' }) });
  }
  shop.agent_last_seen = new Date().toISOString();
  shop.agent_online = true;
  shop.agent_ready = String(src.ready ?? '1') === '1' || String(src.ready).toLowerCase() === 'true';
  shop.agent_default_printer = src.default_printer || src.printer_name || shop.agent_default_printer || '';
  shop.agent_printer_name = src.printer_name || shop.agent_default_printer || '';
  shop.agent_sumatra = src.sumatra || shop.agent_sumatra || '';
  shop.agent_spooler = src.spooler || shop.agent_spooler || '';
  shop.agent_queue = parseInt(src.queue || shop.agent_queue || 0) || 0;
  shop.agent_message = src.msg || src.message || (shop.agent_ready ? 'Agent online' : 'Agent online, printer not ready');
  saveShop(shop);

  const jobId = String(src.job_id || src.jobId || '').trim();
  if(jobId){
    const jobs = readJson('jobs.json', []);
    for(const j of jobs){
      if(String(j.id)===jobId && normShop(j.shop_id)===shop.id){
        let st = String(src.status || 'printed').toLowerCase();
        if(['complete','completed','done','success'].includes(st)) st='printed';
        j.status = st; j.updated_at = new Date().toISOString(); j.agent_message = shop.agent_message;
        break;
      }
    }
    writeJson('jobs.json', jobs);
  }
  json(res, { success:true, message:'Agent status updated', shop });
});
app.post('/api/agent/status', (req,res)=> app._router.handle(Object.assign(req,{method:'GET',query:Object.assign({},req.query,req.body)}),res,()=>{}));

app.get('/api/agent/poll', (req,res)=>{
  const auth = authShop(req, false);
  if(!auth.ok) return json(res, { success:false, error:auth.error, jobs:[] }, auth.code);
  const jobs = readJson('jobs.json', []);
  const out = jobs.filter(j => normShop(j.shop_id)===auth.id && ['queued','pending','retry'].includes(String(j.status||'queued').toLowerCase())).slice(0,3);
  json(res, { success:true, jobs:out });
});
app.get('/api/agent/complete', (req,res)=>{
  const id = String(req.query.job_id || req.query.jobId || '').trim();
  const jobs = readJson('jobs.json', []); let ok=false;
  for(const j of jobs){ if(String(j.id)===id){ j.status='printed'; j.updated_at=new Date().toISOString(); ok=true; } }
  writeJson('jobs.json', jobs); json(res,{success:ok});
});
app.get('/api/agent/failed', (req,res)=>{
  const id = String(req.query.job_id || req.query.jobId || '').trim();
  const jobs = readJson('jobs.json', []); let ok=false;
  for(const j of jobs){ if(String(j.id)===id){ j.status='failed'; j.error=String(req.query.reason||req.query.msg||'failed').slice(0,300); j.updated_at=new Date().toISOString(); ok=true; } }
  writeJson('jobs.json', jobs); json(res,{success:ok});
});

app.post('/api/upload', upload.single('file'), (req,res)=>{
  const shopId = normShop(req.body.shop_id || req.body.shop || req.body.shopId);
  const shop = getShop(shopId);
  if(!shop) return json(res,{success:false,error:'Shop not found'},404);
  if(!req.file) return json(res,{success:false,error:'No file'},400);
  const jobs = readJson('jobs.json', []);
  const id = 'JOB' + new Date().toISOString().replace(/\D/g,'').slice(2,14) + Math.floor(Math.random()*900+100);
  const copies = Math.max(1, parseInt(req.body.copies || 1) || 1);
  const pages = Math.max(1, parseInt(req.body.total_pages || req.body.pages || 1) || 1);
  const amount = Math.max(0, parseFloat(req.body.amount || pages*copies*5) || 0);
  const job = {
    id, shop_id: shopId, file_name: req.file.originalname, saved_file: req.file.filename,
    file_url: `${publicBase(req)}/uploads/${encodeURIComponent(req.file.filename)}`,
    copies, colorMode: req.body.colorMode || req.body.color_mode || 'bw', total_pages: pages,
    selected_pages: req.body.selected_pages || '', amount, payment_method:'counter', payment_status:'counter_due',
    status:'queued', created_at:new Date().toISOString(), updated_at:new Date().toISOString()
  };
  jobs.unshift(job); writeJson('jobs.json', jobs);
  json(res,{success:true,job});
});

app.get('/api/admin/overview', (req,res)=>{
  const id = normShop(req.query.shop_id || req.query.shop);
  const shop = getShop(id);
  if(!shop) return json(res,{success:false,error:'Shop not found'},404);
  const last = shop.agent_last_seen ? Date.parse(shop.agent_last_seen) : 0;
  const online = !!last && (Date.now() - last) <= 35000;
  const jobs = readJson('jobs.json', []).filter(j=>normShop(j.shop_id)===id);
  const today = new Date().toISOString().slice(0,10);
  const todayJobs = jobs.filter(j=>String(j.created_at||'').slice(0,10)===today);
  const income = todayJobs.reduce((s,j)=>s+(parseFloat(j.amount)||0),0);
  json(res,{success:true, shop:Object.assign({}, shop,{agent_online:online, agent_ready:online && !!shop.agent_ready, agent_message: online ? (shop.agent_message||'Agent online') : 'Agent offline'}), stats:{today_prints:todayJobs.length,today_income:income,total_orders:jobs.length}, jobs:jobs.slice(0,20)});
});

app.listen(PORT, ()=> console.log('PrintPro Render API running on port '+PORT));
