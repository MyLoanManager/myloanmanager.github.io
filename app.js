import {initializeApp,deleteApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,signInWithEmailAndPassword,signOut,onAuthStateChanged,createUserWithEmailAndPassword,sendPasswordResetEmail,reauthenticateWithCredential,EmailAuthProvider} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {getFirestore,collection,doc,getDoc,getDocs,setDoc,addDoc,updateDoc,deleteDoc,onSnapshot,query,orderBy,limit,writeBatch} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {firebaseConfig} from "./firebase-config.js";

const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);

/* ---------- helpers ---------- */
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inr=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2});
const iso=d=>new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10);
const today=()=>iso(new Date());
const nowISO=()=>new Date().toISOString();
const code=id=>String(id||'').slice(0,6).toUpperCase();
const sum=(a,f)=>a.reduce((s,x)=>s+(+f(x)||0),0);
const toast=(m,bad)=>{const t=$('#toast');t.textContent=m;t.className=bad?'bad show':'show';setTimeout(()=>t.className='',3500)};
const badge=s=>`<span class="badge ${esc(s)}">${esc(s)}</span>`;
const btn=(a,id,t,c='')=>`<button class="btn sm ${c}" data-act="${a}" data-id="${esc(id)}">${t}</button>`;
const mapLink=c=>c.mapsLink?`<a href="${esc(c.mapsLink)}" target="_blank" rel="noopener">Open in Google Maps</a>`:'';

const DEF={businessName:'My Loan Manager',approvalLimit:50000,lateFee:0,
  customerTypes:['Individual','Business','Farmer','Salaried'],
  loanTypes:[{name:'Personal',rate:24},{name:'Business',rate:18},{name:'Gold',rate:12}],
  paymentModes:['Cash','UPI','Bank transfer','Cheque'],
  idTypes:['Aadhaar','Voter ID','PAN','Driving licence']};
const INTEREST=['Flat','Reducing balance'],FREQ=['Daily','Weekly','Monthly'];
const PPY={Daily:365,Weekly:52,Monthly:12};

const S={me:null,settings:{...DEF},customers:[],loans:[],payments:[],followups:[],page:'dashboard',unsubs:[]};
const role=()=>S.me?.role,isAdmin=()=>role()==='admin',isMgr=()=>role()==='manager';
const canApprove=l=>isAdmin()||(isMgr()&&+l.amount<=+S.settings.approvalLimit);
const log=(action,detail)=>addDoc(collection(db,'audit'),{at:nowISO(),uid:S.me.id,name:S.me.name,role:role(),action,detail:detail||''}).catch(()=>{});

/* ---------- loan maths ---------- */
function addPeriod(s,i,f){const d=new Date(s+'T00:00:00');if(f==='Daily')d.setDate(d.getDate()+i);else if(f==='Weekly')d.setDate(d.getDate()+7*i);else d.setMonth(d.getMonth()+i);return iso(d)}
function calc(l){
  const P=+l.amount||0,n=+l.installments||0,ppy=PPY[l.frequency]||12,rate=+l.rate||0,rows=[];
  if(!P||!n||!l.startDate)return{rows,emi:0,total:0,interest:0};
  let emi,bal;
  if(l.interestType==='Flat'){
    const it=P*rate/100*(n/ppy);emi=(P+it)/n;bal=P+it;
    for(let i=1;i<=n;i++){bal-=emi;rows.push({no:i,due:addPeriod(l.startDate,i,l.frequency),emi,principal:P/n,interest:emi-P/n,balance:Math.max(0,bal)})}
  }else{
    const r=rate/100/ppy;emi=r?P*r*Math.pow(1+r,n)/(Math.pow(1+r,n)-1):P/n;bal=P;
    for(let i=1;i<=n;i++){const it=bal*r,pr=emi-it;bal-=pr;rows.push({no:i,due:addPeriod(l.startDate,i,l.frequency),emi,principal:pr,interest:it,balance:Math.max(0,bal)})}
  }
  const total=emi*n;return{rows,emi,total,interest:total-P};
}
function metrics(l){
  const c=calc(l),paid=sum(S.payments.filter(p=>p.loanId===l.id),p=>p.amount),td=today();
  const dueSoFar=c.rows.filter(r=>r.due<=td).length*c.emi,overdue=Math.max(0,dueSoFar-paid);
  let cum=0,first=null;for(const r of c.rows){cum+=r.emi;if(cum>paid+0.01&&r.due<td){first=r;break}}
  const days=overdue>0.5&&first?Math.floor((new Date(td)-new Date(first.due))/864e5):0;
  const missed=overdue>0.5&&c.emi?Math.ceil((overdue-0.01)/c.emi):0;
  const paidInst=c.emi?Math.floor((paid+0.01)/c.emi):0,P=+l.amount||0;
  const prinOut=l.interestType==='Flat'?Math.max(0,P-paidInst*(P/(+l.installments||1))):(paidInst>=c.rows.length?0:paidInst?c.rows[paidInst-1].balance:P);
  return{...c,paid,outstanding:Math.max(0,c.total-paid),overdue,days,lateFee:missed*(+S.settings.lateFee||0),prinOut,paidInst};
}

/* ---------- sortable / searchable table ---------- */
const TS={};
function mount(el,id,cols,rows,o={}){
  const st=TS[id]??={key:o.sort||cols[0].key,dir:o.dir||'asc',q:'',f:''};
  const sc=cols.filter(c=>!c.nosort);
  el.innerHTML=`<div class="bar"><input type="search" class="q" placeholder="Search…" value="${esc(st.q)}">
    ${o.filter?`<select class="f"><option value="">All ${esc(o.filter.label)}</option>${o.filter.options.map(x=>`<option ${st.f===x?'selected':''}>${esc(x)}</option>`).join('')}</select>`:''}
    <label>Sort by <select class="sk">${sc.map(c=>`<option value="${c.key}" ${st.key===c.key?'selected':''}>${esc(c.label)}</option>`).join('')}</select></label>
    <button class="btn sm sd"></button><span class="cnt"></span></div><div class="tw"></div>`;
  const val=(c,r)=>c.val?c.val(r):r[c.key];
  const draw=()=>{
    const q=st.q.toLowerCase();
    const list=rows.filter(r=>(!st.f||o.filter.get(r)===st.f)&&(!q||cols.map(c=>val(c,r)).join(' ').toLowerCase().includes(q)));
    const k=cols.find(c=>c.key===st.key)||cols[0];
    list.sort((a,b)=>{const x=val(k,a),y=val(k,b);const r=(typeof x==='number'&&typeof y==='number')?x-y:String(x??'').localeCompare(String(y??''),undefined,{numeric:true,sensitivity:'base'});return st.dir==='asc'?r:-r});
    $('.cnt',el).textContent=list.length+' records';
    $('.sd',el).textContent=st.dir==='asc'?'↑ Ascending':'↓ Descending';
    $('.tw',el).innerHTML=`<table><thead><tr>${cols.map(c=>`<th ${c.nosort?'':`class="s" data-k="${c.key}"`}>${esc(c.label)}${st.key===c.key?(st.dir==='asc'?' ▲':' ▼'):''}</th>`).join('')}${o.actions?'<th></th>':''}</tr></thead><tbody>${list.map(r=>`<tr>${cols.map(c=>`<td>${c.html?c.html(r):esc(val(c,r))}</td>`).join('')}${o.actions?`<td class="act">${o.actions(r)}</td>`:''}</tr>`).join('')||`<tr><td class="empty" colspan="${cols.length+1}">No records</td></tr>`}</tbody></table>`;
    $$('th.s',el).forEach(th=>th.onclick=()=>{const kk=th.dataset.k;if(st.key===kk)st.dir=st.dir==='asc'?'desc':'asc';else{st.key=kk;st.dir='asc'}$('.sk',el).value=st.key;draw()});
    $$('[data-act]',el).forEach(b=>b.onclick=()=>o.onAct(b.dataset.act,b.dataset.id));
  };
  $('.q',el).oninput=e=>{st.q=e.target.value;draw()};
  if(o.filter)$('.f',el).onchange=e=>{st.f=e.target.value;draw()};
  $('.sk',el).onchange=e=>{st.key=e.target.value;draw()};
  $('.sd',el).onclick=()=>{st.dir=st.dir==='asc'?'desc':'asc';draw()};
  draw();
}

/* ---------- modal / form helpers ---------- */
const modal=h=>{$('#modalBox').innerHTML=h;$('#modal').classList.remove('hidden')};
const closeModal=()=>$('#modal').classList.add('hidden');
$('#modal').addEventListener('mousedown',e=>{if(e.target.id==='modal')closeModal()});
const fld=(label,name,v='',a='')=>`<label>${label}<input name="${name}" value="${esc(v)}" ${a}></label>`;
const sel=(label,name,opts,v='',a='')=>`<label>${label}<select name="${name}" ${a}>${opts.map(o=>{const x=typeof o==='object'?o.name:o;return `<option ${x===v?'selected':''}>${esc(x)}</option>`}).join('')}</select></label>`;
const names=a=>a.map(x=>typeof x==='object'?x.name:x);
function compress(file,maxW=300,maxH=400,q=.7){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{const k=Math.min(maxW/im.width,maxH/im.height,1),w=Math.round(im.width*k),h=Math.round(im.height*k),c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(im,0,0,w,h);res(c.toDataURL('image/jpeg',q))};im.onerror=rej;im.src=r.result};r.onerror=rej;r.readAsDataURL(file)})}
function printHTML(title,body){const w=window.open('','_blank');if(!w)return toast('Allow pop-ups to print',true);w.document.write(`<html><head><title>${esc(title)}</title><style>body{font-family:Arial;padding:24px;max-width:720px;margin:auto}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:6px;text-align:left}</style></head><body>${body}<script>window.print()<\/script></body></html>`);w.document.close()}
function xlsxSave(name,sheets){const wb=XLSX.utils.book_new();for(const [n,rows] of Object.entries(sheets))XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),n);XLSX.writeFile(wb,name)}

/* ---------- auth ---------- */
let loginMsg='';
const showLogin=()=>{$('#shell').classList.add('hidden');$('#login').classList.remove('hidden');$('#loginMsg').textContent=loginMsg};
$('#forgot').onclick=async()=>{
  const m=$('#loginMsg'),email=$('#loginForm').email.value.trim();
  m.style.color='';
  if(!email){m.textContent='Type your email in the box above, then click "Forgot password?".';return}
  try{await sendPasswordResetEmail(auth,email);m.style.color='#1e8449';m.textContent='If this email has an account, a password reset link has been sent. Check your inbox and spam folder.'}
  catch(e){m.style.color='';m.textContent=e.code==='auth/invalid-email'?'That email address is not valid.':e.code==='auth/too-many-requests'?'Too many attempts. Please wait a few minutes and try again.':'Could not send the reset email. Try again later.'}
};
$('#loginForm').onsubmit=async e=>{e.preventDefault();loginMsg='';$('#loginMsg').textContent='';$('#loginMsg').style.color='';const f=new FormData(e.target);
  try{await signInWithEmailAndPassword(auth,f.get('email').trim(),f.get('password'))}catch{loginMsg='Wrong email or password.';$('#loginMsg').textContent=loginMsg}};
$('#logout').onclick=()=>signOut(auth);
onAuthStateChanged(auth,async u=>{
  S.unsubs.forEach(f=>f());S.unsubs=[];
  if(!u){S.me=null;return showLogin()}
  try{
    const s=await getDoc(doc(db,'users',u.uid));
    if(!s.exists()||s.data().active===false){loginMsg='This account is not set up or has been disabled.';await signOut(auth);return}
    S.me={id:u.uid,...s.data()};start();
  }catch(err){loginMsg='Could not load account: '+err.code;await signOut(auth)}
});
let idle;const resetIdle=()=>{clearTimeout(idle);if(S.me)idle=setTimeout(()=>{loginMsg='Logged out after 15 minutes of inactivity.';signOut(auth)},15*60e3)};
['click','keydown','touchstart'].forEach(ev=>addEventListener(ev,resetIdle));

function start(){
  $('#login').classList.add('hidden');$('#shell').classList.remove('hidden');
  $('#who').textContent=`${S.me.name} (${role()})`;resetIdle();
  const sub=(name,key)=>S.unsubs.push(onSnapshot(collection(db,name),s=>{S[key]=s.docs.map(d=>({id:d.id,...d.data()}));render()},e=>toast(name+': '+e.code,true)));
  sub('customers','customers');sub('loans','loans');sub('payments','payments');sub('followups','followups');
  S.unsubs.push(onSnapshot(doc(db,'settings','main'),async s=>{
    if(s.exists()){S.settings={...DEF,...s.data()};$('#brand').textContent=S.settings.businessName;render()}
    else if(isAdmin())await setDoc(doc(db,'settings','main'),DEF);
  }));
  if(!location.hash)location.hash='#dashboard';route();
}
const NAV=()=>[['dashboard','Dashboard'],['customers','Customers'],['loans','Loans'],['payments','Payments'],['overdue','Overdue'],['reports','Reports'],
  ...(isAdmin()||isMgr()?[['data',isAdmin()?'Import / Export':'Export']]:[]),
  ...(isAdmin()?[['users','Users'],['settings','Settings']]:[]),...(isAdmin()||isMgr()?[['audit','Audit log']]:[])];
function route(){S.page=(location.hash||'#dashboard').slice(1);if(!NAV().some(n=>n[0]===S.page))S.page='dashboard';render()}
addEventListener('hashchange',()=>S.me&&route());
function render(){
  if(!S.me)return;
  $('#nav').innerHTML=NAV().map(([k,t])=>`<a href="#${k}" class="${k===S.page?'on':''}">${t}</a>`).join('');
  pages[S.page]($('#main'));
}

/* ---------- Dashboard ---------- */
const pages={};
let chartKind='daily';
const addDays=(s,n)=>{const d=new Date(s+'T00:00:00');d.setDate(d.getDate()+n);return iso(d)};
const monday=s=>{const d=new Date(s+'T00:00:00');d.setDate(d.getDate()-((d.getDay()+6)%7));return iso(d)};
const monthEnd=s=>iso(new Date(+s.slice(0,4),+s.slice(5,7),0));
function periods(kind){
  const td=today(),out=[];
  if(kind==='daily')for(let i=13;i>=0;i--){const d=addDays(td,-i);out.push({label:d.slice(8)+'/'+d.slice(5,7),from:d,to:d})}
  else if(kind==='weekly'){const m=monday(td);for(let i=7;i>=0;i--){const f=addDays(m,-7*i);out.push({label:f.slice(8)+'/'+f.slice(5,7),from:f,to:addDays(f,6)})}}
  else for(let i=5;i>=0;i--){const d=new Date(+td.slice(0,4),+td.slice(5,7)-1-i,1),f=iso(d);out.push({label:d.toLocaleString('en',{month:'short'})+' '+String(d.getFullYear()).slice(2),from:f,to:monthEnd(f)})}
  return out;
}
function renderProgress(el,live){
  const td=today(),rows=live.flatMap(x=>x.m.rows);
  const expected=(f,t)=>sum(rows.filter(r=>r.due>=f&&r.due<=t),r=>r.emi);
  const collected=(f,t)=>sum(S.payments.filter(p=>p.date>=f&&p.date<=t),p=>p.amount);
  const wk=monday(td),items=[['Today',td,td],['This week',wk,addDays(wk,6)],['This month',td.slice(0,8)+'01',monthEnd(td)]];
  const bars=items.map(([n,f,t])=>{
    const e=expected(f,t),c=collected(f,t),pc=e?Math.round(c/e*100):(c>0?100:0);
    return `<div class="pb"><div class="pbt"><b>${n}</b><span>${inr(c)} collected of ${inr(e)} due · ${pc}%</span></div><div class="pbar"><i class="${pc>=100?'full':pc>=60?'mid':'low'}" style="width:${Math.min(pc,100)}%"></i></div></div>`}).join('');
  el.innerHTML=`<div class="card"><h3 style="margin-top:0">Collection progress</h3>${bars}
    <p class="muted">Progress = money collected in the period ÷ installments scheduled to fall due in it. Payments of older overdue amounts also count, so it can go above 100%.</p></div>
    <div class="card" style="margin:14px 0"><div class="row" style="margin-top:0"><h3 style="margin:0;flex:1">Collected vs due</h3>
    ${[['daily','Daily (14 days)'],['weekly','Weekly (8 weeks)'],['monthly','Monthly (6 months)']].map(([k,t])=>`<button class="btn sm ${chartKind===k?'on':''}" data-k="${k}">${t}</button>`).join('')}</div><div id="chart"></div></div>`;
  const draw=()=>{
    const ps=periods(chartKind).map(p=>({...p,e:expected(p.from,p.to),c:collected(p.from,p.to)}));
    const max=Math.max(1,...ps.flatMap(p=>[p.e,p.c])),W=640,H=230,L=8,B=34,T=12,ch=H-B-T,gw=(W-L*2)/ps.length,bw=Math.min(22,gw*.36);
    const g=ps.map((p,i)=>{const x=L+i*gw+gw/2,he=p.e/max*ch,hc=p.c/max*ch;
      return `<g><title>${esc(p.label)}: collected ${inr(p.c)}, due ${inr(p.e)}</title><rect class="bd" x="${x-bw-1}" y="${T+ch-he}" width="${bw}" height="${he}" rx="3"/><rect class="bc" x="${x+1}" y="${T+ch-hc}" width="${bw}" height="${hc}" rx="3"/><text x="${x}" y="${H-14}" text-anchor="middle" font-size="10">${esc(p.label)}</text></g>`}).join('');
    $('#chart',el).innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Collected versus due bar chart"><line x1="${L}" x2="${W-L}" y1="${T+ch}" y2="${T+ch}" stroke="#c9d0de"/>${g}</svg>
      <div class="legend"><span><i class="bd"></i>Due</span><span><i class="bc"></i>Collected</span><span>Tallest bar: ${inr(max)}</span></div>`;
  };
  $$('[data-k]',el).forEach(b=>b.onclick=()=>{chartKind=b.dataset.k;$$('[data-k]',el).forEach(x=>x.classList.toggle('on',x.dataset.k===chartKind));draw()});
  draw();
}
pages.dashboard=el=>{
  const L=S.loans,td=today();
  const given=sum(L.filter(l=>['Approved','Active','Closed','Defaulted'].includes(l.status)),l=>l.amount);
  const live=L.filter(l=>['Approved','Active','Defaulted'].includes(l.status)).map(l=>({l,m:metrics(l)}));
  const od=live.filter(x=>x.m.overdue>0.5);
  el.innerHTML=`<h2>Dashboard</h2><div class="cards">
    <div class="stat">Loans given<b>${inr(given)}</b></div>
    <div class="stat">Total collected<b>${inr(sum(S.payments,p=>p.amount))}</b></div>
    <div class="stat">Outstanding<b>${inr(sum(live,x=>x.m.outstanding))}</b></div>
    <div class="stat">Collected today<b>${inr(sum(S.payments.filter(p=>p.date===td),p=>p.amount))}</b></div>
    <div class="stat">Overdue loans<b>${od.length}</b></div>
    <div class="stat">Awaiting approval<b>${L.filter(l=>l.status==='Pending').length}</b></div>
    <div class="stat">Customers<b>${S.customers.length}</b></div></div>
    ${isAdmin()?'<div id="prog"></div>':''}
    <h3>Installments due today</h3><div id="dueToday"></div>`;
  if(isAdmin())renderProgress($('#prog'),live);
  const rows=live.filter(x=>x.m.rows.some(r=>r.due===td)).map(x=>({id:x.l.id,customer:x.l.customerName,loan:code(x.l.id),emi:x.m.emi,overdue:x.m.overdue}));
  mount($('#dueToday'),'due',[{key:'customer',label:'Customer'},{key:'loan',label:'Loan'},{key:'emi',label:'Installment',html:r=>inr(r.emi)},{key:'overdue',label:'Overdue incl. today',html:r=>inr(r.overdue)}],rows,{actions:r=>btn('pay',r.id,'Record payment'),onAct:(a,id)=>payForm(id)});
};

/* ---------- Customers ---------- */
const custOut=c=>sum(S.loans.filter(l=>l.customerId===c.id&&['Approved','Active','Defaulted'].includes(l.status)),l=>metrics(l).outstanding);
pages.customers=el=>{
  el.innerHTML=`<h2>Customers</h2><button class="btn primary" id="addC">+ Add customer</button><div id="t"></div>`;
  $('#addC').onclick=()=>custForm();
  mount($('#t'),'cust',[
    {key:'photo',label:'Photo',nosort:true,html:c=>c.photo?`<img class="thumb" src="${c.photo}">`:'<img class="thumb">'},
    {key:'name',label:'Name'},{key:'phone',label:'Phone'},{key:'customerType',label:'Type'},
    {key:'address',label:'Address',html:c=>esc(c.address)+(c.mapsLink?` · <a href="${esc(c.mapsLink)}" target="_blank" rel="noopener">Map</a>`:'')},
    {key:'loans',label:'Loans',val:c=>S.loans.filter(l=>l.customerId===c.id).length},
    {key:'out',label:'Outstanding',val:c=>custOut(c),html:c=>inr(custOut(c))},
    {key:'created',label:'Added',html:c=>esc((c.created||'').slice(0,10))}],S.customers,
    {filter:{label:'types',options:S.settings.customerTypes,get:c=>c.customerType},actions:c=>btn('view',c.id,'View')+btn('edit',c.id,'Edit')+(isAdmin()?btn('del',c.id,'Delete','danger'):''),
     onAct:(a,id)=>a==='view'?custView(id):a==='del'?deleteCustomer(id):custForm(id)});
};
function custView(id){
  const c=S.customers.find(x=>x.id===id);if(!c)return;
  const ls=S.loans.filter(l=>l.customerId===id);
  modal(`<h2>${esc(c.name)}</h2><div class="row" style="align-items:flex-start">${c.photo?`<img class="passport" src="${c.photo}">`:''}
    <div class="kv" style="flex:1"><span>Phone</span><span>${esc(c.phone)}</span><span>Type</span><span>${esc(c.customerType)}</span>
    <span>ID proof</span><span>${esc(c.idType)} ${esc(c.idNumber)}</span><span>Address</span><span>${esc(c.address)}</span>
    <span>Geotag</span><span>${c.lat?esc(c.lat+', '+c.lng)+' · ':''}${mapLink(c)||'—'}</span>
    <span>Guarantor</span><span>${esc(c.guarantorName)} ${esc(c.guarantorPhone)}</span><span>Notes</span><span>${esc(c.notes)}</span></div></div>
    <h3>Loans</h3><table><tr><th>Loan</th><th>Amount</th><th>Status</th><th>Outstanding</th><th></th></tr>
    ${ls.map(l=>`<tr><td>${code(l.id)}</td><td>${inr(l.amount)}</td><td>${badge(l.status)}</td><td>${inr(metrics(l).outstanding)}</td><td>${btn('loan',l.id,'Open')}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">No loans</td></tr>'}</table>
    <div class="row"><button class="btn primary" id="nl">+ New loan</button><button class="btn" id="ed">Edit</button>${isAdmin()?'<button class="btn danger" id="del">Delete</button>':''}<button class="btn" onclick="document.getElementById('modal').classList.add('hidden')">Close</button></div>`);
  $$('[data-act=loan]').forEach(b=>b.onclick=()=>loanView(b.dataset.id));
  $('#nl').onclick=()=>loanForm(null,id);$('#ed').onclick=()=>custForm(id);
  if(isAdmin())$('#del').onclick=()=>deleteCustomer(id);
}
function deleteCustomer(id){
  if(!isAdmin())return;
  const c=S.customers.find(x=>x.id===id);if(!c)return;
  const ls=S.loans.filter(l=>l.customerId===id),lid=new Set(ls.map(l=>l.id));
  const ps=S.payments.filter(p=>p.customerId===id||lid.has(p.loanId)),fs=S.followups.filter(f=>lid.has(f.loanId));
  modal(`<h2 style="color:#c0392b">⚠ Delete customer permanently</h2>
    <div class="preview" style="background:#fdecea">
      <p style="margin-top:0"><b>Warning:</b> you are about to delete <b>${esc(c.name)}</b> (${esc(c.phone)}).</p>
      ${ls.length?`<p>This will also permanently delete <b>${ls.length} loan(s)</b>, <b>${ps.length} payment record(s)</b> and <b>${fs.length} follow-up note(s)</b> belonging to this customer. Collected-money totals and reports will change.</p>`:'<p>This customer has no loans.</p>'}
      <p style="margin-bottom:0"><b>This cannot be undone.</b> Export a backup first (Import / Export page) if you are not sure.</p></div>
    <form id="f"><label>Type your Admin password to confirm<input type="password" name="pw" required autocomplete="current-password"></label>
    <div class="err" id="dm"></div>
    <div class="row"><button class="btn danger" type="submit">Delete permanently</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
  $('#cx').onclick=closeModal;
  $('#f').onsubmit=async e=>{
    e.preventDefault();const f=e.target,b=$('button[type=submit]',f),msg=$('#dm');msg.textContent='';
    const pw=new FormData(f).get('pw');b.disabled=true;
    try{await reauthenticateWithCredential(auth.currentUser,EmailAuthProvider.credential(auth.currentUser.email,pw))}
    catch(err){b.disabled=false;msg.textContent=err.code==='auth/too-many-requests'?'Too many attempts. Please wait a few minutes.':'Wrong password. Nothing was deleted.';return}
    try{
      const refs=[...ps.map(p=>doc(db,'payments',p.id)),...fs.map(x=>doc(db,'followups',x.id)),...ls.map(l=>doc(db,'loans',l.id)),doc(db,'customers',id)];
      for(let i=0;i<refs.length;i+=400){const bt=writeBatch(db);refs.slice(i,i+400).forEach(r=>bt.delete(r));await bt.commit()}
      log('Deleted customer',`${c.name} (${c.phone}) with ${ls.length} loans, ${ps.length} payments`);
      closeModal();toast('Customer deleted');
    }catch(err){b.disabled=false;msg.textContent='Delete failed: '+err.code}
  };
}
function custForm(id){
  const c=S.customers.find(x=>x.id===id)||{},st=S.settings;let photo=c.photo||'';
  modal(`<h2>${id?'Edit':'Add'} customer</h2><form id="f"><div class="grid2">
    ${fld('Full name *','name',c.name,'required')}${fld('Phone *','phone',c.phone,'required inputmode="tel"')}
    ${sel('Customer type','customerType',st.customerTypes,c.customerType)}${sel('ID proof type','idType',st.idTypes,c.idType)}
    ${fld('ID number','idNumber',c.idNumber)}${fld('Guarantor name','guarantorName',c.guarantorName)}${fld('Guarantor phone','guarantorPhone',c.guarantorPhone)}</div>
    <label>Home address<textarea name="address">${esc(c.address)}</textarea></label>
    <div class="grid2">${fld('Google Maps link','mapsLink',c.mapsLink,'placeholder="Paste a Google Maps link"')}
    <div><label>Latitude, Longitude<input name="ll" value="${c.lat?esc(c.lat+', '+c.lng):''}" readonly></label></div></div>
    <div class="row"><button type="button" class="btn" id="gps">📍 Capture my location (at customer's home)</button><span class="muted" id="gpsMsg"></span></div>
    <label>Passport photo (take with camera or choose file)<input type="file" name="photoFile" accept="image/*"></label>
    <div class="row"><img id="pv" class="passport" ${photo?`src="${photo}"`:'style="display:none"'}></div>
    <label>Notes<textarea name="notes">${esc(c.notes)}</textarea></label>
    <div class="row"><button class="btn primary" type="submit">Save</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
  const f=$('#f');
  $('#cx').onclick=closeModal;
  $('#gps').onclick=()=>{
    if(!navigator.geolocation)return $('#gpsMsg').textContent='Location not supported on this device';
    $('#gpsMsg').textContent='Getting location…';
    navigator.geolocation.getCurrentPosition(p=>{const la=p.coords.latitude.toFixed(6),lo=p.coords.longitude.toFixed(6);
      f.mapsLink.value=`https://www.google.com/maps?q=${la},${lo}`;f.ll.value=`${la}, ${lo}`;$('#gpsMsg').textContent=`Captured (±${Math.round(p.coords.accuracy)} m)`},
      e=>$('#gpsMsg').textContent='Could not get location: '+e.message,{enableHighAccuracy:true,timeout:20000});};
  f.mapsLink.oninput=()=>{const m=f.mapsLink.value.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)||f.mapsLink.value.match(/[?&](?:q|ll|query)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/);if(m)f.ll.value=`${m[1]}, ${m[2]}`};
  f.photoFile.onchange=async()=>{const file=f.photoFile.files[0];if(!file)return;try{photo=await compress(file);$('#pv').src=photo;$('#pv').style.display=''}catch{toast('Could not read image',true)}};
  f.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));
    const ll=(d.ll||'').split(',').map(x=>x.trim());
    const data={name:d.name.trim(),phone:d.phone.trim(),customerType:d.customerType,idType:d.idType,idNumber:d.idNumber||'',guarantorName:d.guarantorName||'',guarantorPhone:d.guarantorPhone||'',address:d.address||'',mapsLink:d.mapsLink||'',lat:ll[0]||'',lng:ll[1]||'',notes:d.notes||'',photo};
    try{if(id){await updateDoc(doc(db,'customers',id),data);log('Edited customer',data.name)}else{await addDoc(collection(db,'customers'),{...data,created:nowISO(),createdBy:S.me.id,createdByName:S.me.name});log('Added customer',data.name)}
      closeModal();toast('Customer saved')}catch(err){toast('Save failed: '+err.code,true)}};
}

/* ---------- Loans ---------- */
pages.loans=el=>{
  el.innerHTML=`<h2>Loans</h2><button class="btn primary" id="addL">+ New loan</button><div id="t"></div>`;
  $('#addL').onclick=()=>loanForm();
  mount($('#t'),'loans',[
    {key:'code',label:'Loan',val:l=>code(l.id)},{key:'customerName',label:'Customer'},{key:'loanType',label:'Type'},
    {key:'amount',label:'Amount',val:l=>+l.amount,html:l=>inr(l.amount)},{key:'rate',label:'Rate %/yr',val:l=>+l.rate},
    {key:'frequency',label:'Frequency'},{key:'emi',label:'Installment',val:l=>calc(l).emi,html:l=>inr(calc(l).emi)},
    {key:'status',label:'Status',html:l=>badge(l.status)},{key:'out',label:'Outstanding',val:l=>metrics(l).outstanding,html:l=>inr(metrics(l).outstanding)},
    {key:'startDate',label:'Start'},{key:'createdByName',label:'Created by'}],S.loans,
    {filter:{label:'statuses',options:['Pending','Approved','Active','Closed','Defaulted','Rejected'],get:l=>l.status},
     actions:l=>btn('view',l.id,'View')+(l.status==='Pending'&&canApprove(l)?btn('approve',l.id,'Approve'):''),
     onAct:(a,id)=>a==='approve'?setStatus(id,'Approved'):loanView(id)});
};
async function setStatus(id,status){
  const l=S.loans.find(x=>x.id===id);
  try{await updateDoc(doc(db,'loans',id),{status,...(status==='Approved'?{approvedBy:S.me.name,approvedAt:nowISO()}:{})});log(`Loan ${status}`,code(id)+' '+l.customerName);toast('Loan '+status.toLowerCase());if(!$('#modal').classList.contains('hidden'))loanView(id)}
  catch(e){toast(e.code==='permission-denied'?'Not allowed: needs higher approval':e.code,true)}
}
function loanForm(id,custId){
  const st=S.settings;
  if(!S.customers.length)return toast('Add a customer first',true);
  const l=S.loans.find(x=>x.id===id)||{customerId:custId||S.customers[0].id,loanType:st.loanTypes[0].name,interestType:'Reducing balance',frequency:'Monthly',amount:'',rate:st.loanTypes[0].rate,installments:12,startDate:today(),processingFee:0,collateral:'',notes:''};
  modal(`<h2>${id?'Edit':'New'} loan application</h2><form id="f"><div class="grid2">
    <label>Customer<select name="customerId">${S.customers.map(c=>`<option value="${c.id}" ${c.id===l.customerId?'selected':''}>${esc(c.name)} — ${esc(c.phone)}</option>`).join('')}</select></label>
    ${sel('Loan type','loanType',names(st.loanTypes),l.loanType)}
    ${sel('Interest type','interestType',INTEREST,l.interestType)}${sel('Repayment frequency','frequency',FREQ,l.frequency)}
    ${fld('Loan amount (₹) *','amount',l.amount,'type="number" min="1" step="any" required')}${fld('Interest rate (% per year) *','rate',l.rate,'type="number" min="0" step="any" required')}
    ${fld('Number of installments *','installments',l.installments,'type="number" min="1" step="1" required')}${fld('Start date *','startDate',l.startDate,'type="date" required')}
    ${fld('Processing fee (₹)','processingFee',l.processingFee,'type="number" min="0" step="any"')}${fld('Collateral / security','collateral',l.collateral)}</div>
    <label>Notes<textarea name="notes">${esc(l.notes)}</textarea></label>
    <div class="preview" id="pvw"></div>
    <div class="row"><button class="btn primary" type="submit">${id?'Save':'Submit application'}</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
  const f=$('#f'),read=()=>Object.fromEntries(new FormData(f));
  const pv=()=>{const d=read(),c=calc(d);$('#pvw').innerHTML=c.emi?`Installment: <b>${inr(c.emi)}</b> × ${d.installments} = total payable <b>${inr(c.total)}</b> (interest ${inr(c.interest)}) · Last due ${c.rows.at(-1).due}`:'Enter amount, rate and installments to see the installment.'};
  f.oninput=pv;f.loanType.onchange=()=>{const t=st.loanTypes.find(x=>x.name===f.loanType.value);if(t&&t.rate!=null)f.rate.value=t.rate;pv()};pv();
  $('#cx').onclick=closeModal;
  f.onsubmit=async e=>{e.preventDefault();const d=read(),c=S.customers.find(x=>x.id===d.customerId);
    const data={customerId:d.customerId,customerName:c.name,customerPhone:c.phone,loanType:d.loanType,interestType:d.interestType,frequency:d.frequency,amount:+d.amount,rate:+d.rate,installments:+d.installments,startDate:d.startDate,processingFee:+d.processingFee||0,collateral:d.collateral||'',notes:d.notes||''};
    try{if(id){await updateDoc(doc(db,'loans',id),data);log('Edited loan',code(id))}
      else{const r=await addDoc(collection(db,'loans'),{...data,status:'Pending',created:nowISO(),createdBy:S.me.id,createdByName:S.me.name});log('Created loan application',code(r.id)+' '+c.name+' '+inr(data.amount))}
      closeModal();toast(id?'Loan saved':canApprove(data)?'Application saved — you can approve it':'Application saved — waiting for approval'+(data.amount>st.approvalLimit?' by Admin':''))}
    catch(err){toast('Save failed: '+err.code,true)}};
}
function loanView(id){
  const l=S.loans.find(x=>x.id===id);if(!l)return;const m=metrics(l),c=S.customers.find(x=>x.id===l.customerId)||{};
  const pays=S.payments.filter(p=>p.loanId===id).sort((a,b)=>b.date.localeCompare(a.date));
  let cum=0;
  const sched=m.rows.map(r=>{cum+=r.emi;const st=cum<=m.paid+0.01?'Paid':(cum-r.emi<m.paid-0.01?'Partly paid':(r.due<today()?'Overdue':'Upcoming'));return `<tr><td>${r.no}</td><td>${r.due}</td><td>${inr(r.emi)}</td><td>${inr(r.principal)}</td><td>${inr(r.interest)}</td><td>${inr(r.balance)}</td><td>${st}</td></tr>`}).join('');
  const live=['Approved','Active','Defaulted'].includes(l.status);
  modal(`<h2>Loan ${code(id)} ${badge(l.status)}</h2>
    <div class="kv"><span>Customer</span><span>${esc(l.customerName)} (${esc(c.phone||'')})</span><span>Type</span><span>${esc(l.loanType)} · ${esc(l.interestType)} · ${esc(l.frequency)}</span>
    <span>Amount</span><span>${inr(l.amount)} at ${esc(l.rate)}% per year, ${esc(l.installments)} installments from ${esc(l.startDate)}</span>
    <span>Installment</span><span>${inr(m.emi)} (total payable ${inr(m.total)}, interest ${inr(m.interest)})</span><span>Processing fee</span><span>${inr(l.processingFee)}</span>
    <span>Collateral</span><span>${esc(l.collateral)||'—'}</span><span>Created by</span><span>${esc(l.createdByName)}${l.approvedBy?' · approved by '+esc(l.approvedBy):''}</span>
    <span>Paid</span><span>${inr(m.paid)}</span><span>Outstanding</span><span><b>${inr(m.outstanding)}</b></span>
    <span>Overdue</span><span>${m.overdue>0.5?`${inr(m.overdue)} (${m.days} days)${m.lateFee?' + late fee '+inr(m.lateFee):''}`:'None'}</span>
    <span>Foreclosure (estimate)</span><span>${inr(m.prinOut+m.lateFee)} = principal outstanding ${inr(m.prinOut)} + late fee</span></div>
    ${l.status==='Pending'&&!canApprove(l)?`<p class="muted">Needs ${+l.amount>+S.settings.approvalLimit?'Admin':'Manager or Admin'} approval.</p>`:''}
    <div class="row">${['Approved','Active'].includes(l.status)?'<button class="btn primary" id="pay">Record payment</button>':''}
    ${l.status==='Pending'&&canApprove(l)?'<button class="btn primary" id="ap">Approve</button><button class="btn danger" id="rj">Reject</button>':''}
    ${(isAdmin()||isMgr())&&live&&l.status!=='Defaulted'?'<button class="btn" id="df">Mark defaulted</button>':''}
    ${(isAdmin()||isMgr())&&live?'<button class="btn" id="cl">Close loan</button>':''}
    ${l.status==='Pending'||isAdmin()?'<button class="btn" id="ed">Edit</button>':''}
    <button class="btn" id="pr">Print statement</button><button class="btn" id="x">Close</button></div>
    <h3>Repayment schedule</h3><div class="tw"><table><tr><th>#</th><th>Due</th><th>Installment</th><th>Principal</th><th>Interest</th><th>Balance</th><th>Status</th></tr>${sched}</table></div>
    <h3>Payments</h3><div class="tw"><table><tr><th>Date</th><th>Amount</th><th>Mode</th><th>Received by</th><th></th></tr>${pays.map(p=>`<tr><td>${esc(p.date)}</td><td>${inr(p.amount)}</td><td>${esc(p.mode)}</td><td>${esc(p.receivedByName)}</td><td>${btn('rc',p.id,'Receipt')}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">No payments</td></tr>'}</table></div>`);
  $('#x').onclick=closeModal;
  const on=(i,f)=>{const e=$(i);if(e)e.onclick=f};
  on('#pay',()=>payForm(id));on('#ap',()=>setStatus(id,'Approved'));on('#rj',()=>setStatus(id,'Rejected'));
  on('#df',()=>setStatus(id,'Defaulted'));on('#cl',()=>confirm('Close this loan?')&&setStatus(id,'Closed'));on('#ed',()=>loanForm(id));
  on('#pr',()=>printHTML('Loan statement',`<h2>${esc(S.settings.businessName)}</h2><h3>Loan statement ${code(id)}</h3><p>${esc(l.customerName)} · ${inr(l.amount)} · ${esc(l.interestType)} ${esc(l.rate)}% · ${esc(l.frequency)}</p><p>Paid ${inr(m.paid)} · Outstanding ${inr(m.outstanding)}</p><table><tr><th>#</th><th>Due</th><th>Installment</th><th>Principal</th><th>Interest</th><th>Balance</th></tr>${m.rows.map(r=>`<tr><td>${r.no}</td><td>${r.due}</td><td>${inr(r.emi)}</td><td>${inr(r.principal)}</td><td>${inr(r.interest)}</td><td>${inr(r.balance)}</td></tr>`).join('')}</table><h3>Payments</h3><table><tr><th>Date</th><th>Amount</th><th>Mode</th></tr>${pays.map(p=>`<tr><td>${esc(p.date)}</td><td>${inr(p.amount)}</td><td>${esc(p.mode)}</td></tr>`).join('')}</table>`));
  $$('[data-act=rc]').forEach(b=>b.onclick=()=>receipt(b.dataset.id));
}

/* ---------- Payments ---------- */
function payForm(loanId){
  const open=S.loans.filter(l=>['Approved','Active'].includes(l.status));
  if(!open.length)return toast('No approved or active loans to collect on',true);
  const l0=open.find(l=>l.id===loanId)||open[0];
  modal(`<h2>Record payment</h2><form id="f">
    <label>Loan<select name="loanId">${open.map(l=>`<option value="${l.id}" ${l.id===l0.id?'selected':''}>${code(l.id)} — ${esc(l.customerName)} (${inr(l.amount)})</option>`).join('')}</select></label>
    <div class="preview" id="info"></div><div class="grid2">${fld('Amount (₹) *','amount','','type="number" min="1" step="any" required')}${fld('Date *','date',today(),'type="date" required')}
    ${sel('Payment mode','mode',S.settings.paymentModes)}${fld('Note','note')}</div>
    <div class="row"><button class="btn primary" type="submit">Save payment</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
  const f=$('#f'),info=()=>{const l=S.loans.find(x=>x.id===f.loanId.value),m=metrics(l);$('#info').innerHTML=`Installment ${inr(m.emi)} · Outstanding <b>${inr(m.outstanding)}</b> · Overdue ${inr(m.overdue)}`;if(!f.amount.value)f.amount.value=Math.round(Math.min(m.overdue>0.5?m.overdue:m.emi,m.outstanding)*100)/100};
  f.loanId.onchange=()=>{f.amount.value='';info()};info();$('#cx').onclick=closeModal;
  f.onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f)),l=S.loans.find(x=>x.id===d.loanId),m=metrics(l),amt=+d.amount;
    if(amt>m.outstanding+0.5&&!confirm(`Amount is more than the outstanding ${inr(m.outstanding)}. Save anyway?`))return;
    try{const r=await addDoc(collection(db,'payments'),{loanId:l.id,customerId:l.customerId,customerName:l.customerName,amount:amt,date:d.date,mode:d.mode,note:d.note||'',receivedBy:S.me.id,receivedByName:S.me.name,created:nowISO()});
      log('Recorded payment',`${inr(amt)} for loan ${code(l.id)} (${l.customerName})`);
      const left=m.outstanding-amt,ns=left<=0.5?'Closed':'Active';
      if(ns!==l.status)await updateDoc(doc(db,'loans',l.id),{status:ns}).catch(()=>{});
      closeModal();toast('Payment saved');if(confirm('Print receipt?'))setTimeout(()=>receipt(r.id),400)}
    catch(err){toast('Save failed: '+err.code,true)}};
}
function receipt(pid){
  const p=S.payments.find(x=>x.id===pid)||{},l=S.loans.find(x=>x.id===p.loanId);if(!l)return toast('Receipt data is still loading, try again',true);const m=metrics(l);
  printHTML('Receipt',`<h2>${esc(S.settings.businessName)}</h2><h3>Payment receipt #${code(pid)}</h3><table>
    <tr><td>Date</td><td>${esc(p.date)}</td></tr><tr><td>Customer</td><td>${esc(p.customerName)}</td></tr><tr><td>Loan</td><td>${code(l.id)}</td></tr>
    <tr><td>Amount received</td><td><b>${inr(p.amount)}</b></td></tr><tr><td>Mode</td><td>${esc(p.mode)}</td></tr><tr><td>Received by</td><td>${esc(p.receivedByName)}</td></tr>
    <tr><td>Outstanding balance</td><td>${inr(m.outstanding)}</td></tr></table><p style="margin-top:40px">Signature: ____________________</p>`);
}
pages.payments=el=>{
  el.innerHTML=`<h2>Payments</h2><button class="btn primary" id="addP">+ Record payment</button><div id="t"></div>`;
  $('#addP').onclick=()=>payForm();
  mount($('#t'),'pays',[{key:'date',label:'Date'},{key:'customerName',label:'Customer'},{key:'loan',label:'Loan',val:p=>code(p.loanId)},
    {key:'amount',label:'Amount',val:p=>+p.amount,html:p=>inr(p.amount)},{key:'mode',label:'Mode'},{key:'receivedByName',label:'Received by'},{key:'note',label:'Note'}],S.payments,
    {sort:'date',dir:'desc',filter:{label:'modes',options:S.settings.paymentModes,get:p=>p.mode},
     actions:p=>btn('rc',p.id,'Receipt')+(isAdmin()?btn('edit',p.id,'Edit')+btn('del',p.id,'Delete','danger'):''),
     onAct:async(a,id)=>{if(a==='rc')return receipt(id);const p=S.payments.find(x=>x.id===id);
       if(a==='del'){if(!confirm('Delete this payment?'))return;await deleteDoc(doc(db,'payments',id));log('Deleted payment',`${inr(p.amount)} ${p.customerName}`);return}
       modal(`<h2>Edit payment</h2><form id="f"><div class="grid2">${fld('Amount','amount',p.amount,'type="number" step="any" required')}${fld('Date','date',p.date,'type="date" required')}${sel('Mode','mode',S.settings.paymentModes,p.mode)}${fld('Note','note',p.note)}</div><div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
       $('#cx').onclick=closeModal;$('#f').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));await updateDoc(doc(db,'payments',id),{amount:+d.amount,date:d.date,mode:d.mode,note:d.note});log('Edited payment',`${inr(p.amount)} → ${inr(d.amount)} ${p.customerName}`);closeModal();toast('Saved')}}});
};

/* ---------- Overdue & follow-ups ---------- */
pages.overdue=el=>{
  const rows=S.loans.filter(l=>['Approved','Active','Defaulted'].includes(l.status)).map(l=>({l,m:metrics(l)})).filter(x=>x.m.overdue>0.5).map(({l,m})=>{
    const fu=S.followups.filter(f=>f.loanId===l.id).sort((a,b)=>b.at.localeCompare(a.at))[0];
    return{id:l.id,customer:l.customerName,phone:l.customerPhone||'',loan:code(l.id),overdue:m.overdue,days:m.days,lateFee:m.lateFee,total:m.overdue+m.lateFee,note:fu?`${fu.at.slice(0,10)}: ${fu.note}`:''}});
  el.innerHTML=`<h2>Overdue & follow-ups</h2><div id="t"></div>`;
  mount($('#t'),'od',[{key:'customer',label:'Customer'},{key:'phone',label:'Phone',html:r=>`<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>`},{key:'loan',label:'Loan'},
    {key:'overdue',label:'Overdue',html:r=>inr(r.overdue)},{key:'days',label:'Days late'},{key:'lateFee',label:'Late fee',html:r=>inr(r.lateFee)},{key:'total',label:'Total due',html:r=>inr(r.total)},{key:'note',label:'Last follow-up'}],rows,
    {sort:'days',dir:'desc',actions:r=>btn('note',r.id,'Add note')+btn('pay',r.id,'Collect')+btn('view',r.id,'Loan'),
     onAct:(a,id)=>{if(a==='pay')return payForm(id);if(a==='view')return loanView(id);
       modal(`<h2>Follow-up note</h2><form id="f"><label>Note (call result, promise date…)<textarea name="note" required></textarea></label><div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
       $('#cx').onclick=closeModal;$('#f').onsubmit=async e=>{e.preventDefault();await addDoc(collection(db,'followups'),{loanId:id,note:new FormData(e.target).get('note'),at:nowISO(),by:S.me.id,byName:S.me.name});closeModal();toast('Note saved')}}});
};

/* ---------- Reports ---------- */
let rep={type:'collection',from:today().slice(0,8)+'01',to:today(),cust:''};
pages.reports=el=>{
  const types=isAdmin()||isMgr()?[['collection','Collection list'],['employee','Employee-wise collection'],['monthly','Monthly summary'],['statement','Customer statement'],['outstanding','Outstanding by loan']]:[['collection','My collection']];
  if(!types.some(t=>t[0]===rep.type))rep.type='collection';
  el.innerHTML=`<h2>Reports</h2><div class="card"><div class="grid2"><label>Report<select id="rt">${types.map(t=>`<option value="${t[0]}" ${rep.type===t[0]?'selected':''}>${t[1]}</option>`).join('')}</select></label>
    <label>Customer (statement)<select id="rc"><option value="">—</option>${S.customers.map(c=>`<option value="${c.id}" ${rep.cust===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label>From<input type="date" id="rf" value="${rep.from}"></label><label>To<input type="date" id="rto" value="${rep.to}"></label></div>
    <div class="row"><button class="btn primary" id="go">Generate</button><button class="btn" id="ex">Export to Excel</button></div></div><div id="rep"></div>`;
  let cur=[];
  const gen=()=>{rep={type:$('#rt').value,from:$('#rf').value,to:$('#rto').value,cust:$('#rc').value};
    const inR=d=>d>=rep.from&&d<=rep.to;let pays=S.payments.filter(p=>inR(p.date));
    if(!isAdmin()&&!isMgr())pays=pays.filter(p=>p.receivedBy===S.me.id);
    let cols,rows;
    if(rep.type==='collection'){cols=[['date','Date'],['customerName','Customer'],['loan','Loan'],['amount','Amount'],['mode','Mode'],['receivedByName','Received by']];rows=pays.map(p=>({date:p.date,customerName:p.customerName,loan:code(p.loanId),amount:+p.amount,mode:p.mode,receivedByName:p.receivedByName}))}
    else if(rep.type==='employee'){const g={};pays.forEach(p=>{const x=g[p.receivedByName]??={employee:p.receivedByName,payments:0,total:0};x.payments++;x.total+=+p.amount});cols=[['employee','Employee'],['payments','Payments'],['total','Total collected']];rows=Object.values(g)}
    else if(rep.type==='monthly'){const g={};pays.forEach(p=>{const k=p.date.slice(0,7);(g[k]??={month:k,loansIssued:0,amountIssued:0,collected:0}).collected+=+p.amount});
      S.loans.filter(l=>l.status!=='Pending'&&l.status!=='Rejected'&&inR(l.startDate)).forEach(l=>{const k=l.startDate.slice(0,7);const x=g[k]??={month:k,loansIssued:0,amountIssued:0,collected:0};x.loansIssued++;x.amountIssued+=+l.amount});
      cols=[['month','Month'],['loansIssued','Loans issued'],['amountIssued','Amount issued'],['collected','Collected']];rows=Object.values(g)}
    else if(rep.type==='statement'){if(!rep.cust)return toast('Choose a customer',true);cols=[['loan','Loan'],['type','Type'],['status','Status'],['amount','Amount'],['payable','Total payable'],['paid','Paid'],['outstanding','Outstanding'],['overdue','Overdue']];
      rows=S.loans.filter(l=>l.customerId===rep.cust).map(l=>{const m=metrics(l);return{loan:code(l.id),type:l.loanType,status:l.status,amount:+l.amount,payable:m.total,paid:m.paid,outstanding:m.outstanding,overdue:m.overdue}})}
    else{cols=[['loan','Loan'],['customerName','Customer'],['status','Status'],['amount','Amount'],['paid','Paid'],['outstanding','Outstanding'],['overdue','Overdue']];
      rows=S.loans.filter(l=>['Approved','Active','Defaulted'].includes(l.status)).map(l=>{const m=metrics(l);return{loan:code(l.id),customerName:l.customerName,status:l.status,amount:+l.amount,paid:m.paid,outstanding:m.outstanding,overdue:m.overdue}})}
    cur=rows;const money=['amount','total','collected','amountIssued','payable','paid','outstanding','overdue'];
    const tot=rows.length&&cols.some(c=>money.includes(c[0]))?`<p><b>Totals:</b> ${cols.filter(c=>money.includes(c[0])).map(c=>`${c[1]} ${inr(sum(rows,r=>r[c[0]]))}`).join(' · ')}</p>`:'';
    $('#rep').innerHTML=tot+'<div id="rt2"></div>';
    mount($('#rt2'),'rep-'+rep.type,cols.map(c=>({key:c[0],label:c[1],html:money.includes(c[0])?r=>inr(r[c[0]]):undefined})),rows,{});};
  $('#go').onclick=gen;
  $('#ex').onclick=()=>{if(!cur.length)return toast('Generate a report first',true);xlsxSave(`report-${rep.type}-${today()}.xlsx`,{Report:cur})};
  gen();
};

/* ---------- Import / Export ---------- */
const norm=r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k.toLowerCase().replace(/[^a-z0-9]/g,''),String(v).trim()]));
pages.data=el=>{
  el.innerHTML=`<h2>${isAdmin()?'Import / Export':'Export'}</h2>
  <div class="card"><h3>Export (Excel)</h3><p class="muted">Download a backup copy of your records. Photos are not included.</p>
    <div class="row"><button class="btn" id="e1">Customers</button><button class="btn" id="e2">Loans</button><button class="btn" id="e3">Payments</button><button class="btn primary" id="e4">All (one workbook)</button></div></div>
  ${isAdmin()?`<div class="card" style="margin-top:14px"><h3>Import customers (Excel or CSV)</h3>
    <p class="muted">Columns: Name, Phone, CustomerType, IDType, IDNumber, Address, MapsLink, GuarantorName, GuarantorPhone, Notes. Name and Phone are required; customers whose phone already exists are skipped.</p>
    <div class="row"><button class="btn" id="tpl">Download template</button><input type="file" id="imp" accept=".xlsx,.xls,.csv" style="max-width:320px"></div><div id="prev"></div></div>`:''}`;
  const C=()=>S.customers.map(c=>({Name:c.name,Phone:c.phone,CustomerType:c.customerType,IDType:c.idType,IDNumber:c.idNumber,Address:c.address,MapsLink:c.mapsLink,Latitude:c.lat,Longitude:c.lng,GuarantorName:c.guarantorName,GuarantorPhone:c.guarantorPhone,Notes:c.notes,Added:(c.created||'').slice(0,10)}));
  const L=()=>S.loans.map(l=>{const m=metrics(l);return{Loan:code(l.id),Customer:l.customerName,Type:l.loanType,InterestType:l.interestType,Frequency:l.frequency,Amount:l.amount,RatePerYear:l.rate,Installments:l.installments,Installment:Math.round(m.emi*100)/100,StartDate:l.startDate,Status:l.status,Paid:m.paid,Outstanding:m.outstanding,CreatedBy:l.createdByName}});
  const P=()=>S.payments.map(p=>({Date:p.date,Customer:p.customerName,Loan:code(p.loanId),Amount:p.amount,Mode:p.mode,ReceivedBy:p.receivedByName,Note:p.note}));
  $('#e1').onclick=()=>{xlsxSave(`customers-${today()}.xlsx`,{Customers:C()});log('Exported customers')};
  $('#e2').onclick=()=>{xlsxSave(`loans-${today()}.xlsx`,{Loans:L()});log('Exported loans')};
  $('#e3').onclick=()=>{xlsxSave(`payments-${today()}.xlsx`,{Payments:P()});log('Exported payments')};
  $('#e4').onclick=()=>{xlsxSave(`loan-data-${today()}.xlsx`,{Customers:C(),Loans:L(),Payments:P()});log('Exported all data')};
  if(!isAdmin())return;
  $('#tpl').onclick=()=>xlsxSave('customer-import-template.xlsx',{Customers:[{Name:'Example Name',Phone:'9876543210',CustomerType:'Individual',IDType:'Aadhaar',IDNumber:'',Address:'Village, District',MapsLink:'',GuarantorName:'',GuarantorPhone:'',Notes:''}]});
  $('#imp').onchange=async e=>{const f=e.target.files[0];if(!f)return;
    try{const wb=XLSX.read(await f.arrayBuffer());const raw=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''}).map(norm);
      const seen=new Set(S.customers.map(c=>String(c.phone).replace(/\D/g,'')));const ok=[],rows=[];
      raw.forEach((r,i)=>{const ph=(r.phone||'').replace(/\D/g,'');let why='';
        if(!r.name)why='Missing name';else if(!ph)why='Missing phone';else if(seen.has(ph))why='Phone already exists';
        if(!why){seen.add(ph);ok.push(r)}rows.push({n:i+2,name:r.name,phone:r.phone,result:why||'OK'})});
      $('#prev').innerHTML=`<p><b>${ok.length}</b> valid, <b>${rows.length-ok.length}</b> will be skipped.</p><div id="pt"></div><div class="row"><button class="btn primary" id="go" ${ok.length?'':'disabled'}>Import ${ok.length} customers</button></div>`;
      mount($('#pt'),'imp',[{key:'n',label:'Row'},{key:'name',label:'Name'},{key:'phone',label:'Phone'},{key:'result',label:'Result'}],rows,{sort:'n'});
      $('#go').onclick=async()=>{$('#go').disabled=true;const st=S.settings;
        for(let i=0;i<ok.length;i+=400){const b=writeBatch(db);ok.slice(i,i+400).forEach(r=>b.set(doc(collection(db,'customers')),{name:r.name,phone:r.phone,customerType:names(st.customerTypes).find(t=>t.toLowerCase()===(r.customertype||'').toLowerCase())||st.customerTypes[0],idType:r.idtype||'',idNumber:r.idnumber||'',address:r.address||'',mapsLink:r.mapslink||'',lat:'',lng:'',guarantorName:r.guarantorname||'',guarantorPhone:r.guarantorphone||'',notes:r.notes||'',photo:'',created:nowISO(),createdBy:S.me.id,createdByName:S.me.name}));await b.commit()}
        log('Imported customers',ok.length+' rows from '+f.name);toast(ok.length+' customers imported');$('#prev').innerHTML='';e.target.value=''};
    }catch(err){toast('Could not read file: '+(err.code||err.message),true)}};
};

/* ---------- Users (Admin) ---------- */
pages.users=async el=>{
  el.innerHTML=`<h2>Users</h2><button class="btn primary" id="add">+ Add user</button><div id="t"><p class="muted">Loading…</p></div>`;
  const snap=await getDocs(collection(db,'users')),users=snap.docs.map(d=>({id:d.id,...d.data()}));
  if(S.page!=='users')return;
  mount($('#t'),'users',[{key:'name',label:'Name'},{key:'email',label:'Email'},{key:'role',label:'Role'},{key:'active',label:'Status',val:u=>u.active===false?'Disabled':'Active'}],users,
    {actions:u=>btn('edit',u.id,'Edit'),onAct:(a,id)=>{const u=users.find(x=>x.id===id);
      modal(`<h2>Edit user</h2><form id="f">${fld('Name','name',u.name,'required')}${sel('Role','role',['admin','manager','employee'],u.role)}${sel('Status','active',['Active','Disabled'],u.active===false?'Disabled':'Active')}<p class="muted">To reset a password, use Firebase console > Authentication.</p><div class="row"><button class="btn primary">Save</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
      $('#cx').onclick=closeModal;$('#f').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));
        if(id===S.me.id&&(d.active==='Disabled'||d.role!=='admin'))return toast('You cannot disable or demote yourself',true);
        await updateDoc(doc(db,'users',id),{name:d.name,role:d.role,active:d.active==='Active'});log('Edited user',`${u.email} → ${d.role}, ${d.active}`);closeModal();toast('Saved');pages.users($('#main'))}}});
  $('#add').onclick=()=>{modal(`<h2>Add user</h2><form id="f"><div class="grid2">${fld('Name *','name','','required')}${fld('Email *','email','','type="email" required')}
    ${fld('Password * (min 8 characters)','password','','type="password" minlength="8" required autocomplete="new-password"')}${sel('Role','role',['employee','manager','admin'])}</div>
    <div class="row"><button class="btn primary">Create user</button><button type="button" class="btn" id="cx">Cancel</button></div></form>`);
    $('#cx').onclick=closeModal;$('#f').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));
      const sec=initializeApp(firebaseConfig,'sec'+Date.now());
      try{const cred=await createUserWithEmailAndPassword(getAuth(sec),d.email.trim(),d.password);
        await setDoc(doc(db,'users',cred.user.uid),{name:d.name.trim(),email:d.email.trim(),role:d.role,active:true,created:nowISO()});
        log('Created user',`${d.email} (${d.role})`);closeModal();toast('User created');pages.users($('#main'))}
      catch(err){toast('Could not create user: '+err.code,true)}finally{try{await signOut(getAuth(sec))}catch{}deleteApp(sec)}}};
};

/* ---------- Settings (Admin) ---------- */
pages.settings=el=>{
  const st=S.settings;
  el.innerHTML=`<h2>Settings</h2><form id="f" class="card"><div class="grid2">${fld('Business name','businessName',st.businessName)}${fld('Manager approval limit (₹)','approvalLimit',st.approvalLimit,'type="number" min="0" step="any"')}
    ${fld('Late fee per missed installment (₹)','lateFee',st.lateFee,'type="number" min="0" step="any"')}</div>
    <p class="muted">Currency is ₹. Interest types: Flat, Reducing balance. Frequencies: Daily, Weekly, Monthly. Loans above the manager limit need Admin approval.</p>
    <div class="grid2"><label>Customer types (one per line)<textarea name="customerTypes" rows="5">${esc(st.customerTypes.join('\n'))}</textarea></label>
    <label>Loan types (one per line, optional default rate: Name=rate)<textarea name="loanTypes" rows="5">${esc(st.loanTypes.map(t=>t.rate!=null?`${t.name}=${t.rate}`:t.name).join('\n'))}</textarea></label>
    <label>Payment modes (one per line)<textarea name="paymentModes" rows="4">${esc(st.paymentModes.join('\n'))}</textarea></label>
    <label>ID proof types (one per line)<textarea name="idTypes" rows="4">${esc(st.idTypes.join('\n'))}</textarea></label></div>
    <button class="btn primary">Save settings</button></form>`;
  const lines=v=>String(v).split('\n').map(x=>x.trim()).filter(Boolean);
  $('#f').onsubmit=async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));
    const data={businessName:d.businessName||'Loan Manager',approvalLimit:+d.approvalLimit||0,lateFee:+d.lateFee||0,customerTypes:lines(d.customerTypes),paymentModes:lines(d.paymentModes),idTypes:lines(d.idTypes),
      loanTypes:lines(d.loanTypes).map(x=>{const [n,r]=x.split('=');return r!==undefined&&r.trim()!==''&&!isNaN(+r)?{name:n.trim(),rate:+r}:{name:n.trim()}})};
    if(!data.customerTypes.length||!data.loanTypes.length||!data.paymentModes.length||!data.idTypes.length)return toast('Each list needs at least one entry',true);
    try{await setDoc(doc(db,'settings','main'),data);log('Changed settings','approval limit '+inr(data.approvalLimit));toast('Settings saved')}catch(err){toast('Save failed: '+err.code,true)}};
};

/* ---------- Audit ---------- */
pages.audit=async el=>{
  el.innerHTML=`<h2>Audit log</h2><div id="t"><p class="muted">Loading latest 500 entries…</p></div>`;
  const snap=await getDocs(query(collection(db,'audit'),orderBy('at','desc'),limit(500)));if(S.page!=='audit')return;
  mount($('#t'),'audit',[{key:'at',label:'When',html:r=>esc(r.at.replace('T',' ').slice(0,19))},{key:'name',label:'User'},{key:'role',label:'Role'},{key:'action',label:'Action'},{key:'detail',label:'Details'}],snap.docs.map(d=>d.data()),{sort:'at',dir:'desc'});
};
