# Radar na nuvem

- **Endereço do app:** https://beatrizbeatriz22.github.io/radar-de-preco/
- **Código:** https://github.com/Beatrizbeatriz22/radar-de-preco
- **Banco e login:** projeto `neybxehhfveilnqzjbmw` no Supabase (organização plano-financeiro)

## Login

Cada pessoa toca em **Criar minha conta** e escolhe um nome e uma senha (mínimo 6 caracteres).
Depois é só **Entrar** com o mesmo nome e senha. Cada conta só vê os próprios produtos.
Não precisa de e-mail nem de Google. Se alguém esquecer a senha, apague a conta em
Supabase → Authentication → Users e a pessoa cria de novo.

## As 3 chaves secretas (só você cola)

No GitHub: repositório `radar-de-preco` → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

| Nome do segredo | De onde copiar |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → **API Keys** → *Secret keys* → copiar a chave `sb_secret_...` |
| `SUPABASE_ACCESS_TOKEN` | Supabase → sua foto → **Account preferences** → **Access Tokens** → *Generate new token* (nome `radar`) |
| `VAPID_PRIVADA` | arquivo `dados/chaves-avisos.txt` no seu computador, a linha depois de `VAPID_PRIVADA` |

Não mande essas chaves no chat.

## No celular

- Android: abra o endereço no Chrome → menu ⋮ → **Instalar app**.
- iPhone: abra no Safari → **Compartilhar** → **Adicionar à Tela de Início** e abra pelo ícone.
- Depois de instalar, toque em **Ativar avisos**.

Os preços são conferidos de hora em hora pelo GitHub (aba **Actions** → *Verificar preços*), mesmo com o computador desligado.

## Lojas que bloqueiam a nuvem (Amazon, Panvel, Kabum)

Essas lojas recusam leituras vindas de servidores. Quem lê é o **Radar no computador** (a "ponte"):

- Dê dois cliques em `Radar no computador.bat`. Abre a tela http://localhost:3001.
- Entre uma vez com o mesmo nome e senha do app. Depois disso ela trabalha sozinha.
- Com o computador ligado, ela confere essas lojas no mesmo ritmo da nuvem e lê produtos novos em até 2 minutos.
- Com o computador desligado, essas lojas ficam paradas no último preço; as outras continuam normais.
