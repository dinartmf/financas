# Finanças — controle financeiro pessoal

Sistema web para controle de receitas, despesas (Pix, débito e crédito com parcelas), faturas de cartão e investimentos (CDB, LCI/LCA, Tesouro, FIIs…) com liquidez e rentabilidade (% do CDI, IPCA+, prefixado).

- **Site:** hospedado no GitHub Pages (arquivos estáticos, sem servidor próprio).
- **Login e dados:** Supabase (plano gratuito), com verificação em duas etapas obrigatória e regras de acesso no banco (RLS).

## Estrutura

```
index.html            página principal (com Content-Security-Policy)
config.js             URL do projeto Supabase + chave PÚBLICA
assets/app.js         telas e regras do sistema
assets/supabase.js    cliente mínimo do Supabase (sem bibliotecas externas)
assets/styles.css     visual
supabase/schema.sql   tabelas, RLS, gatilhos e histórico — rodar no Supabase
.github/workflows/pages.yml  publicação automática no GitHub Pages
SECURITY.md           itens de segurança e checklist
```

## Configuração (uma vez só, ~10 minutos)

> Os nomes dos menus do Supabase podem variar um pouco entre versões do painel.

### 1. Criar o projeto no Supabase
1. Crie uma conta em <https://supabase.com> e clique em **New project**.
2. Escolha a região **South America (São Paulo)** e defina uma senha forte para o banco (guarde-a num gerenciador de senhas; o sistema não usa essa senha).

### 2. Criar as tabelas e as regras de segurança
1. No projeto, abra **SQL Editor → New query**.
2. Cole todo o conteúdo de `supabase/schema.sql` e clique em **Run**. Deve terminar sem erros.

### 3. Configurar a autenticação
Em **Authentication**:
1. **Sign In / Providers → Email:** deixe o login por e-mail habilitado. Em requisitos de senha, defina **mínimo de 12 caracteres** e exija letras maiúsculas, minúsculas, números e símbolos.
2. **Multi-Factor:** confirme que **TOTP (App Authenticator)** está habilitado.
3. **Users → Add user → Create new user:** crie o seu usuário (e-mail + senha forte) marcando **Auto Confirm User**.
4. **Sign In / Providers:** **desative "Allow new users to sign up"**. Assim ninguém mais consegue criar conta, mesmo conhecendo o endereço do site.
5. **URL Configuration:** em **Site URL** e **Redirect URLs**, coloque o endereço do site no GitHub Pages (ex.: `https://SEU-USUARIO.github.io/financas/`). Isso é usado pelo link de "Esqueci minha senha".

### 4. Preencher o `config.js`
Em **Project Settings → API Keys** (ou no botão **Connect**), copie:
- a **Project URL** (`https://xxxx.supabase.co`) → `SUPABASE_URL`
- a **Publishable key** (`sb_publishable_...`) ou a chave legada **anon** → `SUPABASE_KEY`

⚠️ **Nunca** use a chave `secret` / `service_role`. O workflow de publicação bloqueia o deploy se encontrar uma.

### 5. Publicar no GitHub Pages
1. Envie os arquivos para a branch `main` do repositório.
2. No GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. A cada `push` na `main`, o workflow publica o site. O endereço aparece em **Actions** e em **Settings → Pages**.

### 6. Primeiro acesso
1. Abra o site e entre com o e-mail e a senha criados no passo 3.
2. Escaneie o QR code com um app autenticador (Google Authenticator, Microsoft Authenticator ou Authy) e digite o código de 6 dígitos.
3. A partir daí, todo login pede senha **e** código do celular.

## Uso
- **Painel:** receitas, despesas, saldo do mês, faturas a vencer, despesas por categoria e investimentos por liquidez. Alterne entre visão **Caixa** (crédito no mês da fatura) e **Competência** (crédito no mês da compra).
- **Lançamentos:** Pix, débito e crédito (até 24 parcelas). Parcelas são distribuídas automaticamente nas faturas pelo dia de fechamento do cartão.
- **Cartões:** limite, fechamento, vencimento, faturas futuras e marcação de fatura paga.
- **Investimentos:** tipo, instituição, indexador e taxa, liquidez, vencimento, isenção de IR; valor estimado hoje e no vencimento (líquido de IR); comparador CDB × LCI/LCA.
- **Ajustes:** CDI/Selic/IPCA usados nas projeções, categorias, backup (baixar/importar JSON), histórico automático das últimas 50 versões, sair de todos os dispositivos.

## Desenvolvimento local
```bash
python3 -m http.server 8000   # abra http://localhost:8000
```
Para testar localmente, adicione `http://localhost:8000` em **Redirect URLs** no Supabase.
