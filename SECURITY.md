# Segurança

## Como os dados são protegidos

| Camada | Proteção |
|---|---|
| **Acesso** | Login com e-mail e senha + **verificação em duas etapas (TOTP) obrigatória**. Sem o código do celular, o banco não entrega nenhum dado. |
| **Banco (Supabase)** | **Row Level Security** em todas as tabelas: cada usuário só lê/grava a própria linha, e somente com sessão `aal2` (MFA verificado). Sem permissão de `DELETE` pela API. Usuário anônimo não tem acesso a nada. |
| **Cadastro** | Novos cadastros desativados no Supabase: só o usuário criado pelo dono existe. |
| **Integridade** | Versão, datas e dono da linha são definidos pelo servidor (gatilhos), não pelo navegador. Controle de concorrência impede que um dispositivo sobrescreva alterações de outro sem aviso. |
| **Recuperação** | Histórico automático das últimas 50 versões, gravado apenas pelo servidor (não pode ser forjado pela API). Backup manual em JSON. |
| **Sessão** | Guardada em `sessionStorage` (some ao fechar a aba). Encerramento automático após 15 min sem uso. Botão "Sair de todos os dispositivos" revoga todas as sessões. |
| **Navegador** | Content-Security-Policy restritiva: só executa scripts do próprio site, só conversa com `*.supabase.co`, sem formulários externos. Nenhuma biblioteca JavaScript de terceiros. Bloqueio de carregamento em iframe (clickjacking). `Referrer-Policy: no-referrer`. Todo texto exibido é escapado (proteção contra XSS). |
| **Código** | Nenhum segredo no repositório: a chave do `config.js` é pública por design. O deploy falha se uma chave `service_role`/`secret` for commitada. Workflow com permissões mínimas. |
| **Senhas** | Mínimo de 12 caracteres com maiúsculas, minúsculas, números e símbolos (configurar no Supabase). Limite de tentativas de login do Supabase contra força bruta. |

## Checklist do dono

- [ ] Verificação em duas etapas ativada **na sua conta do GitHub** e **na sua conta do Supabase**.
- [ ] "Allow new users to sign up" **desativado** no Supabase.
- [ ] Requisitos de senha configurados (12+ caracteres, tipos variados).
- [ ] Site URL / Redirect URLs apontando só para o seu endereço do GitHub Pages.
- [ ] Branch `main` protegida no GitHub (Settings → Branches → Add rule: exigir pull request ou bloquear force push).
- [ ] Guardar a chave secreta do app autenticador (ou ativar backup na nuvem do próprio app) para não perder o acesso se trocar de celular.
- [ ] Baixar um backup JSON de vez em quando e guardá-lo em local seguro.
- [ ] Projetos gratuitos do Supabase podem ser **pausados após um período sem uso**; se o site não carregar, reative o projeto no painel.

## Limitações conhecidas

- GitHub Pages não permite definir cabeçalhos HTTP; a CSP é aplicada via `<meta>` (cobre scripts, conexões e formulários, mas não `frame-ancestors` — por isso o bloqueio de iframe é feito em JavaScript).
- Os dados no Supabase ficam criptografados em repouso pelo provedor, mas não são criptografados com uma chave só sua. Quem tiver acesso administrativo ao **seu** projeto Supabase consegue lê-los — por isso proteja bem essa conta com MFA.

## Reportar um problema
Abra uma issue privada (Security → Report a vulnerability) no repositório.
