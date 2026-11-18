# Radar de Preço — versão de teste

Acompanha o preço de produtos, guarda o histórico e avisa a hora certa de comprar.

## Como usar

1. Dê dois cliques em **Iniciar Radar.bat**. O app abre no navegador em http://localhost:3000.
2. Cole o link de um produto e, se quiser, o preço que você pagaria. Lojas que já funcionam:
   - **Gerais:** Amazon, Kabum
   - **Farmácias:** Drogasil, Droga Raia, Panvel, Pague Menos, Drogaria São Paulo
   - **Beleza:** Época Cosméticos
3. Para comparar, abra o produto e clique em **Procurar em outras lojas**. O app procura na Amazon, Pague Menos, Drogaria São Paulo e Época. Confira se é o mesmo produto (tamanho, cor, FPS) e clique em **É esse, adicionar**. Também dá para colar o link de outra loja direto.
   - "Mesmo código de barras" = quase certeza de que é o mesmo produto.
   - "Nome parecido, confira" = pode ser outro tamanho ou versão.
4. Clique em **Ativar avisos** para receber notificação no computador.
5. Deixe a janela preta aberta. Enquanto ela estiver aberta (e o computador ligado), o app confere os preços sozinho.

## Quando os preços são conferidos

- A cada **4 horas**.
- Na semana da Black Friday (24/11 a 01/12), a cada **1 hora**.
- A qualquer momento, pelo botão **Atualizar agora**.

## Quando o app avisa

- O preço chegou no valor que você quer pagar.
- O preço caiu 10% ou mais de uma leitura para outra.
- Bateu o menor preço já visto (depois de 7 dias de histórico).

## O que ainda falta

- Outras lojas. Bloqueiam a leitura simples: Magalu, Casas Bahia, Beleza na Web, O Boticário, Sephora. Precisam de outro caminho: Mercado Livre, Shopee, Natura.
- Procurar automaticamente na Drogasil, Droga Raia, Panvel e Kabum (nelas, por enquanto, só colando o link).
- Cupons.
- Login com nome e senha, com contas separadas.
- Rodar num servidor na internet, para funcionar com o computador desligado e no celular.

## Para quem for mexer no código

- `src/lojas.js`: leitores de preço de cada loja.
- `src/analise.js`: regra de "bom momento" e dos avisos.
- `src/verificador.js`: confere os preços de tempos em tempos.
- `src/servidor.js`: servidor e rotas `/api/...`.
- `public/`: a tela do app.
- `dados/radar.db`: banco com o histórico. Não apague, ou o histórico se perde.
- Testes: `node scripts/testar-analise.js` e `node scripts/testar-lojas.js [link]`.

Precisa do Node.js 24 ou mais novo. Não usa nenhum pacote externo.
