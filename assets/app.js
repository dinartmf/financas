'use strict';

/* ================== utilidades ================== */
const $ = s => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
const BRL = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const fmt = v => BRL.format(v||0);
const pct = (v,d=2) => (v||0).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d})+'%';
const esc = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2,'0');
const todayISO = () => { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const monthKey = iso => iso.slice(0,7);
const addMonths = (key,n) => { let [y,m]=key.split('-').map(Number); m+=n; y+=Math.floor((m-1)/12); m=((m-1)%12+12)%12+1; return `${y}-${pad(m)}`; };
const monthLabel = key => { const [y,m]=key.split('-').map(Number); const t=new Date(y,m-1,1).toLocaleDateString('pt-BR',{month:'long',year:'numeric'}); return t.charAt(0).toUpperCase()+t.slice(1); };
const monthShort = key => { const [y,m]=key.split('-').map(Number); return new Date(y,m-1,1).toLocaleDateString('pt-BR',{month:'short'}).replace('.','')+'/'+String(y).slice(2); };
const dateBR = iso => iso ? iso.split('-').reverse().join('/') : '—';
const parseNum = v => { if(typeof v==='number') return v; v=String(v||'').trim().replace(/[R$\s%]/g,''); if(v.includes(',')) v=v.replace(/\./g,'').replace(',','.'); const n=parseFloat(v); return isNaN(n)?0:n; };
const daysBetween = (a,b) => Math.round((new Date(b+'T12:00')-new Date(a+'T12:00'))/864e5);
const daysInMonth = key => { const [y,m]=key.split('-').map(Number); return new Date(y,m,0).getDate(); };
const toast = msg => { const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove('show'),2200); };

/* ================== estado & persistência (Supabase) ================== */
const DEFAULT = () => ({
  version:1,
  settings:{cdi:13.65, selic:13.75, ipca:4.6, view:'caixa'},
  categories:{
    out:['Alimentação','Mercado','Moradia','Contas (luz/água/internet)','Transporte','Saúde','Educação','Lazer','Assinaturas','Compras','Impostos','Outros'],
    in:['Salário','Freelance','Rendimentos','Reembolso','Outros']
  },
  cards:[], tx:[], invest:[], loans:[], paid:{}
});
let S = DEFAULT();
let versao = null;          // versão da linha no banco (controle de concorrência)
let saveTimer=null, saving=false, pending=false, conflict=false;

function sanitizeState(d){
  // Garante formato esperado mesmo se o JSON vier corrompido/adulterado
  const base = DEFAULT();
  if(!d || typeof d!=='object') return base;
  const arr = v => Array.isArray(v) ? v : [];
  const out = Object.assign(base, {
    settings: Object.assign(base.settings, d.settings && typeof d.settings==='object' ? d.settings : {}),
    categories: d.categories && Array.isArray(d.categories.out) && Array.isArray(d.categories.in) ? {out:d.categories.out.map(String), in:d.categories.in.map(String)} : base.categories,
    cards: arr(d.cards), tx: arr(d.tx), invest: arr(d.invest), loans: arr(d.loans).filter(l=>l && typeof l==='object' && l.id),
    paid: d.paid && typeof d.paid==='object' ? d.paid : {}
  });
  out.tx.forEach(t=>{ t.amount=Number(t.amount)||0; t.installments=Math.min(48,Math.max(1,Number(t.installments)||1)); t.date=String(t.date||'').slice(0,10); if(!isMonthKey(t.refMonth)) delete t.refMonth; });
  out.invest.forEach(i=>{ i.amount=Number(i.amount)||0; });
  out.cards.forEach(c=>{ c.closeDay=Math.min(31,Math.max(1,Number(c.closeDay)||1)); c.dueDay=Math.min(31,Math.max(1,Number(c.dueDay)||1)); });
  return out;
}

async function loadData(){
  const row = await SB.loadState();
  if(row){ S = sanitizeState(row.dados); versao = row.versao; }
  else { S = DEFAULT(); versao = null; }
  conflict=false; updateSaveState();
}
function save(){
  if(conflict){ updateSaveState(); return; }
  clearTimeout(saveTimer);
  updateSaveState('Alterações pendentes…');
  saveTimer = setTimeout(doSave, 600);
}
async function doSave(){
  if(saving){ pending=true; return; }
  saving=true; updateSaveState('Salvando…');
  try{
    const snapshot = JSON.parse(JSON.stringify(S));
    let r;
    if(versao==null){
      try{ r = await SB.insertState(snapshot); }
      catch(e){ if(e.status===409){ r=null; } else throw e; }
    } else {
      r = await SB.updateState(snapshot, versao);
    }
    if(!r){ conflict=true; showConflict(); }
    else { versao=r.versao; updateSaveState(); }
  }catch(e){
    console.warn(e);
    if(e.status===401 || e.status===403){ updateSaveState('Sessão expirada'); forceLogin('Sua sessão expirou. Entre novamente — suas últimas alterações podem não ter sido salvas.'); }
    else updateSaveState('Falha ao salvar — tentando de novo…'), setTimeout(save, 5000);
  }
  saving=false; if(pending && !conflict){ pending=false; doSave(); }
}
function showConflict(){
  updateSaveState('Conflito: dados alterados em outro dispositivo');
  openModal(`<h2>Dados alterados em outro lugar</h2><p>Seus dados foram salvos a partir de outro dispositivo ou aba depois que esta tela foi aberta. Para não sobrescrever nada, esta alteração não foi gravada.</p>
    <div class="actions"><button class="btn" data-m="keep">Sobrescrever com esta versão</button><button class="btn primary" data-m="ok">Recarregar dados mais recentes</button></div>`);
  modalActions({
    ok: async ()=>{ closeModal(); await loadData(); rerender(); toast('Dados atualizados'); },
    keep: async ()=>{ closeModal(); const mine=S; const row=await SB.loadState(); versao=row?row.versao:null; S=mine; conflict=false; doSave(); }
  });
}
function updateSaveState(msg){
  const el=$('#saveState'); if(!el) return;
  el.textContent = msg || (versao==null && !S.tx.length ? 'Pronto' : '● Salvo');
  el.title = SB.email();
}
window.addEventListener('beforeunload', e=>{ if(saveTimer && (saving||pending||$('#saveState')?.textContent.includes('pendentes'))){ e.preventDefault(); e.returnValue=''; } });

/* ================== autenticação ================== */
const IDLE_MIN = Number((window.APP_CONFIG||{}).IDLE_MINUTES) || 15;
let idleTimer=null, recoveryPending=false;
function resetIdle(){ clearTimeout(idleTimer); if(SB.session) idleTimer=setTimeout(async ()=>{ if(saveTimer) await doSave(); await SB.signOut(); forceLogin(`Sessão encerrada após ${IDLE_MIN} minutos sem uso.`); }, IDLE_MIN*60000); }
['mousedown','keydown','touchstart','scroll'].forEach(ev=>document.addEventListener(ev, resetIdle, {passive:true}));

function showAuth(html){
  $('#app').hidden = true; $('#auth').hidden = false;
  $('#auth').innerHTML = `<div class="auth-card"><div class="brand auth-brand">Finanças<small>CONTROLE PESSOAL</small></div>${html}</div>`;
  const i=$('#auth input'); if(i) i.focus();
}
function showApp(){
  $('#auth').hidden = true; $('#auth').innerHTML=''; $('#app').hidden = false;
  $('#userEmail').textContent = SB.email();
  resetIdle(); route();
}
function authError(e){
  const m = String(e && e.message || e);
  if(/invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
  if(/invalid totp|invalid.*code|mfa_verification_failed/i.test(m) || (e&&e.code==='mfa_verification_failed')) return 'Código inválido ou expirado. Confira o horário do celular e tente de novo.';
  if(/rate limit|too many/i.test(m) || (e&&e.status===429)) return 'Muitas tentativas. Aguarde alguns minutos.';
  if(/email not confirmed/i.test(m)) return 'E-mail ainda não confirmado. Verifique sua caixa de entrada.';
  if(/failed to fetch|networkerror/i.test(m)) return 'Sem conexão com o servidor.';
  return 'Não foi possível concluir: ' + m;
}
function forceLogin(msg){ clearTimeout(idleTimer); SB.clear(); S=DEFAULT(); versao=null; closeModal(); renderLogin(msg); }

function renderLogin(msg){
  showAuth(`
    <h1>Entrar</h1>
    ${msg?`<div class="auth-msg">${esc(msg)}</div>`:''}
    <form id="loginF" class="form auth-form" autocomplete="on">
      <label class="full">E-mail<input name="email" type="email" autocomplete="username" required maxlength="200"></label>
      <label class="full">Senha<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label>
      <div class="full auth-err" id="authErr" role="alert"></div>
      <button class="btn primary full" type="submit">Entrar</button>
    </form>
    <button class="linkbtn auth-link" id="forgot">Esqueci minha senha</button>`);
  $('#loginF').addEventListener('submit', async e=>{
    e.preventDefault(); const d=readForm(e.target); const b=e.target.querySelector('button'); b.disabled=true; $('#authErr').textContent='';
    try{ await SB.signIn(d.email.trim(), d.password); await afterLogin(); }
    catch(err){ $('#authErr').textContent=authError(err); b.disabled=false; }
  });
  $('#forgot').onclick=()=>{
    showAuth(`<h1>Recuperar senha</h1><p class="muted small">Enviaremos um link para o seu e-mail. Depois de abrir o link, você confirma o código do autenticador e define a nova senha.</p>
      <form id="recF" class="form auth-form"><label class="full">E-mail<input name="email" type="email" required maxlength="200"></label><div class="full auth-err" id="authErr" role="alert"></div><button class="btn primary full" type="submit">Enviar link</button></form>
      <button class="linkbtn auth-link" id="back">Voltar</button>`);
    $('#back').onclick=()=>renderLogin();
    $('#recF').addEventListener('submit', async e=>{ e.preventDefault(); const d=readForm(e.target);
      try{ await SB.recover(d.email.trim(), location.origin+location.pathname); } catch(err){ if(err.status===429) return $('#authErr').textContent=authError(err); }
      renderLogin('Se o e-mail estiver cadastrado, você receberá o link em instantes.'); });
  };
}

async function afterLogin(){
  const user = await SB.getUser();
  const verified = (user.factors||[]).filter(f=>f.factor_type==='totp' && f.status==='verified');
  if(SB.aal()!=='aal2'){
    if(verified.length) return renderMfaChallenge(verified[0].id);
    return renderMfaEnroll();
  }
  if(recoveryPending) return renderNewPassword();
  await loadData();
  showApp();
}
function codeInput(){ return `<label class="full">Código de 6 dígitos<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required class="code-input"></label>`; }
function renderMfaChallenge(factorId){
  showAuth(`<h1>Verificação em duas etapas</h1><p class="muted small">Abra seu app autenticador (Google Authenticator, Microsoft Authenticator, Authy…) e digite o código.</p>
    <form id="mfaF" class="form auth-form">${codeInput()}<div class="full auth-err" id="authErr" role="alert"></div><button class="btn primary full" type="submit">Confirmar</button></form>
    <button class="linkbtn auth-link" id="out">Usar outra conta</button>`);
  $('#out').onclick=async()=>{ await SB.signOut(); renderLogin(); };
  $('#mfaF').addEventListener('submit', async e=>{ e.preventDefault(); const b=e.target.querySelector('button'); b.disabled=true; $('#authErr').textContent='';
    try{ await SB.verifyTotp(factorId, readForm(e.target).code.trim()); await afterLogin(); }
    catch(err){ $('#authErr').textContent=authError(err); b.disabled=false; e.target.code.select(); } });
}
async function renderMfaEnroll(){
  showAuth(`<h1>Ative a verificação em duas etapas</h1><p class="muted small">Obrigatório para proteger seus dados financeiros. Carregando…</p>`);
  let f;
  try{ f = await SB.enrollTotp(); }
  catch(err){ return showAuth(`<h1>Erro</h1><div class="auth-err">${esc(authError(err))}</div><p class="small muted">Verifique se o MFA (TOTP) está habilitado no Supabase em Authentication → Multi-Factor.</p><button class="btn" id="out">Voltar</button>`), $('#out').onclick=async()=>{await SB.signOut(); renderLogin();}; }
  const qr = String(f.totp && f.totp.qr_code || '');
  const safeQr = /^data:image\/svg\+xml/.test(qr) ? qr : '';
  showAuth(`<h1>Ative a verificação em duas etapas</h1>
    <ol class="steps small"><li>Instale um app autenticador no celular (Google Authenticator, Microsoft Authenticator ou Authy).</li><li>Escaneie o QR code abaixo.</li><li>Digite o código de 6 dígitos que aparecer.</li></ol>
    ${safeQr?`<div class="qr"><img alt="QR code para o app autenticador" id="qrImg"></div>`:''}
    <details class="small"><summary>Não consigo escanear</summary><p>Digite esta chave no app: <code class="secret">${esc(f.totp && f.totp.secret || '')}</code></p></details>
    <form id="mfaF" class="form auth-form">${codeInput()}<div class="full auth-err" id="authErr" role="alert"></div><button class="btn primary full" type="submit">Ativar e entrar</button></form>`);
  if(safeQr) $('#qrImg').src = safeQr;
  $('#mfaF').addEventListener('submit', async e=>{ e.preventDefault(); const b=e.target.querySelector('button'); b.disabled=true; $('#authErr').textContent='';
    try{ await SB.verifyTotp(f.id, readForm(e.target).code.trim()); toast('Verificação em duas etapas ativada'); await afterLogin(); }
    catch(err){ $('#authErr').textContent=authError(err); b.disabled=false; } });
}
function passwordIssues(p){
  const issues=[]; if(p.length<12) issues.push('ter ao menos 12 caracteres'); if(!/[a-z]/.test(p)) issues.push('letra minúscula'); if(!/[A-Z]/.test(p)) issues.push('letra maiúscula'); if(!/[0-9]/.test(p)) issues.push('número'); if(!/[^A-Za-z0-9]/.test(p)) issues.push('símbolo');
  return issues;
}
function renderNewPassword(){
  showAuth(`<h1>Defina uma nova senha</h1><p class="muted small">Use ao menos 12 caracteres, com maiúsculas, minúsculas, números e símbolos.</p>
    <form id="pwF" class="form auth-form"><label class="full">Nova senha<input name="p1" type="password" autocomplete="new-password" required maxlength="200"></label><label class="full">Repita a senha<input name="p2" type="password" autocomplete="new-password" required maxlength="200"></label><div class="full auth-err" id="authErr" role="alert"></div><button class="btn primary full" type="submit">Salvar senha</button></form>`);
  $('#pwF').addEventListener('submit', async e=>{ e.preventDefault(); const d=readForm(e.target);
    const iss=passwordIssues(d.p1); if(iss.length) return $('#authErr').textContent='A senha precisa: '+iss.join(', ')+'.';
    if(d.p1!==d.p2) return $('#authErr').textContent='As senhas não conferem.';
    try{ await SB.updatePassword(d.p1); recoveryPending=false; toast('Senha alterada'); await afterLogin(); } catch(err){ $('#authErr').textContent=authError(err); } });
}

async function boot(){
  // Bloqueia a página se for carregada dentro de um iframe (clickjacking)
  if(window.top !== window.self){ document.body.innerHTML=''; try{ window.top.location = window.location.href; }catch(e){} return; }
  if(!SB.configured){
    return showAuth(`<h1>Configuração pendente</h1><p class="small">Preencha <code>config.js</code> com a URL do projeto Supabase e a chave pública (publishable/anon). Veja o README.</p>`);
  }
  recoveryPending = SB.takeRecoveryFromHash();
  if(!SB.session) return renderLogin();
  try{ await afterLogin(); }
  catch(e){ console.warn(e); forceLogin(e.status===401||e.status===403 ? 'Sua sessão expirou. Entre novamente.' : authError(e)); }
}

/* ================== regras de negócio ================== */
function cardById(id){ return S.cards.find(c=>c.id===id); }
// mês de vencimento da fatura em que cai uma compra
function invoiceMonth(card, iso){
  const day = Number(iso.slice(8,10));
  let closeKey = monthKey(iso);
  if(day >= card.closeDay) closeKey = addMonths(closeKey,1);
  return card.dueDay <= card.closeDay ? addMonths(closeKey,1) : closeKey;
}
// mês de referência (competência): informado no lançamento ou, se ausente, o mês da data
const isMonthKey = v => typeof v==='string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const refMonthOf = t => isMonthKey(t.refMonth) ? t.refMonth : monthKey(t.date);
// sugestão automática: salário recebido em um mês se refere ao mês anterior
const autoRefMonth = (type, category, date) => (type==='in' && /sal[aá]rio/i.test(category||'') && date) ? addMonths(monthKey(date),-1) : (date? monthKey(date) : monthKey(todayISO()));
// expande lançamentos (parcelas) em "entradas" mensais
function entries(){
  const out=[];
  for(const t of S.tx){
    const card = t.method==='credito' ? cardById(t.cardId) : null;
    const n = t.method==='credito' ? Math.max(1, t.installments||1) : 1;
    const base = Math.floor(t.amount/n*100)/100;
    const first = Math.round((t.amount - base*(n-1))*100)/100;
    const inv0 = card ? invoiceMonth(card, t.date) : null;
    for(let i=0;i<n;i++){
      const comp = addMonths(refMonthOf(t), i);
      out.push({
        tx:t, i:i+1, n, amount: i===0?first:base,
        compMonth: comp,
        cashMonth: card ? addMonths(inv0,i) : monthKey(t.date),
        invoice: card ? addMonths(inv0,i) : null,
        cardId: card ? card.id : null
      });
    }
  }
  out.push(...loanEntries());
  return out;
}
// formas de pagamento das despesas (ordem fixa = cor fixa)
const OUT_METHODS = ['pix','debito','credito','boleto'];
const METHOD_LABEL = {pix:'Pix', debito:'Débito', credito:'Crédito', boleto:'Boleto', outro:'Outro'};
const METHOD_COLOR = {pix:'var(--s3)', debito:'var(--s1)', credito:'var(--s2)', boleto:'var(--s4)'};
const monthOf = e => S.settings.view==='caixa' ? e.cashMonth : e.compMonth;
function invoiceTotal(cardId, key, all){ return (all||entries()).filter(e=>e.cardId===cardId && e.invoice===key).reduce((s,e)=>s+e.amount,0); }
function invoicePaid(cardId,key){ return !!(S.paid[cardId] && S.paid[cardId][key]); }
function dueDate(card,key){ const d=Math.min(card.dueDay, daysInMonth(key)); return `${key}-${pad(d)}`; }
function cardUsed(card, all){
  // limite comprometido = faturas ainda não pagas (atuais e futuras)
  const cur = monthKey(todayISO());
  return (all||entries()).filter(e=>e.cardId===card.id && !invoicePaid(card.id,e.invoice) && e.invoice>=addMonths(cur,-1)).reduce((s,e)=>s+e.amount,0);
}

/* ---------- investimentos ---------- */
const KINDS = ['CDB','LCI','LCA','LC','Tesouro Selic','Tesouro Prefixado','Tesouro IPCA+','Debênture','CRI','CRA','Poupança','Fundo DI','Fundo Multimercado','Ações','FII','ETF','Cripto','Previdência','Outro'];
const TAXFREE_DEFAULT = ['LCI','LCA','CRI','CRA','Poupança'];
const INDEXERS = {
  cdi:{label:'% do CDI', rateLabel:'Percentual do CDI', hint:'ex.: 108 para 108% do CDI'},
  cdi_mais:{label:'CDI + taxa', rateLabel:'Taxa adicional (% a.a.)', hint:'ex.: 1,5 para CDI + 1,5% a.a.'},
  selic:{label:'Selic + taxa', rateLabel:'Taxa adicional (% a.a.)', hint:'Tesouro Selic: normalmente 0 a 0,1'},
  pre:{label:'Prefixado', rateLabel:'Taxa (% a.a.)', hint:'ex.: 13,5'},
  ipca:{label:'IPCA + taxa', rateLabel:'Taxa real (% a.a.)', hint:'ex.: 6,8 para IPCA + 6,8%'},
  poupanca:{label:'Poupança', rateLabel:'—', hint:'0,5% a.m. (TR desconsiderada)'},
  variavel:{label:'Renda variável / manual', rateLabel:'—', hint:'informe o valor atual manualmente'}
};
const LIQ = {
  diaria:'Diária (D+0/D+1)', d30:'D+30', d90:'D+90', dx:'D+X (personalizado)', vencimento:'Só no vencimento'
};
function annualRate(inv){
  const r = parseNum(inv.rate)/100, cdi=S.settings.cdi/100, selic=S.settings.selic/100, ipca=S.settings.ipca/100;
  switch(inv.indexer){
    case 'cdi': return Math.pow((Math.pow(1+cdi,1/252)-1)*r + 1, 252) - 1;
    case 'cdi_mais': return (1+cdi)*(1+r)-1;
    case 'selic': return (1+selic-0.001)*(1+r)-1;
    case 'pre': return r;
    case 'ipca': return (1+ipca)*(1+r)-1;
    case 'poupanca': return Math.pow(1.005,12)-1;
    default: return 0;
  }
}
function rateText(inv){
  const r = parseNum(inv.rate);
  switch(inv.indexer){
    case 'cdi': return `${r.toLocaleString('pt-BR')}% do CDI`;
    case 'cdi_mais': return `CDI + ${pct(r)}`;
    case 'selic': return r? `Selic + ${pct(r)}` : 'Selic';
    case 'pre': return `${pct(r)} a.a.`;
    case 'ipca': return `IPCA + ${pct(r)}`;
    case 'poupanca': return 'Poupança';
    default: return 'Variável';
  }
}
function irRate(days){ return days<=180?22.5: days<=360?20: days<=720?17.5: 15; }
function valueAt(inv, iso){
  if(inv.indexer==='variavel') return parseNum(inv.current)||inv.amount;
  const days = Math.max(0, daysBetween(inv.date, iso));
  const bd = days*252/365;
  return inv.amount * Math.pow(1+annualRate(inv), bd/252);
}
function invSnapshot(inv){
  const today = todayISO();
  const ref = inv.maturity && inv.maturity < today ? inv.maturity : today;
  const gross = valueAt(inv, ref);
  const gain = gross - inv.amount;
  const days = Math.max(0, daysBetween(inv.date, ref));
  const tax = (inv.taxFree || gain<=0 || inv.indexer==='variavel') ? 0 : gain*irRate(days)/100;
  let atMat=null, atMatNet=null;
  if(inv.maturity && inv.indexer!=='variavel'){
    atMat = valueAt(inv, inv.maturity);
    const g = atMat-inv.amount, d=daysBetween(inv.date,inv.maturity);
    atMatNet = atMat - (inv.taxFree||g<=0 ? 0 : g*irRate(d)/100);
  }
  // dias até poder resgatar
  let wait = 0;
  if(inv.liquidity==='d30') wait=30; else if(inv.liquidity==='d90') wait=90;
  else if(inv.liquidity==='dx') wait=Number(inv.liqDays)||0;
  else if(inv.liquidity==='vencimento') wait = inv.maturity ? Math.max(0,daysBetween(today,inv.maturity)) : 9999;
  else if(inv.liquidity==='diaria') wait = Number(inv.liqDays)||0;
  return {gross, gain, tax, net:gross-tax, days, atMat, atMatNet, wait};
}
function liqBucket(wait){ return wait<=1?0 : wait<=30?1 : wait<=365?2 : 3; }
const BUCKETS = ['Imediata (até D+1)','Até 30 dias','Até 1 ano','Acima de 1 ano'];

/* ================== roteamento & render ================== */
let curMonth = monthKey(todayISO());
const VIEWS = {painel:renderPainel, lancamentos:renderLanc, cartoes:renderCartoes, financiamentos:renderFin, investimentos:renderInv, ajustes:renderAjustes};
function route(){
  const v = (location.hash||'#painel').slice(1);
  const view = VIEWS[v] ? v : 'painel';
  document.querySelectorAll('#nav a').forEach(a=>a.classList.toggle('on', a.dataset.v===view));
  VIEWS[view]();
}
window.addEventListener('hashchange', route);
function rerender(){ route(); }

function monthPicker(){
  return `<div class="month"><button class="iconbtn" data-act="mprev" aria-label="Mês anterior">‹</button><span>${monthLabel(curMonth)}</span><button class="iconbtn" data-act="mnext" aria-label="Próximo mês">›</button></div>`;
}
function viewToggle(){
  const v=S.settings.view;
  return `<div class="seg" title="Caixa: compras no crédito entram no mês de vencimento da fatura. Competência: entram no mês da compra (parcelas mês a mês)."><button data-act="view" data-v="caixa" class="${v==='caixa'?'on':''}">Caixa</button><button data-act="view" data-v="competencia" class="${v==='competencia'?'on':''}">Competência</button></div>`;
}

/* ---------- Painel ---------- */
function renderPainel(){
  const all = entries();
  const m = all.filter(e=>monthOf(e)===curMonth);
  const rec = m.filter(e=>e.tx.type==='in').reduce((s,e)=>s+e.amount,0);
  const des = m.filter(e=>e.tx.type==='out').reduce((s,e)=>s+e.amount,0);
  const saldo = rec-des;
  const invs = S.invest.filter(i=>!i.redeemed).map(i=>({i,s:invSnapshot(i)}));
  const invTot = invs.reduce((s,x)=>s+x.s.gross,0);
  const invApl = invs.reduce((s,x)=>s+x.i.amount,0);

  const byMethod = Object.fromEntries(OUT_METHODS.map(k=>[k,0]));
  m.filter(e=>e.tx.type==='out').forEach(e=>byMethod[e.tx.method]=(byMethod[e.tx.method]||0)+e.amount);
  const byCat = {};
  m.filter(e=>e.tx.type==='out').forEach(e=>byCat[e.tx.category]=(byCat[e.tx.category]||0)+e.amount);
  const cats = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const maxCat = cats.length? cats[0][1] : 1;

  // últimos 6 meses
  const months = Array.from({length:6},(_,k)=>addMonths(curMonth,k-5));
  const series = months.map(k=>{
    const mm = all.filter(e=>monthOf(e)===k);
    return {k, rec:mm.filter(e=>e.tx.type==='in').reduce((s,e)=>s+e.amount,0), des:mm.filter(e=>e.tx.type==='out').reduce((s,e)=>s+e.amount,0)};
  });

  const empty = !S.tx.length && !S.invest.length && !S.cards.length;

  $('#main').innerHTML = `
  <div class="top"><h1>Painel</h1>${viewToggle()}${monthPicker()}<button class="btn primary" data-act="newtx">+ Lançamento</button></div>
  ${empty?`<div class="card empty"><div style="font-size:15px;color:var(--ink);font-weight:600">Comece cadastrando seus cartões e lançamentos</div><div class="small">Ou carregue dados fictícios para testar todas as telas.</div><button class="btn" data-act="sample">Carregar dados de exemplo</button> <button class="btn primary" data-act="newcard">Cadastrar cartão</button></div><div style="height:16px"></div>`:''}
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Receitas</div><div class="value num pos">${fmt(rec)}</div><div class="sub">${(n=>n+(n===1?' lançamento':' lançamentos'))(m.filter(e=>e.tx.type==='in').length)}</div></div>
    <div class="card kpi"><div class="label">Despesas</div><div class="value num neg">${fmt(des)}</div><div class="sub">${S.settings.view==='caixa'?'crédito pela fatura':'crédito pela data da compra'}</div></div>
    <div class="card kpi"><div class="label">Saldo do mês</div><div class="value num ${saldo>=0?'pos':'neg'}">${fmt(saldo)}</div><div class="sub">${rec? pct(saldo/rec*100,0)+' da receita':'—'}</div></div>
    <div class="card kpi"><div class="label">Investido (estimado)</div><div class="value num">${fmt(invTot)}</div><div class="sub">${invApl? '+'+fmt(invTot-invApl)+' de rendimento bruto':'nenhuma aplicação'}</div></div>
  </div>
  <div style="height:16px"></div>
  <div class="grid two">
    <div class="card"><h3>Receitas × despesas <span class="right">últimos 6 meses</span></h3>${chart6(series)}</div>
    <div class="card"><h3>Despesas por forma de pagamento</h3>
      ${des? `<div class="stack">${OUT_METHODS.filter(k=>byMethod[k]>0).map(k=>`<div data-tip="${METHOD_LABEL[k]}: ${fmt(byMethod[k])}" style="width:${byMethod[k]/des*100}%;background:${METHOD_COLOR[k]}"></div>`).join('')}</div>
      <div class="legend">${OUT_METHODS.map(k=>`<span><i style="background:${METHOD_COLOR[k]}"></i>${METHOD_LABEL[k]} <b class="num">${fmt(byMethod[k])}</b></span>`).join('')}</div>`:'<div class="muted small">Sem despesas neste mês.</div>'}
      <h3 style="margin-top:22px">Faturas que vencem em ${monthShort(curMonth)}</h3>
      ${S.cards.length? `<table><tbody>${S.cards.map(c=>{const v=invoiceTotal(c.id,curMonth,all); const p=invoicePaid(c.id,curMonth); return `<tr><td>${esc(c.name)}<div class="small muted">vence ${dateBR(dueDate(c,curMonth))}</div></td><td class="r num">${fmt(v)}</td><td class="r">${v? `<span class="pill ${p?'ok':'open'}">${p?'Paga':'Aberta'}</span>`:''}</td></tr>`}).join('')}</tbody></table>` : '<div class="muted small">Nenhum cartão cadastrado. <button class="linkbtn" data-act="newcard">Cadastrar</button></div>'}
    </div>
  </div>
  <div style="height:16px"></div>
  <div class="grid two">
    <div class="card"><h3>Despesas por categoria <span class="right">${monthLabel(curMonth)}</span></h3>
      ${cats.length? `<div class="bars">${cats.map(([c,v])=>`<div class="row" data-tip="${esc(c)}: ${fmt(v)} (${pct(v/des*100,1)})"><div class="name">${esc(c)}</div><div class="track"><div class="fill" style="width:${v/maxCat*100}%"></div></div><div class="val num">${fmt(v)}</div></div>`).join('')}</div>`:'<div class="muted small">Sem despesas neste mês.</div>'}
    </div>
    <div class="card"><h3>Investimentos por liquidez</h3>${liqSummary(invs)}</div>
  </div>`;
}
function chart6(series){
  const W=560,H=220,pl=56,pr=8,pt=10,pb=26;
  const max = Math.max(1,...series.flatMap(s=>[s.rec,s.des]));
  const nice = niceMax(max);
  const gw=(W-pl-pr)/series.length, bw=Math.min(22,(gw-14)/2);
  const y=v=>pt+(H-pt-pb)*(1-v/nice);
  let g='';
  for(let k=0;k<=4;k++){ const v=nice*k/4; g+=`<line x1="${pl}" x2="${W-pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${pl-8}" y="${y(v)+4}" text-anchor="end" font-size="11" fill="var(--ink-3)">${compact(v)}</text>`; }
  series.forEach((s,i)=>{
    const cx=pl+gw*i+gw/2;
    [['rec',s.rec,'var(--s1)',-1],['des',s.des,'var(--s2)',1]].forEach(([n,v,c,dir])=>{
      const x = dir<0? cx-bw-1 : cx+1; const h=Math.max(0,y(0)-y(v));
      if(h>0) g+=`<path d="${barPath(x,y(v),bw,h)}" fill="${c}"/>`;
    });
    g+=`<rect x="${pl+gw*i}" y="${pt}" width="${gw}" height="${H-pt-pb}" fill="transparent" data-tip="${monthShort(s.k)} · Receitas ${fmt(s.rec)} · Despesas ${fmt(s.des)}"/>`;
    g+=`<text x="${cx}" y="${H-8}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${monthShort(s.k)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Receitas e despesas dos últimos seis meses">${g}</svg>
  <div class="legend"><span><i style="background:var(--s1)"></i>Receitas</span><span><i style="background:var(--s2)"></i>Despesas</span></div>`;
}
function barPath(x,y,w,h){ const r=Math.min(4,w/2,h); return `M${x},${y+h}V${y+r}Q${x},${y} ${x+r},${y}H${x+w-r}Q${x+w},${y} ${x+w},${y+r}V${y+h}Z`; }
function niceMax(v){ const p=Math.pow(10,Math.floor(Math.log10(v))); const n=v/p; return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*p; }
function compact(v){ return v>=1e6? (v/1e6).toLocaleString('pt-BR',{maximumFractionDigits:1})+' mi' : v>=1e3? (v/1e3).toLocaleString('pt-BR',{maximumFractionDigits:1})+' mil' : v.toLocaleString('pt-BR',{maximumFractionDigits:v<10?2:0}); }
function liqSummary(invs){
  if(!invs.length) return '<div class="muted small">Nenhum investimento cadastrado. <a class="linkbtn" href="#investimentos">Cadastrar</a></div>';
  const b=[0,0,0,0]; invs.forEach(x=>b[liqBucket(x.s.wait)]+=x.s.gross);
  const tot=b.reduce((a,c)=>a+c,0)||1; const max=Math.max(...b)||1;
  return `<div class="bars">${b.map((v,i)=>`<div class="row" data-tip="${BUCKETS[i]}: ${fmt(v)} (${pct(v/tot*100,1)})"><div class="name">${BUCKETS[i]}</div><div class="track"><div class="fill" style="width:${v/max*100}%"></div></div><div class="val num">${fmt(v)}</div></div>`).join('')}</div>
  <div class="small muted" style="margin-top:8px">Liquidez considera o prazo de resgate de cada aplicação (ou a data de vencimento).</div>`;
}

/* ---------- Lançamentos ---------- */
let F = {q:'',type:'',method:'',cat:'',card:''};
function renderLanc(){
  const all = entries();
  let list = all.filter(e=>monthOf(e)===curMonth);
  if(F.type) list=list.filter(e=>e.tx.type===F.type);
  if(F.method) list=list.filter(e=>e.tx.method===F.method);
  if(F.cat) list=list.filter(e=>e.tx.category===F.cat);
  if(F.card) list=list.filter(e=>e.cardId===F.card);
  if(F.q){ const q=F.q.toLowerCase(); list=list.filter(e=>(e.tx.desc+' '+e.tx.category+' '+(e.tx.notes||'')).toLowerCase().includes(q)); }
  list.sort((a,b)=> b.tx.date.localeCompare(a.tx.date));
  const rec=list.filter(e=>e.tx.type==='in').reduce((s,e)=>s+e.amount,0), des=list.filter(e=>e.tx.type==='out').reduce((s,e)=>s+e.amount,0);
  const allCats=[...new Set([...S.categories.out,...S.categories.in])];
  $('#main').innerHTML = `
  <div class="top"><h1>Lançamentos</h1>${viewToggle()}${monthPicker()}<button class="btn primary" data-act="newtx">+ Lançamento</button></div>
  <div class="filters">
    <input id="fq" placeholder="Buscar descrição…" value="${esc(F.q)}" style="flex:1;min-width:180px">
    <select id="ftype"><option value="">Receitas e despesas</option><option value="in" ${F.type==='in'?'selected':''}>Receitas</option><option value="out" ${F.type==='out'?'selected':''}>Despesas</option></select>
    <select id="fmethod"><option value="">Todas as formas</option>${[...OUT_METHODS,'outro'].map(k=>`<option value="${k}" ${F.method===k?'selected':''}>${METHOD_LABEL[k]}</option>`).join('')}</select>
    <select id="fcat"><option value="">Todas as categorias</option>${allCats.map(c=>`<option ${F.cat===c?'selected':''}>${esc(c)}</option>`).join('')}</select>
    ${S.cards.length?`<select id="fcard"><option value="">Todos os cartões</option>${S.cards.map(c=>`<option value="${c.id}" ${F.card===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`:''}
  </div>
  <div class="card" style="padding:6px 8px">
    ${list.length? `<div class="tablewrap"><table>
      <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th>Forma</th><th class="r">Valor</th><th></th></tr></thead>
      <tbody>${list.map(e=>{const t=e.tx; const c=e.cardId?cardById(e.cardId):null; return `<tr>
        <td class="num">${dateBR(t.date)}</td>
        <td><b style="font-weight:600">${esc(t.desc)}</b>${e.n>1?` <span class="pill">${e.i}/${e.n}</span>`:''}${isMonthKey(t.refMonth)&&t.refMonth!==monthKey(t.date)?` <span class="pill" title="Mês de referência (competência)">ref. ${monthShort(e.compMonth)}</span>`:''}${c?`<div class="small muted">${esc(c.name)} · fatura ${monthShort(e.invoice)}</div>`:''}${t.loanId?`<div class="small muted">Financiamento · lançado automaticamente${t.projected?' · valor estimado':''}</div>`:''}</td>
        <td>${esc(t.category)}</td>
        <td><span class="pill ${t.method}">${esc(METHOD_LABEL[t.method]||t.method)}</span></td>
        <td class="r num ${t.type==='in'?'pos':'neg'}" style="font-weight:600">${t.type==='in'?'+':'−'} ${fmt(e.amount)}</td>
        <td class="r">${t.loanId?`<button class="btn sm" data-act="selloan" data-id="${t.loanId}" data-go="1">Ver</button>`:`<button class="btn sm" data-act="edittx" data-id="${t.id}">Editar</button>`}</td></tr>`}).join('')}</tbody>
    </table></div>
    <div style="display:flex;gap:18px;justify-content:flex-end;padding:12px 10px;border-top:1px solid var(--line)" class="num"><span>Receitas <b class="pos">${fmt(rec)}</b></span><span>Despesas <b class="neg">${fmt(des)}</b></span><span>Saldo <b class="${rec-des>=0?'pos':'neg'}">${fmt(rec-des)}</b></span></div>`
    : `<div class="empty">Nenhum lançamento em ${monthLabel(curMonth)}${F.q||F.type||F.method||F.cat||F.card?' com esses filtros':''}.<br><button class="btn primary" data-act="newtx">+ Novo lançamento</button></div>`}
  </div>
  <p class="small muted">Na visão <b>Caixa</b>, compras no crédito aparecem no mês em que a fatura vence. Na visão <b>Competência</b>, cada lançamento conta no seu <b>mês de referência</b> — por exemplo, o salário recebido em 06/11 referente a outubro conta em outubro (parcelas no crédito seguem mês a mês a partir da referência).</p>`;
  const bind=(id,k)=>{ const el=$('#'+id); if(el) el.addEventListener(id==='fq'?'input':'change',ev=>{F[k]=ev.target.value; const pos=ev.target.selectionStart; renderLanc(); if(id==='fq'){const n=$('#fq'); n.focus(); n.setSelectionRange(pos,pos);} }); };
  bind('fq','q');bind('ftype','type');bind('fmethod','method');bind('fcat','cat');bind('fcard','card');
}

function txForm(t){
  const isNew=!t; t = t || {type:'out',desc:'',amount:'',date:todayISO(),category:'',method:'pix',cardId:S.cards[0]?.id||'',installments:1,notes:''};
  let type=t.type;
  // se o usuário escolher o mês manualmente, paramos de sugerir automaticamente
  let refTouched = !isNew && isMonthKey(t.refMonth) && t.refMonth!==autoRefMonth(t.type,t.category,t.date);
  const curRef = () => isMonthKey(t.refMonth) ? t.refMonth : autoRefMonth(type, t.category || S.categories[type][0], t.date);
  const refOptions = (date, sel) => { const base=monthKey(date||todayISO()); const ks=[]; for(let k=-12;k<=3;k++) ks.push(addMonths(base,k)); if(sel && !ks.includes(sel)) ks.push(sel); ks.sort(); return ks.map(k=>`<option value="${k}" ${k===sel?'selected':''}>${monthLabel(k)}</option>`).join(''); };
  const draw = () => {
    const cats = S.categories[type];
    const method = t.method; // não ler do DOM: o modal anterior pode ainda estar lá
    openModal(`
      <h2>${isNew?'Novo lançamento':'Editar lançamento'}</h2>
      <form class="form" id="txf">
        <div class="full typeseg"><button type="button" class="out ${type==='out'?'on':''}" data-type="out">Despesa</button><button type="button" class="in ${type==='in'?'on':''}" data-type="in">Receita</button></div>
        <label class="full">Descrição<input name="desc" required value="${esc(t.desc)}" placeholder="${type==='out'?'ex.: Supermercado, Netflix…':'ex.: Salário, Freela…'}"></label>
        <label>Valor ${method==='credito'?'<span class="hint">(total da compra)</span>':''}<input name="amount" required inputmode="decimal" value="${t.amount!==''?String(t.amount).replace('.',','):''}" placeholder="0,00"></label>
        <label>Data${method==='credito'?' da compra':''}<input name="date" type="date" required value="${t.date}"></label>
        <label>Categoria<select name="category">${cats.map(c=>`<option ${t.category===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
        <label>Forma<select name="method" id="t_method">${(type==='out'?[['pix','Pix'],['debito','Débito'],['credito','Cartão de crédito'],['boleto','Boleto']]:[['pix','Pix'],['outro','Outro (TED, dinheiro…)']]).map(([k,l])=>`<option value="${k}" ${method===k?'selected':''}>${l}</option>`).join('')}</select></label>
        ${method==='credito' && type==='out' ? (S.cards.length? `
          <label>Cartão<select name="cardId">${S.cards.map(c=>`<option value="${c.id}" ${t.cardId===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label>Parcelas<select name="installments">${Array.from({length:24},(_,i)=>i+1).map(n=>`<option value="${n}" ${Number(t.installments)===n?'selected':''}>${n===1?'À vista':n+'x'}</option>`).join('')}</select></label>
          <div class="full note" id="invHint"></div>` : `<div class="full note">Cadastre um cartão de crédito primeiro (aba Cartões).</div>`) : ''}
        <label>Mês de referência <span class="hint">competência</span><select name="refMonth" id="t_ref">${refOptions(t.date, curRef())}</select></label>
        <div class="small muted" id="refHint" style="align-self:end;padding-bottom:10px"></div>
        <label class="full">Observação <span class="hint">opcional</span><input name="notes" value="${esc(t.notes||'')}"></label>
      </form>
      <div class="actions">${!isNew?`<button class="btn danger left" data-m="del">Excluir</button>`:''}<button class="btn" data-m="cancel">Cancelar</button><button class="btn primary" data-m="ok">${isNew?'Adicionar':'Salvar'}</button></div>`);
    const f=$('#txf');
    f.querySelectorAll('[data-type]').forEach(b=>b.onclick=()=>{ t={...t,...readForm(f)}; type=b.dataset.type; t.category=''; if(!refTouched) t.refMonth=autoRefMonth(type,S.categories[type][0],t.date); if(type==='in'&&t.method!=='pix') t.method='pix'; draw(); });
    $('#t_method').onchange=()=>{ t={...t,...readForm(f)}; t.method=$('#t_method').value; draw(); };
    const hint=()=>{ const h=$('#invHint'); if(!h) return; const d=readForm(f); const c=cardById(d.cardId); if(!c||!d.date) return; const inv=invoiceMonth(c,d.date); const n=Number(d.installments)||1; const a=parseNum(d.amount); h.innerHTML=`Entra na fatura de <b>${monthLabel(inv)}</b> (vence ${dateBR(dueDate(c,inv))})${n>1?` · ${n}x de <b>${fmt(a/n)}</b> até ${monthShort(addMonths(inv,n-1))}`:''}.`; };
    f.addEventListener('input',hint); f.addEventListener('change',hint); hint();
    const refHint=()=>{ const d=readForm(f); const el=$('#refHint'); if(!el||!d.date) return; el.textContent = d.refMonth && d.refMonth!==monthKey(d.date) ? `Conta em ${monthShort(d.refMonth)} na visão Competência e em ${monthShort(monthKey(d.date))} na visão Caixa.` : ''; };
    $('#t_ref').addEventListener('change',()=>{ refTouched=true; t.refMonth=$('#t_ref').value; refHint(); });
    const autoUpdate=()=>{ const d=readForm(f); if(refTouched) { const sel=$('#t_ref').value; $('#t_ref').innerHTML=refOptions(d.date, sel); } else { const a=autoRefMonth(type,d.category,d.date); t.refMonth=a; $('#t_ref').innerHTML=refOptions(d.date, a); } refHint(); };
    f.date.addEventListener('change',autoUpdate); f.category.addEventListener('change',autoUpdate); refHint();
    modalActions({
      ok:()=>{ const d=readForm(f); if(!d.desc.trim()) return toast('Informe a descrição'); const amt=parseNum(d.amount); if(!(amt>0)) return toast('Informe um valor maior que zero');
        const rec={...t, type, desc:d.desc.trim(), amount:Math.round(amt*100)/100, date:d.date, category:d.category, method:d.method, notes:d.notes};
        if(isMonthKey(d.refMonth) && d.refMonth!==monthKey(d.date)) rec.refMonth=d.refMonth; else delete rec.refMonth;
        if(d.method==='credito'){ if(!S.cards.length) return toast('Cadastre um cartão primeiro'); rec.cardId=d.cardId; rec.installments=Number(d.installments)||1; } else { delete rec.cardId; rec.installments=1; }
        if(isNew){ rec.id=uid(); S.tx.push(rec); } else { const i=S.tx.findIndex(x=>x.id===t.id); S.tx[i]=rec; }
        save(); closeModal(); rerender(); toast(isNew?'Lançamento adicionado':'Lançamento atualizado'); },
      del:()=>confirmBox(`Excluir "${esc(t.desc)}"${t.installments>1?` e todas as ${t.installments} parcelas`:''}?`,()=>{ S.tx=S.tx.filter(x=>x.id!==t.id); save(); rerender(); toast('Excluído'); })
    });
  };
  draw();
}

/* ---------- Cartões ---------- */
let selCard=null;
function renderCartoes(){
  const all=entries();
  if(selCard && !cardById(selCard)) selCard=null;
  if(!selCard && S.cards.length) selCard=S.cards[0].id;
  const c = selCard? cardById(selCard):null;
  const cur = monthKey(todayISO());
  const months = c? Array.from({length:8},(_,k)=>addMonths(cur,k-2)) : [];
  const items = c? all.filter(e=>e.cardId===c.id && e.invoice===curMonth).sort((a,b)=>a.tx.date.localeCompare(b.tx.date)) : [];
  const invTot = items.reduce((s,e)=>s+e.amount,0);
  $('#main').innerHTML = `
  <div class="top"><h1>Cartões de crédito</h1><button class="btn primary" data-act="newcard">+ Cartão</button></div>
  ${S.cards.length? `<div class="grid cards-grid">${S.cards.map(k=>{const used=cardUsed(k,all); const lim=k.limit||0; return `
    <div class="cardtile" style="background:${k.color||'linear-gradient(135deg,#263238,#11181c)'};cursor:pointer;outline:${k.id===selCard?'3px solid var(--accent)':'none'};outline-offset:2px" data-act="selcard" data-id="${k.id}">
      <div class="acts"><button data-act="editcard" data-id="${k.id}">Editar</button></div>
      <div class="nm">${esc(k.name)}</div><div class="meta">Fecha dia ${k.closeDay} · vence dia ${k.dueDay}</div>
      <div class="lim num">Comprometido ${fmt(used)}${lim?` de ${fmt(lim)}`:''}${lim?`<div class="ubar"><div style="width:${Math.min(100,used/lim*100)}%"></div></div>`:''}</div>
    </div>`}).join('')}</div>
  <div style="height:16px"></div>
  <div class="grid two">
    <div class="card">
      <h3>Fatura ${esc(c.name)} — ${monthLabel(curMonth)} <span class="right">${monthPicker()}</span></h3>
      <div style="display:flex;align-items:baseline;gap:12px;margin:4px 0 12px;flex-wrap:wrap"><div class="num" style="font-size:24px;font-weight:700">${fmt(invTot)}</div><div class="muted">vence ${dateBR(dueDate(c,curMonth))}</div>
        ${invTot?`<span class="pill ${invoicePaid(c.id,curMonth)?'ok':'open'}">${invoicePaid(c.id,curMonth)?'Paga':'Aberta'}</span><button class="btn sm" data-act="togglepaid" data-id="${c.id}" data-m="${curMonth}" style="margin-left:auto">${invoicePaid(c.id,curMonth)?'Marcar como aberta':'Marcar como paga'}</button>`:''}</div>
      ${items.length? `<div class="tablewrap"><table><thead><tr><th>Compra</th><th>Descrição</th><th>Categoria</th><th class="r">Valor</th></tr></thead><tbody>${items.map(e=>`<tr><td class="num">${dateBR(e.tx.date)}</td><td>${esc(e.tx.desc)} ${e.n>1?`<span class="pill">${e.i}/${e.n}</span>`:''}</td><td>${esc(e.tx.category)}</td><td class="r num">${fmt(e.amount)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="muted small">Nenhuma compra nesta fatura.</div>'}
    </div>
    <div class="card"><h3>Próximas faturas</h3>
      <table><thead><tr><th>Vencimento</th><th class="r">Valor</th><th class="r">Status</th></tr></thead><tbody>
      ${months.map(k=>{const v=invoiceTotal(c.id,k,all); const p=invoicePaid(c.id,k); return `<tr style="cursor:pointer" data-act="gomonth" data-m="${k}"><td>${dateBR(dueDate(c,k))}${k===curMonth?' <span class="pill">vendo</span>':''}</td><td class="r num">${fmt(v)}</td><td class="r">${v?`<span class="pill ${p?'ok':'open'}">${p?'Paga':(k<cur?'Atrasada?':'Aberta')}</span>`:'<span class="muted small">—</span>'}</td></tr>`}).join('')}
      </tbody></table>
      <p class="small muted">Parcelas futuras já aparecem nas faturas seguintes. "Comprometido" soma faturas ainda não pagas.</p>
    </div>
  </div>` : `<div class="card empty">Nenhum cartão cadastrado.<br><button class="btn primary" data-act="newcard">Cadastrar cartão</button></div>`}`;
}
const CARD_COLORS = ['linear-gradient(135deg,#263238,#11181c)','linear-gradient(135deg,#8a05be,#4b0082)','linear-gradient(135deg,#ec7000,#b34f00)','linear-gradient(135deg,#cc092f,#7d0019)','linear-gradient(135deg,#0f6e5c,#073d33)','linear-gradient(135deg,#1e4fa3,#0d2a5c)','linear-gradient(135deg,#6b6b6b,#2c2c2c)'];
function cardForm(c){
  const isNew=!c; c=c||{name:'',limit:'',closeDay:1,dueDay:10,color:CARD_COLORS[0]};
  let color=c.color;
  openModal(`<h2>${isNew?'Novo cartão':'Editar cartão'}</h2>
    <form class="form" id="cf">
      <label class="full">Nome<input name="name" required value="${esc(c.name)}" placeholder="ex.: Nubank, Itaú Visa…"></label>
      <label>Limite <span class="hint">opcional</span><input name="limit" inputmode="decimal" value="${c.limit?String(c.limit).replace('.',','):''}" placeholder="0,00"></label>
      <div></div>
      <label>Dia de fechamento<input name="closeDay" type="number" min="1" max="31" required value="${c.closeDay}"><span class="hint">Compras a partir deste dia vão para a fatura seguinte</span></label>
      <label>Dia de vencimento<input name="dueDay" type="number" min="1" max="31" required value="${c.dueDay}"></label>
      <div class="full"><div style="font-size:12px;font-weight:600;color:var(--ink-2);margin-bottom:6px">Cor</div><div style="display:flex;gap:8px" id="colors">${CARD_COLORS.map(g=>`<button type="button" data-c="${g}" style="width:32px;height:22px;border-radius:6px;border:2px solid ${g===color?'var(--ink)':'transparent'};background:${g};cursor:pointer"></button>`).join('')}</div></div>
    </form>
    <div class="actions">${!isNew?`<button class="btn danger left" data-m="del">Excluir</button>`:''}<button class="btn" data-m="cancel">Cancelar</button><button class="btn primary" data-m="ok">Salvar</button></div>`);
  $('#colors').querySelectorAll('button').forEach(b=>b.onclick=()=>{ color=b.dataset.c; $('#colors').querySelectorAll('button').forEach(x=>x.style.borderColor=x.dataset.c===color?'var(--ink)':'transparent'); });
  modalActions({
    ok:()=>{ const d=readForm($('#cf')); if(!d.name.trim()) return toast('Informe o nome');
      const cd=Math.min(31,Math.max(1,parseInt(d.closeDay)||1)), dd=Math.min(31,Math.max(1,parseInt(d.dueDay)||1));
      const rec={...c,name:d.name.trim(),limit:parseNum(d.limit),closeDay:cd,dueDay:dd,color};
      if(isNew){ rec.id=uid(); S.cards.push(rec); selCard=rec.id; } else { S.cards[S.cards.findIndex(x=>x.id===c.id)]=rec; }
      save(); closeModal(); rerender(); },
    del:()=>{ const n=S.tx.filter(t=>t.cardId===c.id).length; confirmBox(`Excluir o cartão "${esc(c.name)}"?${n?` As ${n} compras dele também serão excluídas.`:''}`,()=>{ S.tx=S.tx.filter(t=>t.cardId!==c.id); S.cards=S.cards.filter(x=>x.id!==c.id); delete S.paid[c.id]; save(); rerender(); }); }
  });
}

/* ---------- Financiamentos ---------- */
// Dois modos:
//  fixed    → parcela fixa (veicular/Price): valor × quantidade a partir da 1ª data
//  schedule → tabela importada do PDF do banco (SAC/decrescente), atualizável após amortizações
const LOAN_KINDS = {veicular:'Veicular', imobiliario:'Imobiliário', pessoal:'Pessoal / consignado', outro:'Outro'};
const LOAN_METHODS = ['boleto','debito','pix'];
function isoAddMonths(iso, n){ let [y,m,d]=iso.split('-').map(Number); m+=n; y+=Math.floor((m-1)/12); m=((m-1)%12+12)%12+1; return `${y}-${pad(m)}-${pad(Math.min(d,new Date(y,m,0).getDate()))}`; }
function loanRows(l){
  if(l.mode==='fixed'){
    const n=Math.max(1,Math.min(600,Number(l.count)||1)), out=[];
    for(let i=0;i<n;i++) out.push({n:i+1, due:isoAddMonths(l.firstDate,i), amount:Number(l.amount)||0});
    return out;
  }
  return Array.isArray(l.rows) ? l.rows : [];
}
const loanTotal = l => l.mode==='fixed' ? Number(l.count)||0 : (l.contract && l.contract.totalCount) || loanRows(l).length;
function loanSummary(l, rows){
  rows = rows || loanRows(l);
  const today=todayISO(), cur=monthKey(today);
  const paid = rows.filter(r=> l.mode==='fixed' ? r.due < today : !!r.paidAt);
  const future = rows.filter(r=> !(l.mode==='fixed' ? r.due < today : !!r.paidAt) && monthKey(r.due) >= cur);
  const next = future[0] || null;
  const lastPaid = paid[paid.length-1] || null;
  const saldo = l.mode==='fixed' ? future.reduce((a,r)=>a+r.amount,0) : (lastPaid && lastPaid.saldo!=null ? lastPaid.saldo : (l.contract && l.contract.financed) || 0);
  return { paidCount: paid.length, remaining: future.length, next, saldo,
    futureTotal: future.reduce((a,r)=>a+r.amount,0), end: rows.length ? rows[rows.length-1].due : null,
    projected: rows.filter(r=>r.projected).length };
}
function loanEntries(){
  const out=[];
  for(const l of (S.loans||[])){
    const total=loanTotal(l);
    for(const r of loanRows(l)){
      if(monthKey(r.due) < (l.startMonth||'0000-00')) continue;
      const tx={id:`loan:${l.id}:${r.n}`, loanId:l.id, type:'out', desc:`${l.name} — parcela ${r.n}/${total}`, amount:r.amount, date:r.paidAt||r.due, category:l.category, method:l.method, projected:!!r.projected};
      out.push({tx, i:1, n:1, amount:r.amount, compMonth:monthKey(r.due), cashMonth:monthKey(r.paidAt||r.due), invoice:null, cardId:null, loan:l, row:r});
    }
  }
  return out;
}
let selLoan=null;
function renderFin(){
  const loans=S.loans||[];
  if(selLoan && !loans.find(l=>l.id===selLoan)) selLoan=null;
  if(!selLoan && loans.length) selLoan=loans[0].id;
  const sums=loans.map(l=>({l,s:loanSummary(l)}));
  const saldoTot=sums.reduce((a,x)=>a+x.s.saldo,0), futTot=sums.reduce((a,x)=>a+x.s.futureTotal,0);
  const monthTot=loanEntries().filter(e=>monthOf(e)===curMonth).reduce((a,e)=>a+e.amount,0);
  const l=loans.find(x=>x.id===selLoan), s=l?loanSummary(l):null;
  const rows=l?loanRows(l):[];
  const cur=monthKey(todayISO());
  const upcoming=rows.filter(r=>monthKey(r.due)>=addMonths(cur,-1)).slice(0,14);
  $('#main').innerHTML=`
  <div class="top"><h1>Financiamentos</h1>${monthPicker()}<button class="btn primary" data-act="newloan">+ Financiamento</button></div>
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Saldo devedor</div><div class="value num">${fmt(saldoTot)}</div><div class="sub">${loans.length} financiamento${loans.length===1?'':'s'}</div></div>
    <div class="card kpi"><div class="label">Parcelas em ${monthShort(curMonth)}</div><div class="value num neg">${fmt(monthTot)}</div><div class="sub">já incluídas nas despesas</div></div>
    <div class="card kpi"><div class="label">Total a pagar</div><div class="value num">${fmt(futTot)}</div><div class="sub">soma das parcelas restantes</div></div>
    <div class="card kpi"><div class="label">Juros futuros</div><div class="value num">${fmt(Math.max(0,futTot-sums.filter(x=>x.l.mode!=='fixed').reduce((a,x)=>a+x.s.saldo,0)-sums.filter(x=>x.l.mode==='fixed').reduce((a,x)=>a+x.s.futureTotal,0)))}</div><div class="sub">inclui seguros e taxas (financ. com PDF)</div></div>
  </div>
  <div style="height:16px"></div>
  ${loans.length? `<div class="grid cards-grid">${sums.map(({l:x,s:y})=>{const tot=loanTotal(x); const pct2=tot?y.paidCount/tot*100:0; return `
    <div class="card loan-card ${x.id===selLoan?'on':''}" data-act="selloan" data-id="${x.id}">
      <div class="small muted">${esc(LOAN_KINDS[x.kind]||x.kind)}${x.lender?' · '+esc(x.lender):''}</div>
      <div style="font-weight:700;font-size:15px;margin:2px 0 8px">${esc(x.name)}</div>
      <div class="track"><div class="fill" style="width:${pct2}%"></div></div>
      <div class="small muted" style="margin-top:6px">${y.paidCount} de ${tot} parcelas pagas</div>
      <div style="display:flex;justify-content:space-between;margin-top:10px" class="num"><span class="small muted">Próxima</span><b>${y.next?fmt(y.next.amount)+' · '+dateBR(y.next.due):'—'}</b></div>
    </div>`}).join('')}</div>
  <div style="height:16px"></div>
  <div class="grid fin-detail">
    <div class="card"><h3>${esc(l.name)} <span class="right"><button class="btn sm" data-act="editloan" data-id="${l.id}">Editar</button> ${l.mode==='schedule'?`<button class="btn sm primary" data-act="updloan" data-id="${l.id}">Atualizar com novo PDF</button>`:''}</span></h3>
      <div class="tablewrap"><table class="compact"><thead><tr><th>Vencimento</th><th>Parcela</th><th class="r">Valor</th>${l.mode==='schedule'?'<th class="r">Amortização</th><th class="r">Juros</th><th class="r">Saldo após</th>':''}<th class="r">Status</th></tr></thead><tbody>
      ${upcoming.map(r=>{const st=r.paidAt?'<span class="pill ok">Paga</span>':(l.mode==='fixed'&&r.due<todayISO()?'<span class="pill">Venceu</span>':r.projected?'<span class="pill" title="O PDF não trazia esta parcela; valor estimado pela regra SAC">Estimada</span>':'<span class="pill open">A vencer</span>'); return `<tr><td class="num">${dateBR(r.due)}</td><td class="num">${r.n}/${loanTotal(l)}</td><td class="r num"><b>${fmt(r.amount)}</b></td>${l.mode==='schedule'?`<td class="r num">${fmt(r.amort)}</td><td class="r num">${fmt(r.juros)}</td><td class="r num">${fmt(r.saldo)}</td>`:''}<td class="r">${st}</td></tr>`}).join('')}
      </tbody></table></div>
      <p class="small muted">Mostrando as próximas parcelas. Elas entram automaticamente nos lançamentos a partir de <b>${monthLabel(l.startMonth||cur)}</b>, na categoria <b>${esc(l.category)}</b>, pago por <b>${esc(METHOD_LABEL[l.method]||l.method)}</b>.</p>
    </div>
    <div class="card"><h3>Resumo</h3>
      <table><tbody>
        <tr><td class="muted">${l.mode==='fixed'?'Total restante':'Saldo devedor'}</td><td class="r num"><b>${fmt(s.saldo)}</b></td></tr>
        <tr><td class="muted">Parcelas restantes</td><td class="r num">${s.remaining}</td></tr>
        <tr><td class="muted">Total ainda a pagar</td><td class="r num">${fmt(s.futureTotal)}</td></tr>
        <tr><td class="muted">Última parcela</td><td class="r num">${dateBR(s.end)}</td></tr>
        ${l.contract?`<tr><td class="muted">Plano / taxa</td><td class="r">${esc(l.contract.plan||'—')} · ${l.contract.rate!=null?pct(l.contract.rate)+' a.a.':'—'}${l.contract.index?' + '+esc(l.contract.index):''}</td></tr>
        <tr><td class="muted">Valor financiado</td><td class="r num">${fmt(l.contract.financed)}</td></tr>
        <tr><td class="muted">Extrato importado</td><td class="r">${dateBR(l.contract.issuedAt||l.importedAt)}</td></tr>`:''}
      </tbody></table>
      ${s.projected?`<div class="note" style="margin-top:12px">O PDF trazia parcelas até a ${l.contract.lastN}ª. As ${s.projected} restantes foram <b>estimadas</b> pela regra do SAC (amortização constante + juros sobre o saldo, seguro igual à última parcela). Quando você subir um extrato mais completo, elas são substituídas pelos valores do banco.</div>`:''}
      ${(l.versions||[]).length?`<h3 style="margin-top:18px">Histórico de atualizações</h3><table><thead><tr><th>Data</th><th class="r">Saldo</th><th class="r">Restantes</th><th class="r">Economia</th></tr></thead><tbody>${l.versions.slice().reverse().map(v=>`<tr><td class="num">${dateBR(v.at)}</td><td class="r num">${fmt(v.saldoAfter)}</td><td class="r num">${v.remainingBefore} → ${v.remainingAfter}</td><td class="r num pos">${fmt(v.savings)}</td></tr>`).join('')}</tbody></table>`:''}
    </div>
  </div>` : `<div class="card empty">Nenhum financiamento cadastrado.<br><span class="small">Veicular: informe a parcela e a quantidade. Imobiliário: suba o PDF de evolução do saldo devedor do banco.</span><br><button class="btn primary" data-act="newloan">+ Financiamento</button></div>`}
  <p class="small muted">O PDF é lido no seu navegador e não é enviado a nenhum servidor. Só guardamos a tabela de parcelas e os números do contrato — nome, CPF e endereço são descartados.</p>`;
}

function pdfPreview(p, title){
  const rows=p.rows, c=p.contract, tmp={mode:'schedule', rows, contract:c}; const s=loanSummary(tmp, rows);
  return `<div class="note" style="margin-top:4px"><b>${esc(title||'PDF lido com sucesso')}</b><br>
    ${esc(c.bank||'Banco')} · plano ${esc(c.plan||'—')} · ${c.rate!=null?pct(c.rate)+' a.a.':''}${c.index?' + '+esc(c.index):''} · financiado ${fmt(c.financed)}<br>
    ${rows.length - s.projected} parcelas no PDF (${s.paidCount} pagas)${s.projected?`, ${s.projected} estimadas pela regra SAC`:''} · total ${c.totalCount}<br>
    Saldo devedor: <b>${fmt(s.saldo)}</b> · Próxima: <b>${s.next?fmt(s.next.amount)+' em '+dateBR(s.next.due):'—'}</b></div>`;
}
function compactRows(rows){ return rows.map(r=>{ const o={n:r.n,due:r.due,amount:r.amount,juros:r.juros,amort:r.amort,saldo:r.saldo,seguro:r.seguro,taxa:r.taxa}; if(r.paidAt) o.paidAt=r.paidAt; if(r.projected) o.projected=true; return o; }); }

function loanForm(l){
  const isNew=!l;
  l = l || {kind:'veicular', name:'', lender:'', category:'', method:'boleto', mode:'fixed', amount:'', count:'', firstDate:todayISO(), startMonth:monthKey(todayISO()), notes:''};
  let parsed=null;
  const catDefault = k => { const out=S.categories.out; const want = k==='imobiliario'?'Moradia':k==='veicular'?'Transporte':'Outros'; return out.includes(want)?want:out[0]; };
  const draw=()=>{
    const cat = l.category || catDefault(l.kind);
    const first = l.mode==='fixed' ? (l.firstDate||todayISO()) : (parsed? parsed.rows[0].due : (l.rows&&l.rows[0]?l.rows[0].due:todayISO()));
    const months=[]; { const a=monthKey(first), b=addMonths(monthKey(todayISO()),2); for(let k=a;k<=b;k=addMonths(k,1)) months.push(k); if(l.startMonth && !months.includes(l.startMonth)) months.push(l.startMonth); months.sort(); }
    openModal(`<h2>${isNew?'Novo financiamento':'Editar financiamento'}</h2>
    <form class="form" id="lf">
      <label>Tipo<select name="kind" id="l_kind">${Object.entries(LOAN_KINDS).map(([k,v])=>`<option value="${k}" ${l.kind===k?'selected':''}>${v}</option>`).join('')}</select></label>
      <label>Banco / credor<input name="lender" value="${esc(l.lender)}" placeholder="ex.: BRB, Banco Toyota"></label>
      <label class="full">Nome<input name="name" value="${esc(l.name)}" placeholder="${l.kind==='imobiliario'?'ex.: Apartamento':'ex.: Carro'}"></label>
      ${isNew?`<div class="full"><div class="typeseg"><button type="button" class="${l.mode==='fixed'?'on in':''}" data-mode="fixed">Parcela fixa</button><button type="button" class="${l.mode==='schedule'?'on in':''}" data-mode="schedule">Importar PDF do banco</button></div></div>`:''}
      ${l.mode==='fixed' ? `
        <label>Valor da parcela<input name="amount" inputmode="decimal" value="${l.amount!==''?String(l.amount).replace('.',','):''}" placeholder="0,00"></label>
        <label>Quantidade de parcelas<input name="count" type="number" min="1" max="600" value="${esc(l.count)}" placeholder="ex.: 48"></label>
        <label>Vencimento da 1ª parcela<input name="firstDate" type="date" value="${esc(l.firstDate)}"><span class="hint">as demais vencem no mesmo dia dos meses seguintes</span></label>
        <div class="small muted" id="fixedHint" style="align-self:end;padding-bottom:10px"></div>`
      : (isNew ? `<label class="full">PDF de evolução do saldo devedor<input type="file" id="l_pdf" accept="application/pdf,.pdf"><span class="hint">lido aqui no seu navegador — o arquivo não é enviado</span></label><div class="full" id="pdfOut">${parsed?pdfPreview(parsed):''}</div>` : `<div class="full note">Tabela importada do PDF em ${dateBR(l.contract&&l.contract.issuedAt||l.importedAt)}. Para atualizar após uma amortização, use <b>Atualizar com novo PDF</b>.</div>`)}
      <label>Categoria<select name="category">${S.categories.out.map(c=>`<option ${cat===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Forma de pagamento<select name="method">${LOAN_METHODS.map(k=>`<option value="${k}" ${l.method===k?'selected':''}>${METHOD_LABEL[k]}</option>`).join('')}</select></label>
      <label class="full">Lançar nas despesas a partir de<select name="startMonth">${months.map(k=>`<option value="${k}" ${(l.startMonth||monthKey(todayISO()))===k?'selected':''}>${monthLabel(k)}</option>`).join('')}</select><span class="hint">Meses anteriores não recebem as parcelas — evita duplicar o que você já lançou à mão. Se já lançou a parcela deste mês, exclua-a ou escolha o próximo mês.</span></label>
      <label class="full">Observação <span class="hint">opcional</span><input name="notes" value="${esc(l.notes||'')}"></label>
    </form>
    <div class="actions">${!isNew?`<button class="btn danger left" data-m="del">Excluir</button>`:''}<button class="btn" data-m="cancel">Cancelar</button><button class="btn primary" data-m="ok">Salvar</button></div>`);
    const f=$('#lf');
    const keep=()=>{ Object.assign(l, readForm(f)); };
    $('#l_kind').onchange=()=>{ const prevDefault=catDefault(l.kind); keep(); if(l.category===prevDefault) l.category=catDefault(l.kind); if(isNew && l.kind==='imobiliario' && l.mode==='fixed' && !l.amount) l.mode='schedule'; draw(); };
    f.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{ keep(); l.mode=b.dataset.mode; draw(); });
    const fh=()=>{ const el=$('#fixedHint'); if(!el) return; const d=readForm(f); const n=parseInt(d.count)||0, v=parseNum(d.amount); el.textContent = n&&v&&d.firstDate ? `Última parcela em ${dateBR(isoAddMonths(d.firstDate,n-1))} · total ${fmt(n*v)}` : ''; };
    if($('#fixedHint')){ f.addEventListener('input',fh); fh(); }
    const pdf=$('#l_pdf');
    if(pdf) pdf.onchange=async()=>{ const file=pdf.files[0]; if(!file) return; $('#pdfOut').innerHTML='<div class="small muted">Lendo o PDF…</div>';
      try{ parsed=await LoanImport.fromFile(file); keep();
        if(!l.lender && parsed.contract.bank) l.lender=parsed.contract.bank;
        if(!l.name) l.name = l.kind==='imobiliario' ? 'Financiamento imobiliário' : 'Financiamento';
        draw(); }
      catch(e){ console.warn(e); parsed=null; $('#pdfOut').innerHTML=`<div class="auth-err">${esc(e.message||'Não foi possível ler o PDF.')}</div>`; } };
    modalActions({
      ok:()=>{ keep();
        if(!String(l.name||'').trim()) return toast('Dê um nome ao financiamento');
        const rec={id:l.id||uid(), kind:l.kind, name:l.name.trim(), lender:(l.lender||'').trim(), category:l.category, method:l.method, mode:l.mode, startMonth:l.startMonth, notes:l.notes||'', versions:l.versions||[]};
        if(l.mode==='fixed'){
          const v=parseNum(l.amount), n=parseInt(l.count);
          if(!(v>0)) return toast('Informe o valor da parcela'); if(!(n>0&&n<=600)) return toast('Informe a quantidade de parcelas (1 a 600)'); if(!l.firstDate) return toast('Informe o vencimento da 1ª parcela');
          Object.assign(rec,{amount:Math.round(v*100)/100, count:n, firstDate:l.firstDate});
        } else {
          if(isNew){ if(!parsed) return toast('Selecione o PDF do banco'); rec.rows=compactRows(parsed.rows); rec.contract=parsed.contract; rec.importedAt=todayISO(); }
          else { rec.rows=l.rows; rec.contract=l.contract; rec.importedAt=l.importedAt; }
        }
        S.loans=S.loans||[];
        if(isNew) S.loans.push(rec); else S.loans[S.loans.findIndex(x=>x.id===rec.id)]=rec;
        selLoan=rec.id; save(); closeModal(); location.hash='financiamentos'; rerender(); toast('Financiamento salvo'); },
      del:()=>confirmBox(`Excluir "${esc(l.name)}"? As parcelas deixam de aparecer nos lançamentos.`,()=>{ S.loans=S.loans.filter(x=>x.id!==l.id); save(); rerender(); toast('Financiamento excluído'); })
    });
  };
  draw();
}

function loanUpdateForm(l){
  let parsed=null;
  const draw=()=>{
    let cmp='';
    if(parsed){
      const before=loanSummary(l), after=loanSummary({mode:'schedule', rows:parsed.rows, contract:parsed.contract}, parsed.rows);
      const savings=before.futureTotal-after.futureTotal;
      const saldoDrop = before.saldo - after.saldo;
      const mismatch = l.contract && l.contract.contract && parsed.contract.contract && l.contract.contract!==parsed.contract.contract;
      cmp=`${mismatch?`<div class="auth-err" style="margin-bottom:8px">Atenção: o número do contrato deste PDF é diferente do financiamento cadastrado.</div>`:''}
      <table><thead><tr><th></th><th class="r">Antes</th><th class="r">Depois</th></tr></thead><tbody>
        <tr><td class="muted">Saldo devedor</td><td class="r num">${fmt(before.saldo)}</td><td class="r num"><b>${fmt(after.saldo)}</b></td></tr>
        <tr><td class="muted">Parcelas restantes</td><td class="r num">${before.remaining}</td><td class="r num"><b>${after.remaining}</b></td></tr>
        <tr><td class="muted">Próxima parcela</td><td class="r num">${before.next?fmt(before.next.amount):'—'}</td><td class="r num"><b>${after.next?fmt(after.next.amount):'—'}</b></td></tr>
        <tr><td class="muted">Última parcela</td><td class="r num">${dateBR(before.end)}</td><td class="r num"><b>${dateBR(after.end)}</b></td></tr>
        <tr><td class="muted">Total ainda a pagar</td><td class="r num">${fmt(before.futureTotal)}</td><td class="r num"><b>${fmt(after.futureTotal)}</b></td></tr>
      </tbody></table>
      <div class="note" style="margin-top:10px">${savings>0?`Economia estimada: <b class="pos">${fmt(savings)}</b> a menos em parcelas futuras.`:'Sem redução no total das parcelas futuras.'}${after.projected?` · ${after.projected} parcelas finais estimadas (o PDF não as trazia).`:''}</div>
      <div class="form" style="margin-top:12px">
        <div class="full small" style="font-weight:600;color:var(--ink-2)">Registrar o valor amortizado como despesa? <span class="hint" style="font-weight:400">opcional — deixe em branco se já lançou</span></div>
        <label>Valor amortizado<input id="am_val" inputmode="decimal" placeholder="${saldoDrop>0?String(saldoDrop.toFixed(2)).replace('.',','):'0,00'}"></label>
        <label>Data<input id="am_date" type="date" value="${todayISO()}"></label>
        <label>Forma<select id="am_method">${['pix','debito','boleto'].map(k=>`<option value="${k}">${METHOD_LABEL[k]}</option>`).join('')}</select></label>
      </div>`;
    }
    openModal(`<h2>Atualizar ${esc(l.name)}</h2>
      <p class="small muted" style="margin-top:0">Suba o novo PDF de evolução do saldo devedor (por exemplo, depois de uma amortização). As parcelas futuras serão substituídas pelas novas.</p>
      <label class="form" style="display:block"><input type="file" id="u_pdf" accept="application/pdf,.pdf"></label>
      <div id="u_out" style="margin-top:12px">${parsed?pdfPreview(parsed,'Novo PDF lido')+'<div style="height:10px"></div>'+cmp:''}</div>
      <div class="actions"><button class="btn" data-m="cancel">Cancelar</button><button class="btn primary" data-m="ok" ${parsed?'':'disabled'}>Aplicar atualização</button></div>`);
    $('#u_pdf').onchange=async()=>{ const file=$('#u_pdf').files[0]; if(!file) return; $('#u_out').innerHTML='<div class="small muted">Lendo o PDF…</div>';
      try{ parsed=await LoanImport.fromFile(file); draw(); } catch(e){ parsed=null; $('#u_out').innerHTML=`<div class="auth-err">${esc(e.message||'Não foi possível ler o PDF.')}</div>`; } };
    modalActions({ ok:()=>{
      if(!parsed) return;
      const before=loanSummary(l), after=loanSummary({mode:'schedule', rows:parsed.rows, contract:parsed.contract}, parsed.rows);
      const amVal=parseNum($('#am_val')?.value), amDate=$('#am_date')?.value||todayISO(), amMethod=$('#am_method')?.value||'pix';
      l.versions=l.versions||[];
      l.versions.push({at:todayISO(), saldoBefore:before.saldo, saldoAfter:after.saldo, remainingBefore:before.remaining, remainingAfter:after.remaining, futureBefore:before.futureTotal, futureAfter:after.futureTotal, savings:Math.round((before.futureTotal-after.futureTotal)*100)/100, amortized:amVal||null});
      if(l.versions.length>30) l.versions=l.versions.slice(-30);
      l.rows=compactRows(parsed.rows); l.contract=parsed.contract; l.importedAt=todayISO();
      if(amVal>0) S.tx.push({id:uid(), type:'out', desc:`Amortização — ${l.name}`, amount:Math.round(amVal*100)/100, date:amDate, category:l.category, method:amMethod, notes:'Amortização extraordinária'});
      save(); closeModal(); rerender(); toast('Financiamento atualizado'); } });
  };
  draw();
}

/* ---------- Investimentos ---------- */
let invTab='ativos';
function renderInv(){
  const act = S.invest.filter(i=>invTab==='ativos'? !i.redeemed : i.redeemed).map(i=>({i,s:invSnapshot(i)}));
  const actAll = S.invest.filter(i=>!i.redeemed).map(i=>({i,s:invSnapshot(i)}));
  const apl=actAll.reduce((a,x)=>a+x.i.amount,0), gross=actAll.reduce((a,x)=>a+x.s.gross,0), net=actAll.reduce((a,x)=>a+x.s.net,0);
  const imed=actAll.filter(x=>x.s.wait<=1).reduce((a,x)=>a+x.s.net,0);
  const byKind={}; actAll.forEach(x=>byKind[x.i.kind]=(byKind[x.i.kind]||0)+x.s.gross);
  const byInst={}; actAll.forEach(x=>byInst[x.i.institution||'—']=(byInst[x.i.institution||'—']||0)+x.s.gross);
  const kinds=Object.entries(byKind).sort((a,b)=>b[1]-a[1]), insts=Object.entries(byInst).sort((a,b)=>b[1]-a[1]);
  const mk=(arr)=>{ if(!arr.length) return '<div class="muted small">—</div>'; const max=arr[0][1]||1; return `<div class="bars">${arr.map(([k,v])=>`<div class="row" data-tip="${esc(k)}: ${fmt(v)} (${pct(v/(gross||1)*100,1)})"><div class="name">${esc(k)}</div><div class="track"><div class="fill" style="width:${v/max*100}%"></div></div><div class="val num">${pct(v/(gross||1)*100,1)}</div></div>`).join('')}</div>`; };
  act.sort((a,b)=>a.s.wait-b.s.wait);
  $('#main').innerHTML = `
  <div class="top"><h1>Investimentos</h1><button class="btn primary" data-act="newinv">+ Aplicação</button></div>
  <div class="grid kpis">
    <div class="card kpi"><div class="label">Total aplicado</div><div class="value num">${fmt(apl)}</div><div class="sub">${actAll.length} aplicações ativas</div></div>
    <div class="card kpi"><div class="label">Valor bruto estimado</div><div class="value num">${fmt(gross)}</div><div class="sub pos">${apl?'+'+fmt(gross-apl)+' ('+pct((gross/apl-1)*100)+')':'—'}</div></div>
    <div class="card kpi"><div class="label">Líquido estimado</div><div class="value num">${fmt(net)}</div><div class="sub">após IR regressivo</div></div>
    <div class="card kpi"><div class="label">Liquidez imediata</div><div class="value num">${fmt(imed)}</div><div class="sub">resgatável em até D+1 (líquido)</div></div>
  </div>
  <div style="height:16px"></div>
  <div class="card" style="padding:6px 8px">
    <div style="display:flex;align-items:center;gap:10px;padding:8px 10px"><div class="seg"><button data-act="invtab" data-v="ativos" class="${invTab==='ativos'?'on':''}">Ativos</button><button data-act="invtab" data-v="resgatados" class="${invTab==='resgatados'?'on':''}">Resgatados</button></div>
    <span class="small muted" style="margin-left:auto">CDI ${pct(S.settings.cdi)} · Selic ${pct(S.settings.selic)} · IPCA ${pct(S.settings.ipca)} <a class="linkbtn" href="#ajustes">ajustar</a></span></div>
    ${act.length? `<div class="tablewrap"><table>
      <thead><tr><th>Aplicação</th><th>Rentabilidade</th><th>Liquidez</th><th>Aplicação / Venc.</th><th class="r">Aplicado</th><th class="r">Hoje (bruto)</th><th class="r">Hoje (líq.)</th><th class="r">No venc. (líq.)</th><th></th></tr></thead>
      <tbody>${act.map(({i,s})=>`<tr>
        <td><b style="font-weight:600">${esc(i.name||i.kind)}</b><div class="small muted">${esc(i.kind)} · ${esc(i.institution||'—')}${i.taxFree?' · isento IR':''}</div></td>
        <td><b style="font-weight:600">${rateText(i)}</b>${i.indexer!=='variavel'?`<div class="small muted">≈ ${pct(annualRate(i)*100)} a.a.</div>`:''}</td>
        <td>${liqText(i)}<div class="small muted">${s.wait<=1?'disponível':s.wait>=9999?'—':'em '+s.wait+' dias'}</div></td>
        <td class="num">${dateBR(i.date)}<div class="small muted">${i.maturity?dateBR(i.maturity):'sem vencimento'}</div></td>
        <td class="r num">${fmt(i.amount)}</td>
        <td class="r num">${fmt(s.gross)}<div class="small pos">+${fmt(s.gain)}</div></td>
        <td class="r num">${fmt(s.net)}${s.tax?`<div class="small muted">IR ${pct(irRate(s.days),1)}</div>`:''}</td>
        <td class="r num">${s.atMatNet!=null?fmt(s.atMatNet):'—'}</td>
        <td class="r"><button class="btn sm" data-act="editinv" data-id="${i.id}">Editar</button></td></tr>`).join('')}</tbody>
    </table></div>` : `<div class="empty">${invTab==='ativos'?'Nenhuma aplicação ativa.':'Nenhuma aplicação resgatada.'}${invTab==='ativos'?'<br><button class="btn primary" data-act="newinv">+ Nova aplicação</button>':''}</div>`}
  </div>
  <div style="height:16px"></div>
  <div class="grid three">
    <div class="card"><h3>Por liquidez</h3>${liqSummary(actAll)}</div>
    <div class="card"><h3>Por tipo</h3>${mk(kinds)}</div>
    <div class="card"><h3>Por instituição</h3>${mk(insts)}</div>
  </div>
  <div style="height:16px"></div>
  <div class="card"><h3>Comparador: CDB tributado × LCI/LCA isenta</h3>
    <div class="calc">
      <label>CDB paga (% do CDI)<input id="c_cdb" value="108" inputmode="decimal"></label>
      <label>LCI/LCA paga (% do CDI)<input id="c_lci" value="92" inputmode="decimal"></label>
      <label>Prazo<select id="c_days"><option value="180">até 180 dias (IR 22,5%)</option><option value="360">181–360 dias (IR 20%)</option><option value="720" selected>361–720 dias (IR 17,5%)</option><option value="721">acima de 720 dias (IR 15%)</option></select></label>
    </div>
    <div class="calc-out" id="calcOut"></div>
  </div>
  <p class="small muted">Valores estimados com as taxas de Ajustes (CDI, Selic e IPCA constantes), dias úteis aproximados por 252/365 e IR regressivo sobre o rendimento. IOF (resgates com menos de 30 dias), taxas de custódia e marcação a mercado não são considerados.</p>`;
  const calc=()=>{ const cdb=parseNum($('#c_cdb').value), lci=parseNum($('#c_lci').value), d=Number($('#c_days').value); const ir=irRate(d)/100;
    const eqIsento = cdb*(1-ir), eqCdb = lci/(1-ir); const better = eqIsento>lci ? 'CDB' : eqIsento<lci ? 'LCI/LCA' : 'empate';
    $('#calcOut').innerHTML = `CDB de ${cdb.toLocaleString('pt-BR')}% do CDI equivale a <b>${eqIsento.toLocaleString('pt-BR',{maximumFractionDigits:1})}% do CDI</b> líquido. A LCI/LCA de ${lci.toLocaleString('pt-BR')}% equivale a um CDB de <b>${eqCdb.toLocaleString('pt-BR',{maximumFractionDigits:1})}% do CDI</b>. Nesse prazo, rende mais: <b>${better}</b>.`; };
  ['c_cdb','c_lci','c_days'].forEach(id=>$('#'+id).addEventListener('input',calc)); calc();
}
function liqText(i){ if(i.liquidity==='dx') return 'D+'+(i.liqDays||0); if(i.liquidity==='diaria') return 'Diária'+(Number(i.liqDays)?' (D+'+i.liqDays+')':''); return LIQ[i.liquidity]||'—'; }
function invForm(inv){
  const isNew=!inv; inv=inv||{name:'',institution:'',kind:'CDB',indexer:'cdi',rate:'100',amount:'',date:todayISO(),maturity:'',liquidity:'diaria',liqDays:'',taxFree:false,current:'',notes:'',redeemed:false};
  const draw=()=>{
    const ix=INDEXERS[inv.indexer];
    openModal(`<h2>${isNew?'Nova aplicação':'Editar aplicação'}</h2>
    <form class="form" id="inf">
      <label>Tipo<select name="kind" id="i_kind">${KINDS.map(k=>`<option ${inv.kind===k?'selected':''}>${k}</option>`).join('')}</select></label>
      <label>Instituição<input name="institution" value="${esc(inv.institution)}" placeholder="ex.: Banco Inter, XP, Nubank"></label>
      <label class="full">Nome / apelido <span class="hint">opcional</span><input name="name" value="${esc(inv.name)}" placeholder="ex.: CDB Liquidez Diária, Reserva de emergência"></label>
      <label>Indexador<select name="indexer" id="i_ix">${Object.entries(INDEXERS).map(([k,v])=>`<option value="${k}" ${inv.indexer===k?'selected':''}>${v.label}</option>`).join('')}</select></label>
      ${['poupanca','variavel'].includes(inv.indexer)?'<div></div>':`<label>${ix.rateLabel}<input name="rate" inputmode="decimal" value="${esc(String(inv.rate).replace('.',','))}"><span class="hint">${ix.hint}</span></label>`}
      <label>Valor aplicado<input name="amount" inputmode="decimal" required value="${inv.amount!==''?String(inv.amount).replace('.',','):''}" placeholder="0,00"></label>
      <label>Data da aplicação<input name="date" type="date" required value="${inv.date}"></label>
      ${inv.indexer==='variavel'?`<label class="full">Valor atual <span class="hint">atualize manualmente</span><input name="current" inputmode="decimal" value="${inv.current?String(inv.current).replace('.',','):''}" placeholder="0,00"></label>`:''}
      <label>Liquidez<select name="liquidity" id="i_liq">${Object.entries(LIQ).map(([k,v])=>`<option value="${k}" ${inv.liquidity===k?'selected':''}>${v}</option>`).join('')}</select></label>
      ${inv.liquidity==='dx'?`<label>Dias para resgate (D+)<input name="liqDays" type="number" min="0" value="${esc(inv.liqDays)}"></label>`:'<div></div>'}
      <label>Vencimento <span class="hint">opcional</span><input name="maturity" type="date" value="${inv.maturity||''}"></label>
      <label style="flex-direction:row;align-items:center;gap:8px;margin-top:22px"><input type="checkbox" name="taxFree" ${inv.taxFree?'checked':''} style="width:16px;height:16px"> Isento de IR</label>
      <label class="full">Observação <span class="hint">opcional</span><input name="notes" value="${esc(inv.notes||'')}"></label>
      ${!isNew?`<label class="full" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" name="redeemed" ${inv.redeemed?'checked':''} style="width:16px;height:16px"> Já resgatado (sai do total ativo)</label>`:''}
    </form>
    <div class="actions">${!isNew?`<button class="btn danger left" data-m="del">Excluir</button>`:''}<button class="btn" data-m="cancel">Cancelar</button><button class="btn primary" data-m="ok">Salvar</button></div>`);
    const f=$('#inf');
    $('#i_ix').onchange=()=>{ inv={...inv,...readForm(f)}; if(inv.indexer==='selic'&&!parseNum(inv.rate)) inv.rate='0'; draw(); };
    $('#i_liq').onchange=()=>{ inv={...inv,...readForm(f)}; draw(); };
    $('#i_kind').onchange=()=>{ const k=$('#i_kind').value; f.taxFree.checked=TAXFREE_DEFAULT.includes(k);
      const ixs={'Tesouro Selic':'selic','Tesouro Prefixado':'pre','Tesouro IPCA+':'ipca','Poupança':'poupanca','Ações':'variavel','FII':'variavel','ETF':'variavel','Cripto':'variavel','Fundo Multimercado':'variavel'};
      if(ixs[k] && f.indexer.value!==ixs[k]){ inv={...inv,...readForm(f),kind:k,indexer:ixs[k]}; if(ixs[k]==='poupanca') inv.liquidity='diaria'; draw(); } };
    modalActions({
      ok:()=>{ const d=readForm(f); const amt=parseNum(d.amount); if(!(amt>0)) return toast('Informe o valor aplicado');
        const rec={...inv,...d,amount:Math.round(amt*100)/100,rate:parseNum(d.rate??inv.rate),current:parseNum(d.current),taxFree:!!d.taxFree,redeemed:!!d.redeemed};
        if(isNew){ rec.id=uid(); S.invest.push(rec);} else S.invest[S.invest.findIndex(x=>x.id===inv.id)]=rec;
        save(); closeModal(); rerender(); toast('Aplicação salva'); },
      del:()=>confirmBox(`Excluir "${esc(inv.name||inv.kind)}"?`,()=>{ S.invest=S.invest.filter(x=>x.id!==inv.id); save(); rerender(); })
    });
  };
  draw();
}

/* ---------- Ajustes ---------- */
function renderAjustes(){
  $('#main').innerHTML = `
  <div class="top"><h1>Ajustes</h1></div>
  <div class="grid two">
    <div class="card"><h3>Indicadores usados nas projeções</h3>
      <form class="form" id="sf">
        <label>CDI (% a.a.)<input name="cdi" inputmode="decimal" value="${String(S.settings.cdi).replace('.',',')}"></label>
        <label>Selic (% a.a.)<input name="selic" inputmode="decimal" value="${String(S.settings.selic).replace('.',',')}"></label>
        <label>IPCA projetado (% a.a.)<input name="ipca" inputmode="decimal" value="${String(S.settings.ipca).replace('.',',')}"></label>
      </form>
      <div class="note" style="margin-top:12px">Atualize quando o Copom mudar a Selic. O CDI costuma ficar ~0,10 p.p. abaixo da meta Selic.</div>
      <div style="margin-top:12px"><button class="btn primary" data-act="savesettings">Salvar indicadores</button></div>
    </div>
    <div class="card"><h3>Categorias</h3>
      <form class="form" id="catf">
        <label class="full">Despesas <span class="hint">uma por linha</span><textarea name="out" rows="7">${esc(S.categories.out.join('\n'))}</textarea></label>
        <label class="full">Receitas <span class="hint">uma por linha</span><textarea name="in" rows="4">${esc(S.categories.in.join('\n'))}</textarea></label>
      </form>
      <div style="margin-top:12px"><button class="btn primary" data-act="savecats">Salvar categorias</button></div>
    </div>
  </div>
  <div style="height:16px"></div>
  <div class="card" id="secCard"></div>
  <div style="height:16px"></div>
  <div class="card"><h3>Dados</h3>
    <p class="small muted" style="margin-top:0">Seus dados ficam no seu banco Supabase, protegidos por login com verificação em duas etapas e regras de acesso por usuário (RLS).</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" data-act="download">Baixar backup (JSON)</button>
      <button class="btn" data-act="export">Copiar backup</button>
      <label class="btn" style="display:inline-flex;align-items:center">Importar arquivo JSON<input type="file" id="importFile" accept=".json,application/json" hidden></label>
      <button class="btn" data-act="importpaste">Colar JSON</button>
      <button class="btn" data-act="sample">Carregar dados de exemplo</button>
      <button class="btn danger" data-act="reset">Apagar tudo</button>
    </div>
  </div>`;
  $('#secCard').innerHTML = `<h3>Segurança</h3>
    <p class="small" style="margin-top:0">Conectado como <b>${esc(SB.email())}</b> · verificação em duas etapas <span class="pill ok">ativa</span><br><span class="muted">A sessão encerra sozinha após ${IDLE_MIN} minutos sem uso e ao fechar a aba.</span></p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"><button class="btn" data-act="logout">Sair</button><button class="btn danger" data-act="logoutall">Sair de todos os dispositivos</button></div>
    <h3>Versões salvas automaticamente</h3><div id="histList" class="small muted">Carregando…</div>`;
  SB.listHistory().then(rows=>{ const el=$('#histList'); if(!el) return; el.innerHTML = rows && rows.length ? `<table><tbody>${rows.map(r=>`<tr><td class="num">${new Date(r.salvo_em).toLocaleString('pt-BR')}</td><td class="muted">versão ${r.versao}</td><td class="r"><button class="btn sm" data-act="restore" data-id="${Number(r.id)}">Restaurar</button></td></tr>`).join('')}</tbody></table>` : 'Nenhuma versão anterior ainda. A cada salvamento, a versão anterior é guardada (até 50).'; }).catch(()=>{ const el=$('#histList'); if(el) el.textContent='Não foi possível carregar o histórico.'; });
  $('#importFile').onchange=ev=>{ const f=ev.target.files[0]; if(!f) return; f.text().then(importJSON); };
}
function importJSON(txt){
  try{ const d=JSON.parse(txt); if(!d || !Array.isArray(d.tx)) throw 0; confirmBox('Substituir todos os dados atuais pelo backup?',()=>{ S=sanitizeState(d); save(); rerender(); toast('Backup importado'); }); }
  catch(e){ toast('JSON inválido'); }
}

/* ---------- dados de exemplo ---------- */
function loadSample(){
  const t=todayISO(), cur=monthKey(t), prev=addMonths(cur,-1), prev2=addMonths(cur,-2);
  const d=(k,day)=>`${k}-${pad(Math.min(day,daysInMonth(k)))}`;
  const nu={id:uid(),name:'Nubank',limit:8000,closeDay:3,dueDay:10,color:CARD_COLORS[1]};
  const it={id:uid(),name:'Itaú Visa',limit:12000,closeDay:25,dueDay:5,color:CARD_COLORS[2]};
  const tx=[];
  for(const k of [prev2,prev,cur]){
    tx.push({id:uid(),type:'in',desc:'Salário',amount:9500,date:d(k,5),category:'Salário',method:'pix',refMonth:addMonths(k,-1)});
    tx.push({id:uid(),type:'out',desc:'Aluguel',amount:2200,date:d(k,8),category:'Moradia',method:'pix'});
    tx.push({id:uid(),type:'out',desc:'Energia',amount:k===cur?310:280,date:d(k,12),category:'Contas (luz/água/internet)',method:'boleto'});
    tx.push({id:uid(),type:'out',desc:'Internet',amount:119.9,date:d(k,15),category:'Contas (luz/água/internet)',method:'debito'});
    tx.push({id:uid(),type:'out',desc:'Supermercado',amount:k===prev?780:640,date:d(k,9),category:'Mercado',method:'credito',cardId:nu.id,installments:1});
    tx.push({id:uid(),type:'out',desc:'Netflix',amount:44.9,date:d(k,2),category:'Assinaturas',method:'credito',cardId:it.id,installments:1});
    tx.push({id:uid(),type:'out',desc:'Combustível',amount:260,date:d(k,18),category:'Transporte',method:'debito'});
    tx.push({id:uid(),type:'out',desc:'Restaurante',amount:k===cur?185:142,date:d(k,20),category:'Alimentação',method:'credito',cardId:nu.id,installments:1});
  }
  tx.push({id:uid(),type:'in',desc:'Freela site',amount:1800,date:d(prev,22),category:'Freelance',method:'pix'});
  tx.push({id:uid(),type:'out',desc:'Notebook',amount:4800,date:d(prev2,27),category:'Compras',method:'credito',cardId:it.id,installments:10});
  tx.push({id:uid(),type:'out',desc:'Farmácia',amount:96.5,date:d(cur,4),category:'Saúde',method:'pix'});
  tx.push({id:uid(),type:'out',desc:'Curso online',amount:597,date:d(prev,14),category:'Educação',method:'credito',cardId:nu.id,installments:3});
  const ago=n=>{const x=new Date(); x.setDate(x.getDate()-n); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`;};
  const ahead=n=>{const x=new Date(); x.setDate(x.getDate()+n); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`;};
  const invest=[
    {id:uid(),name:'Reserva de emergência',institution:'Nubank',kind:'CDB',indexer:'cdi',rate:100,amount:15000,date:ago(400),maturity:'',liquidity:'diaria',liqDays:'',taxFree:false},
    {id:uid(),name:'CDB 108%',institution:'Banco Inter',kind:'CDB',indexer:'cdi',rate:108,amount:10000,date:ago(200),maturity:ahead(530),liquidity:'vencimento',taxFree:false},
    {id:uid(),name:'LCI 92%',institution:'XP',kind:'LCI',indexer:'cdi',rate:92,amount:8000,date:ago(120),maturity:ahead(245),liquidity:'vencimento',taxFree:true},
    {id:uid(),name:'Tesouro Selic 2029',institution:'Tesouro Direto',kind:'Tesouro Selic',indexer:'selic',rate:0.05,amount:5000,date:ago(300),maturity:'2029-03-01',liquidity:'diaria',liqDays:1,taxFree:false},
    {id:uid(),name:'IPCA+ 2035',institution:'Tesouro Direto',kind:'Tesouro IPCA+',indexer:'ipca',rate:7.2,amount:6000,date:ago(90),maturity:'2035-05-15',liquidity:'diaria',liqDays:1,taxFree:false},
    {id:uid(),name:'Fundo DI',institution:'BTG',kind:'Fundo DI',indexer:'cdi',rate:98,amount:3000,date:ago(60),maturity:'',liquidity:'d30',taxFree:false},
    {id:uid(),name:'Carteira de FIIs',institution:'XP',kind:'FII',indexer:'variavel',rate:0,amount:4000,current:4230,date:ago(250),maturity:'',liquidity:'dx',liqDays:2,taxFree:true}
  ];
  const loans=[{id:uid(),kind:'veicular',name:'Carro',lender:'Banco Toyota',category:'Transporte',method:'boleto',mode:'fixed',amount:1450,count:48,firstDate:d(addMonths(cur,-10),15),startMonth:addMonths(cur,-2),notes:'',versions:[]}];
  S = Object.assign(DEFAULT(), {settings:S.settings, categories:S.categories, cards:[nu,it], tx, invest, loans, paid:{[nu.id]:{[prev]:true,[prev2]:true},[it.id]:{[prev]:true,[prev2]:true}}});
  save(); rerender(); toast('Dados de exemplo carregados');
}

/* ================== modal & helpers ================== */
function openModal(html){ $('#modal').innerHTML=html; $('#overlay').classList.add('show'); setTimeout(()=>{ const i=$('#modal input:not([type=hidden]):not([type=checkbox])'); if(i && !i.value) i.focus(); },30); }
function closeModal(){ $('#overlay').classList.remove('show'); }
function modalActions(map){ $('#modal').querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>{ const k=b.dataset.m; if(k==='cancel') return closeModal(); map[k]&&map[k](); });
  const f=$('#modal form'); if(f) f.addEventListener('submit',e=>{e.preventDefault(); map.ok&&map.ok();}); }
function confirmBox(msg,fn){ openModal(`<h2>Confirmar</h2><p>${msg}</p><div class="actions"><button class="btn" data-m="cancel">Cancelar</button><button class="btn primary" data-m="ok" style="background:var(--out);border-color:var(--out)">Confirmar</button></div>`); modalActions({ok:()=>{ closeModal(); fn(); }}); }
function readForm(f){ const o={}; new FormData(f).forEach((v,k)=>o[k]=v); f.querySelectorAll('input[type=checkbox]').forEach(c=>o[c.name]=c.checked); return o; }
$('#overlay').addEventListener('mousedown',e=>{ if(e.target.id==='overlay') closeModal(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });

/* ================== ações globais ================== */
document.addEventListener('click', e=>{
  const el=e.target.closest('[data-act]'); if(!el) return;
  const a=el.dataset.act, id=el.dataset.id;
  if(a==='editcard'){ e.stopPropagation(); return cardForm(cardById(id)); }
  switch(a){
    case 'mprev': curMonth=addMonths(curMonth,-1); rerender(); break;
    case 'mnext': curMonth=addMonths(curMonth,1); rerender(); break;
    case 'view': S.settings.view=el.dataset.v; save(); rerender(); break;
    case 'newtx': txForm(); break;
    case 'edittx': txForm(structuredClone(S.tx.find(t=>t.id===id))); break;
    case 'newcard': cardForm(); break;
    case 'selcard': selCard=id; rerender(); break;
    case 'gomonth': curMonth=el.dataset.m; rerender(); break;
    case 'togglepaid': { S.paid[id]=S.paid[id]||{}; const m=el.dataset.m; S.paid[id][m]=!S.paid[id][m]; save(); rerender(); break; }
    case 'newinv': invForm(); break;
    case 'newloan': loanForm(); break;
    case 'editloan': loanForm(structuredClone(S.loans.find(l=>l.id===id))); break;
    case 'updloan': loanUpdateForm(S.loans.find(l=>l.id===id)); break;
    case 'selloan': selLoan=id; if(el.dataset.go){ location.hash='financiamentos'; } rerender(); break;
    case 'editinv': invForm(structuredClone(S.invest.find(i=>i.id===id))); break;
    case 'invtab': invTab=el.dataset.v; rerender(); break;
    case 'sample': (S.tx.length||S.invest.length||S.cards.length) ? confirmBox('Substituir seus dados atuais pelos dados de exemplo?',loadSample) : loadSample(); break;
    case 'savesettings': { const d=readForm($('#sf')); S.settings.cdi=parseNum(d.cdi); S.settings.selic=parseNum(d.selic); S.settings.ipca=parseNum(d.ipca); save(); toast('Indicadores salvos'); break; }
    case 'savecats': { const d=readForm($('#catf')); const sp=s=>[...new Set(s.split('\n').map(x=>x.trim()).filter(Boolean))]; const o=sp(d.out), i=sp(d.in); if(!o.length||!i.length) return toast('Mantenha ao menos uma categoria em cada lista'); S.categories={out:o,in:i}; save(); toast('Categorias salvas'); break; }
    case 'export': { const txt=JSON.stringify(S,null,2); navigator.clipboard.writeText(txt).then(()=>toast('Backup copiado — cole em um arquivo .json'),()=>{ openModal(`<h2>Backup</h2><p class="small muted">Copie o conteúdo abaixo e salve num arquivo .json.</p><textarea style="width:100%;height:280px;font-family:monospace;font-size:12px" readonly>${esc(txt)}</textarea><div class="actions"><button class="btn" data-m="cancel">Fechar</button></div>`); modalActions({}); }); break; }
    case 'download': { const blob=new Blob([JSON.stringify(S,null,2)],{type:'application/json'}); const u=URL.createObjectURL(blob); const a2=document.createElement('a'); a2.href=u; a2.download='financas-backup-'+todayISO()+'.json'; document.body.appendChild(a2); a2.click(); a2.remove(); setTimeout(()=>URL.revokeObjectURL(u),1000); break; }
    case 'logout': (async()=>{ if(saveTimer) await doSave(); await SB.signOut(); forceLogin('Você saiu.'); })(); break;
    case 'logoutall': confirmBox('Encerrar a sessão em todos os dispositivos (inclusive este)?', async()=>{ if(saveTimer) await doSave(); await SB.signOut('global'); forceLogin('Sessões encerradas em todos os dispositivos.'); }); break;
    case 'restore': confirmBox('Restaurar esta versão? Os dados atuais serão substituídos (e também ficarão guardados no histórico).', async()=>{ try{ const h=await SB.getHistory(id); if(!h) return toast('Versão não encontrada'); S=sanitizeState(h.dados); save(); rerender(); toast('Versão restaurada'); }catch(e){ toast('Falha ao restaurar'); } }); break;
    case 'importpaste': openModal(`<h2>Colar backup</h2><textarea id="pasteJson" style="width:100%;height:240px;font-family:monospace;font-size:12px;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--bg)" placeholder="Cole aqui o JSON exportado"></textarea><div class="actions"><button class="btn" data-m="cancel">Cancelar</button><button class="btn primary" data-m="ok">Importar</button></div>`); modalActions({ok:()=>importJSON($('#pasteJson').value)}); break;
    case 'reset': confirmBox('Apagar todos os lançamentos, cartões e investimentos? Isso não pode ser desfeito.',()=>{ const keep={settings:S.settings,categories:S.categories}; S=Object.assign(DEFAULT(),keep); save(); rerender(); toast('Dados apagados'); }); break;
  }
});

/* tooltip */
const tip=$('#tip');
document.addEventListener('mousemove',e=>{ const el=e.target.closest('[data-tip]'); if(!el){ tip.style.display='none'; return; } tip.textContent=el.dataset.tip; tip.style.display='block'; const w=tip.offsetWidth; tip.style.left=Math.min(window.innerWidth-w-8, e.clientX+12)+'px'; tip.style.top=(e.clientY+14)+'px'; });

boot();
