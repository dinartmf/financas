/*
 * Cliente mínimo do Supabase (Auth + REST) sem dependências externas.
 * Nenhuma biblioteca de terceiros é carregada: menos superfície de ataque.
 * A sessão fica em sessionStorage (some ao fechar a aba).
 */
'use strict';
const SB = (() => {
  const cfg = window.APP_CONFIG || {};
  const base = String(cfg.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(cfg.SUPABASE_KEY || '');
  const SKEY = 'fin.session';
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base) && key.length > 20;

  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(SKEY)); } catch (e) { session = null; }

  function persist(s) {
    session = s;
    try { s ? sessionStorage.setItem(SKEY, JSON.stringify(s)) : sessionStorage.removeItem(SKEY); } catch (e) { /* sem storage */ }
  }
  function fromToken(r) {
    return {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (Number(r.expires_in) || 3600),
      user: r.user || (session && session.user) || null
    };
  }

  async function req(path, opts = {}) {
    const { method = 'GET', body, auth = true, headers = {} } = opts;
    const h = { apikey: key, 'Content-Type': 'application/json', ...headers };
    if (auth) {
      await ensureFresh();
      if (session) h.Authorization = 'Bearer ' + session.access_token;
    }
    const res = await fetch(base + path, {
      method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer'
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error_description || data.error)) || ('HTTP ' + res.status);
      const err = new Error(msg); err.status = res.status; err.data = data; err.code = data && (data.error_code || data.code);
      throw err;
    }
    return data;
  }

  let refreshing = null;
  async function ensureFresh() {
    if (session && session.expires_at - 60 < Date.now() / 1000) await refresh();
  }
  function refresh() {
    if (!session) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await req('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: session.refresh_token } });
        persist(fromToken(r));
      } catch (e) { persist(null); throw e; }
      finally { refreshing = null; }
    })();
    return refreshing;
  }

  function claims() {
    if (!session) return {};
    try {
      const p = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(p).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''));
      return JSON.parse(json);
    } catch (e) { return {}; }
  }

  return {
    configured,
    get session() { return session; },
    claims,
    aal: () => claims().aal || 'aal1',
    userId: () => claims().sub || null,
    email: () => (session && session.user && session.user.email) || claims().email || '',

    async signIn(email, password) {
      const r = await req('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email, password } });
      persist(fromToken(r));
    },
    async signOut(scope = 'local') {
      try { if (session) await req('/auth/v1/logout?scope=' + scope, { method: 'POST' }); } catch (e) { /* ignora */ }
      persist(null);
    },
    clear() { persist(null); },
    async recover(email, redirectTo) {
      await req('/auth/v1/recover?redirect_to=' + encodeURIComponent(redirectTo), { method: 'POST', auth: false, body: { email } });
    },
    // Link de recuperação de senha chega com #access_token=...&type=recovery
    takeRecoveryFromHash() {
      const h = location.hash.slice(1);
      if (!/(^|&)type=recovery(&|$)/.test(h) || !/access_token=/.test(h)) return false;
      const p = new URLSearchParams(h);
      persist(fromToken({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: p.get('expires_in') }));
      history.replaceState(null, '', location.pathname + location.search);
      return true;
    },
    async getUser() { const u = await req('/auth/v1/user'); if (session) persist({ ...session, user: u }); return u; },
    async updatePassword(password) { await req('/auth/v1/user', { method: 'PUT', body: { password } }); },

    // MFA (TOTP)
    async enrollTotp() {
      const u = await this.getUser();
      for (const f of (u.factors || [])) {
        if (f.status !== 'verified') { try { await req('/auth/v1/factors/' + f.id, { method: 'DELETE' }); } catch (e) { /* ignora */ } }
      }
      return req('/auth/v1/factors', { method: 'POST', body: { factor_type: 'totp', friendly_name: 'Autenticador ' + new Date().toISOString().slice(0, 16) } });
    },
    async verifyTotp(factorId, code) {
      const ch = await req('/auth/v1/factors/' + factorId + '/challenge', { method: 'POST', body: {} });
      const r = await req('/auth/v1/factors/' + factorId + '/verify', { method: 'POST', body: { challenge_id: ch.id, code } });
      persist(fromToken(r));
    },

    // Dados (tabela public.estado — protegida por RLS)
    async loadState() {
      const rows = await req('/rest/v1/estado?select=dados,versao,updated_at', { headers: { Accept: 'application/json' } });
      return rows && rows[0] ? rows[0] : null;
    },
    async insertState(dados) {
      const rows = await req('/rest/v1/estado?select=versao,updated_at', { method: 'POST', body: { dados }, headers: { Prefer: 'return=representation' } });
      return rows[0];
    },
    // Atualização otimista: só grava se a versão no banco for a mesma que carregamos.
    async updateState(dados, versao) {
      const uid = encodeURIComponent(this.userId());
      const rows = await req(`/rest/v1/estado?user_id=eq.${uid}&versao=eq.${Number(versao)}&select=versao,updated_at`, { method: 'PATCH', body: { dados }, headers: { Prefer: 'return=representation' } });
      return rows && rows[0] ? rows[0] : null; // null = conflito (outro dispositivo salvou antes)
    },
    async listHistory() {
      return req('/rest/v1/estado_historico?select=id,versao,salvo_em&order=id.desc&limit=30');
    },
    async getHistory(id) {
      const rows = await req('/rest/v1/estado_historico?select=dados,versao,salvo_em&id=eq.' + Number(id));
      return rows && rows[0];
    }
  };
})();
