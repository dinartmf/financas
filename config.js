/*
 * Configuração pública do projeto.
 * A chave abaixo é a chave PÚBLICA do Supabase (publishable / anon). Ela pode
 * ficar no código: quem protege os dados são o login, a verificação em duas
 * etapas e as regras RLS do banco (supabase/schema.sql).
 * NUNCA coloque aqui a chave "secret" / "service_role".
 */
window.APP_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://dinartmf-financas.supabase.co',
  SUPABASE_KEY: 'sb_publishable_ZxOqw4R_vJyCSgBB0Vvc9w_EYsrutMD',
  IDLE_MINUTES: 15
});
