# Colocar o Radar na internet (tudo grátis)

São 4 contas gratuitas. Você cria as contas e cola as chaves secretas. O resto, o Claude faz.

> **Regra de ouro:** as chaves marcadas com 🔒 são secretas. Cole só onde este guia mandar e **não mande no chat**.
> As outras (sem 🔒) são públicas e podem ser mandadas para o Claude.

---

## 1. GitHub (guarda o código, publica o site e confere os preços)

1. Entre em **github.com** e crie uma conta, se ainda não tiver.
2. Clique em **+** (canto de cima) → **New repository**.
   - Nome: `radar-de-preco`
   - Marque **Public**. O código fica visível, mas nenhuma senha ou dado seu fica lá. Público é o que deixa o site e o verificador grátis.
   - Não marque mais nada. Clique em **Create repository**.
3. 📩 **Mande para o Claude:** o seu nome de usuário do GitHub.

## 2. Supabase (guarda os dados e faz o login)

1. Entre em **supabase.com** → **Start your project** → entre com a conta do GitHub.
2. **New project**:
   - Name: `radar-de-preco`
   - Database Password: clique em **Generate a password** e guarde num lugar seguro.
   - Region: **South America (São Paulo)**
   - Plano: **Free**
3. Espere uns 2 minutos até o projeto ficar pronto.
4. No menu da esquerda, abra **SQL Editor** → **New query**.
   - Abra o arquivo `supabase/migrations/20261116000000_radar.sql` (na pasta do Radar) e copie tudo.
   - Cole no editor e clique em **Run**. Deve aparecer *Success*.
5. Vá em **Project Settings** (engrenagem) → **API Keys** e **Data API**. Você vai precisar de:
   - **Project URL** (algo como `https://abcdxyz.supabase.co`). 📩 Mande para o Claude.
   - **anon / publishable key**. 📩 Mande para o Claude (é pública).
   - **Project ref**: as letras no começo do Project URL (`abcdxyz`). 📩 Mande para o Claude.
   - 🔒 **service_role / secret key**: não mande. Vai no passo 4.
6. Clique na sua foto (canto de cima) → **Account preferences** → **Access Tokens** → **Generate new token** (nome: `radar`).
   - 🔒 Copie e guarde. Vai no passo 4.

## 3. Google (para o botão "Entrar com Google")

1. Entre em **console.cloud.google.com** com a sua conta Google.
2. Crie um projeto: menu de projetos (em cima) → **Novo projeto** → nome `Radar de Preço` → **Criar**.
3. Menu → **APIs e serviços** → **Tela de permissão OAuth** (ou **Google Auth Platform**) → **Começar**:
   - Nome do app: `Radar de Preço`, e-mail de suporte: o seu.
   - Público: **Externo**.
   - Em **Público-alvo** (Audience), deixe em **Teste** e adicione como **usuários de teste** o seu e-mail e o de quem vai usar (até 100 pessoas). Só essas pessoas conseguem entrar enquanto estiver em teste.
4. **Clientes** → **Criar cliente**:
   - Tipo: **Aplicativo da Web**
   - **URIs de redirecionamento autorizados**: `https://SEU-PROJECT-REF.supabase.co/auth/v1/callback`
   - Clique em **Criar**. Aparecem o **ID do cliente** e a 🔒 **Chave secreta do cliente**.
5. Volte ao Supabase → **Authentication** → **Sign In / Providers** → **Google**:
   - Ligue **Enable**.
   - Cole o **Client ID** e a 🔒 **Client Secret** do Google.
   - Clique em **Save**.
6. Ainda no Supabase → **Authentication** → **URL Configuration**:
   - **Site URL**: `https://SEU-USUARIO-GITHUB.github.io/radar-de-preco/`
   - Em **Redirect URLs**, adicione o mesmo endereço.

## 4. Chaves secretas no GitHub

No GitHub, abra o repositório `radar-de-preco` → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Crie um segredo para cada linha (o nome tem que ser exatamente este):

| Nome do segredo | O que colar |
|---|---|
| `SUPABASE_URL` | o Project URL do Supabase |
| `SUPABASE_PROJECT_REF` | o Project ref |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔒 a service_role / secret key do Supabase |
| `SUPABASE_ACCESS_TOKEN` | 🔒 o Access Token do Supabase |
| `VAPID_PUBLICA` | a linha depois de VAPID_PUBLICA no arquivo `dados/chaves-avisos.txt` |
| `VAPID_PRIVADA` | 🔒 a linha depois de VAPID_PRIVADA no mesmo arquivo |
| `VAPID_CONTATO` | `mailto:` + o seu e-mail (ex.: `mailto:voce@gmail.com`) |

Depois, ainda em **Settings** → **Pages** → em **Source**, escolha **GitHub Actions**.

## 5. Avise o Claude

Mande no chat: usuário do GitHub, Project URL, anon/publishable key e Project ref.
O Claude então coloca esses dados no app, envia o código para o GitHub (vai abrir uma janela para você entrar no GitHub) e testa tudo.

---

### Depois de pronto

- **Endereço do app:** `https://SEU-USUARIO-GITHUB.github.io/radar-de-preco/`
- **No celular:**
  - Android: abra o endereço no Chrome → menu ⋮ → **Instalar app**.
  - iPhone: abra no Safari → **Compartilhar** → **Adicionar à Tela de Início**. Depois abra pelo ícone.
  - Depois de instalar, toque em **Ativar avisos**.
- **Convidar alguém:** adicione o e-mail da pessoa nos usuários de teste do Google (passo 3.3) e mande o endereço do app. Cada pessoa vê só os próprios produtos.
- **Preços:** são conferidos de hora em hora no GitHub (aba **Actions** → *Verificar preços*), mesmo com seu computador desligado.
