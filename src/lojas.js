// Leitores de preço por loja. Cada um recebe o link do produto e devolve
// { loja, titulo, preco, foto, vendedor, disponivel }.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function baixar(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (r.status === 403 || r.status === 503) throw new Error(`A loja bloqueou a leitura (código ${r.status}). Tente de novo mais tarde.`);
  if (!r.ok) throw new Error(`A página respondeu com erro ${r.status}.`);
  return r.text();
}

const limpar = s => (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// "R$ 1.234,56" -> 1234.56
function paraNumero(txt) {
  if (typeof txt === 'number') return txt;
  if (/^\s*\d+(\.\d+)?\s*$/.test(String(txt))) return Number(txt); // formato "78.9" (ficha schema.org)
  const m = String(txt).replace(/\s/g, '').match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/);
  if (!m) return null;
  return Number(m[1].replace(/\./g, '') + '.' + (m[2] || '00'));
}

// Lê os blocos de dados estruturados (schema.org) que as lojas publicam para o Google.
function produtoLd(html) {
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    let dado;
    try { dado = JSON.parse(m[1]); } catch { continue; }
    const lista = Array.isArray(dado) ? dado : dado['@graph'] || [dado];
    for (const d of lista) if (d && (d['@type'] === 'Product' || (Array.isArray(d['@type']) && d['@type'].includes('Product')))) return d;
  }
  return null;
}

// Código de barras (EAN/GTIN): é o que garante que é o mesmo produto em lojas diferentes.
const eanDe = ld => String(ld?.gtin13 || ld?.gtin || ld?.gtin14 || ld?.gtin12 || ld?.gtin8 || '').replace(/\D/g, '') || null;

// Tira palavras de marketing e deixa só o essencial para buscar por nome.
export function termoDeBusca(titulo) {
  return titulo.replace(/[–—\-|,()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 7).join(' ');
}

// Lojas que publicam a ficha do produto (schema.org) na própria página.
function lojaComFicha(nome, dominio, vendedor = nome) {
  return {
    nome,
    reconhece: u => new URL(u).hostname.endsWith(dominio),
    normalizar: u => u.split('?')[0].split('#')[0],
    async ler(url) {
      const html = await baixar(url);
      const ld = produtoLd(html);
      if (!ld) throw new Error('Não encontrei os dados do produto nessa página. Confira se o link é de um produto (e não de uma busca ou categoria).');
      const ofertas = [].concat(ld.offers || []).flatMap(o => o['@type'] === 'AggregateOffer' && o.offers ? [].concat(o.offers) : [o]);
      const oferta = ofertas.find(o => o.price != null || o.lowPrice != null) || ofertas[0];
      const preco = oferta ? paraNumero(oferta.price ?? oferta.lowPrice) : null;
      let foto = ld.image;
      if (Array.isArray(foto)) foto = foto[0];
      if (foto && typeof foto === 'object') foto = foto.url || foto.contentUrl;
      if (!foto) foto = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) || [])[1] || null;
      return {
        loja: nome, titulo: limpar(ld.name), preco, foto: foto || null, vendedor, ean: eanDe(ld),
        disponivel: preco != null && !/OutOfStock|SoldOut|Discontinued/i.test(oferta?.availability || ''),
      };
    },
  };
}

// Lojas na plataforma VTEX: têm uma consulta pública de produto que devolve preço e estoque.
function lojaVtex(nome, dominio, host = `www.${dominio}`) {
  return {
    nome,
    reconhece: u => new URL(u).hostname.endsWith(dominio),
    normalizar: u => { const x = new URL(u); return `${x.origin}${x.pathname}`; },
    async ler(url) {
      const x = new URL(url);
      const m = x.pathname.match(/^\/(.+)\/p\/?$/);
      if (!m) throw new Error('Esse link não parece ser de um produto. O link do produto termina com /p.');
      const r = await fetch(`${x.origin}/api/catalog_system/pub/products/search/${m[1]}/p`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000),
      });
      if (!r.ok) throw new Error(`A loja não respondeu (código ${r.status}). Tente de novo mais tarde.`);
      const [prod] = await r.json();
      if (!prod) throw new Error('Não encontrei esse produto na loja. Ele pode ter saído do catálogo.');
      const item = prod.items?.[0];
      const venda = item?.sellers?.find(s => s.sellerDefault) || item?.sellers?.[0];
      const of = venda?.commertialOffer || {};
      const disponivel = (of.AvailableQuantity ?? (of.IsAvailable ? 1 : 0)) > 0 && of.Price > 0;
      return {
        loja: nome, titulo: limpar(prod.productName), preco: of.Price > 0 ? of.Price : null,
        foto: item?.images?.[0]?.imageUrl || null,
        vendedor: venda?.sellerName && !/^1$|^vtex/i.test(venda.sellerId) ? venda.sellerName : nome,
        disponivel, ean: item?.ean || null,
      };
    },
    // Procura na loja pelo código de barras (exato) ou pelo nome (parecido).
    async buscar({ ean, titulo }) {
      const base = `https://${host}/api/catalog_system/pub/products/search`;
      const tentativas = [];
      if (ean) tentativas.push([`${base}?fq=alternateIds_Ean:${ean}&_from=0&_to=2`, 'mesmo código de barras']);
      tentativas.push([`${base}?ft=${encodeURIComponent(termoDeBusca(titulo))}&_from=0&_to=2`, 'nome parecido']);
      for (const [u, como] of tentativas) {
        const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        const lista = await r.json().catch(() => []);
        const achados = lista.map(p => {
          const item = p.items?.[0], of = (item?.sellers?.find(s => s.sellerDefault) || item?.sellers?.[0])?.commertialOffer;
          return { loja: nome, link: `https://${host}/${p.linkText}/p`, titulo: limpar(p.productName), preco: of?.Price > 0 ? of.Price : null, foto: item?.images?.[0]?.imageUrl || null, ean: item?.ean || null, como };
        }).filter(a => a.preco);
        if (achados.length) return como === 'mesmo código de barras' ? achados.slice(0, 1) : achados;
      }
      return [];
    },
    // Pesquisa por texto livre ("ps5 slim", "papete feminina"): devolve os primeiros produtos da loja.
    async pesquisar(termo, n = 6) {
      const r = await fetch(`https://${host}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(termo)}&_from=0&_to=${n - 1}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`código ${r.status}`);
      const lista = await r.json().catch(() => []);
      return lista.map(p => {
        const item = p.items?.find(i => i.sellers?.some(s => s.commertialOffer?.Price > 0)) || p.items?.[0];
        const venda = item?.sellers?.find(s => s.sellerDefault && s.commertialOffer?.Price > 0) || item?.sellers?.find(s => s.commertialOffer?.Price > 0);
        const of = venda?.commertialOffer;
        return { loja: nome, link: `https://${host}/${p.linkText}/p`, titulo: limpar(p.productName), preco: of?.Price > 0 ? of.Price : null, foto: item?.images?.[0]?.imageUrl || null, ean: item?.ean || null,
          vendedor: venda?.sellerName && !/^1$|^vtex/i.test(venda.sellerId) ? venda.sellerName : nome };
      }).filter(a => a.preco);
    },
  };
}

const lojas = {
  drogasil: lojaComFicha('Drogasil', 'drogasil.com.br'),
  drogaraia: lojaComFicha('Droga Raia', 'drogaraia.com.br'),
  panvel: lojaComFicha('Panvel', 'panvel.com'),
  paguemenos: lojaVtex('Pague Menos', 'paguemenos.com.br'),
  drogariasaopaulo: lojaVtex('Drogaria São Paulo', 'drogariasaopaulo.com.br'),
  epoca: lojaVtex('Época Cosméticos', 'epocacosmeticos.com.br'),
  pacheco: lojaVtex('Drogarias Pacheco', 'drogariaspacheco.com.br'),
  americanas: lojaVtex('Americanas', 'americanas.com.br'),
  fastshop: lojaVtex('Fast Shop', 'fastshop.com.br', 'site.fastshop.com.br'),
  cea: lojaVtex('C&A', 'cea.com.br'),
  riachuelo: lojaComFicha('Riachuelo', 'riachuelo.com.br'),
  renner: lojaComFicha('Renner', 'lojasrenner.com.br'),
  mac: lojaComFicha('MAC', 'maccosmetics.com.br'),
  samsung: { ...lojaComFicha('Samsung', 'samsung.com'), reconhece: u => { const x = new URL(u); return x.hostname.endsWith('samsung.com') && x.pathname.startsWith('/br/'); } },

  amazon: {
    nome: 'Amazon',
    reconhece: u => /amazon\.com\.br/.test(u),
    // Link curto e estável: só o código do produto (ASIN)
    normalizar: u => { const m = u.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i); return m ? `https://www.amazon.com.br/dp/${m[1].toUpperCase()}` : u; },
    async ler(url) {
      const html = await baixar(url);
      if (/captcha/i.test(html) && !/productTitle/.test(html)) throw new Error('A Amazon pediu verificação de robô. Tente de novo mais tarde.');
      const titulo = limpar((html.match(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
      // Preço principal fica no bloco "corePrice" / "apex"; pegamos o primeiro valor dentro dele.
      let preco = null;
      const apex = html.match(/apex-pricetopay-value[^>]*>\s*<span class="a-offscreen">\s*([^<]+)</);
      if (apex) preco = paraNumero(apex[1]);
      if (preco == null) { const pa = html.match(/"priceAmount":([\d.]+)/); if (pa) preco = Number(pa[1]); }
      if (preco == null) {
        const i = html.indexOf('corePrice');
        const m = i >= 0 && html.slice(i, i + 8000).match(/class="a-offscreen">\s*(R\$[^<]+)</);
        if (m) preco = paraNumero(m[1]);
      }
      const foto = (html.match(/"hiRes":"(https:[^"]+)"/) || html.match(/id="landingImage"[^>]*src="([^"]+)"/) || [])[1] || null;
      const vendedor = limpar((html.match(/id="sellerProfileTriggerId"[^>]*>([^<]+)</) || [])[1]) || (/Vendido por\s*<[^>]*>\s*Amazon/i.test(html) || /merchant-info[\s\S]{0,300}Amazon/i.test(html) ? 'Amazon' : '');
      const disponivel = preco != null && !/id="outOfStock"/.test(html);
      if (!titulo) throw new Error('Não consegui ler o nome do produto nessa página.');
      const ean = (html.match(/EAN[\s\S]{0,120}?<td[^>]*>\s*(?:&lrm;|‎)?\s*(\d{8,14})/) || [])[1] || null;
      return { loja: 'Amazon', titulo, preco, foto, vendedor: vendedor || 'Não identificado', disponivel, ean };
    },
    // Busca na Amazon pelo código de barras ou pelo nome; devolve os primeiros resultados.
    async buscar({ ean, titulo }) {
      for (const [termo, como] of [[ean, 'mesmo código de barras'], [termoDeBusca(titulo), 'nome parecido']]) {
        if (!termo) continue;
        let html;
        try { html = await baixar(`https://www.amazon.com.br/s?k=${encodeURIComponent(termo)}`); } catch { continue; }
        const achados = [];
        for (const bloco of html.split('data-asin="').slice(1)) {
          const asin = bloco.slice(0, 10);
          if (!/^[A-Z0-9]{10}$/.test(asin) || /Patrocinado|sp_atf|AdHolder/.test(bloco.slice(0, 3000))) continue;
          const t = limpar((bloco.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
          const p = (bloco.match(/class="a-offscreen">\s*(R\$[^<]+)</) || [])[1];
          const f = (bloco.match(/class="s-image"[^>]*src="([^"]+)"/) || [])[1];
          if (t && p && !achados.some(a => a.link.endsWith(asin))) achados.push({ loja: 'Amazon', link: `https://www.amazon.com.br/dp/${asin}`, titulo: t, preco: paraNumero(p), foto: f || null, ean: null, como });
          if (achados.length >= 3) break;
        }
        if (achados.length) return como === 'mesmo código de barras' ? achados.slice(0, 1) : achados;
      }
      return [];
    },
    async pesquisar(termo, n = 6) {
      const html = await baixar(`https://www.amazon.com.br/s?k=${encodeURIComponent(termo)}`);
      const achados = [];
      for (const bloco of html.split('data-asin="').slice(1)) {
        const asin = bloco.slice(0, 10);
        if (!/^[A-Z0-9]{10}$/.test(asin) || /Patrocinado|sp_atf|AdHolder/.test(bloco.slice(0, 3000))) continue;
        const t = limpar((bloco.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/) || [])[1]);
        const p = (bloco.match(/class="a-offscreen">\s*(R\$[^<]+)</) || [])[1];
        const f = (bloco.match(/class="s-image"[^>]*src="([^"]+)"/) || [])[1];
        if (t && p && !achados.some(a => a.link.endsWith(asin))) achados.push({ loja: 'Amazon', link: `https://www.amazon.com.br/dp/${asin}`, titulo: t, preco: paraNumero(p), foto: f || null, ean: null, vendedor: null });
        if (achados.length >= n) break;
      }
      return achados;
    },
  },

  kabum: {
    nome: 'Kabum',
    reconhece: u => /kabum\.com\.br/.test(u),
    normalizar: u => u.split('?')[0],
    async ler(url) {
      const html = await baixar(url);
      const ld = produtoLd(html);
      let titulo = ld?.name, foto = Array.isArray(ld?.image) ? ld.image[0] : ld?.image, preco = null, disponivel = true;
      const oferta = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
      if (oferta) {
        preco = paraNumero(oferta.price ?? oferta.lowPrice);
        disponivel = !/OutOfStock/i.test(oferta.availability || '');
      }
      // A Kabum também guarda o preço à vista (Pix) nos dados da página
      const pix = html.match(/"priceWithDiscount"\s*:\s*([\d.]+)/);
      const precoPix = pix ? Number(pix[1]) : null;
      if (!titulo) titulo = limpar((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
      if (!titulo) throw new Error('Não consegui ler o nome do produto nessa página.');
      return { loja: 'Kabum', titulo: limpar(titulo), preco, precoPix, foto: foto || null, vendedor: 'Kabum', disponivel, ean: eanDe(ld) };
    },
    async pesquisar(termo, n = 6) {
      const html = await baixar(`https://www.kabum.com.br/busca/${encodeURIComponent(termo.trim().replace(/\s+/g, '-'))}`);
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return [];
      let dados = JSON.parse(m[1]).props?.pageProps?.data;
      if (typeof dados === 'string') dados = JSON.parse(dados);
      return (dados?.catalogServer?.data || []).filter(x => x.available && x.price > 0).slice(0, n).map(x => ({
        loja: 'Kabum', link: `https://www.kabum.com.br/produto/${x.code}/${x.friendlyName}`, titulo: limpar(x.name), preco: x.price,
        foto: x.image || x.images?.[0] || null, ean: null, vendedor: x.sellerName || 'Kabum',
      }));
    },
  },
};

export function acharLoja(url) {
  try { new URL(url); } catch { return null; }
  return Object.values(lojas).find(l => l.reconhece(url)) || null;
}

export const lojasSuportadas = Object.values(lojas).map(l => l.nome);

// Procura o mesmo produto nas lojas que permitem busca, menos as que já estão no produto.
// Resultado por "nome parecido" precisa ser confirmado pela pessoa antes de entrar.
export async function procurarEmOutrasLojas({ ean, titulo }, lojasJa = []) {
  const alvo = Object.values(lojas).filter(l => l.buscar && !lojasJa.includes(l.nome));
  const resultados = await Promise.all(alvo.map(l => l.buscar({ ean, titulo }).catch(() => [])));
  // Resultados por nome: fica só o que se parece de verdade (até 2 por loja, mais parecidos primeiro)
  return resultados.flatMap(lista => lista
    .map(r => ({ ...r, parecido: r.como === 'mesmo código de barras' ? 1 : semelhanca(titulo, r.titulo) }))
    .filter(r => r.parecido >= 0.5)
    .sort((a, b) => b.parecido - a.parecido)
    .slice(0, 2));
}

const palavras = t => new Set(t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/(\d)\s+(ml|g|mg|kg|l)\b/g, '$1$2').split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !['de', 'da', 'do', 'com', 'para', 'sem', 'e'].includes(w)));
// Palavras que aparecem em todo produto do tipo e não dizem nada sobre a marca/modelo
const GENERICAS = new Set(['protetor', 'solar', 'corporal', 'facial', 'fps', 'kit', 'ml', 'gel', 'creme', 'loção', 'locao', 'hidratante', 'shampoo', 'condicionador', 'perfume', 'edp', 'edt', 'eau', 'parfum', 'toilette', 'feminino', 'masculino', 'unissex', 'cor', 'preto', 'branco', 'tamanho', 'un', 'unidade', 'unidades', 'novo', 'original', 'oferta', 'celular', 'smartphone', 'tenis', 'camiseta', 'calca', 'vestido', 'base', 'batom', 'oleo', 'serum', 'sabonete', 'liquido', 'em', 'no', 'na', 'os', 'as', 'por', 'aerossol', 'aerosol', 'spray', 'rosto', 'corpo', 'bisnaga', 'frasco', 'refil', 'pote', 'tubo', 'ativo']);
const marcantes = t => [...palavras(t)].filter(w => !GENERICAS.has(w) && !/^\d/.test(w));
// Parte das palavras do nome que aparecem nos dois (0 a 1). Se a marca/modelo não bate, é 0.
export function semelhanca(a, b) {
  const A = palavras(a), B = palavras(b);
  if (!A.size || !B.size) return 0;
  const ma = marcantes(a).slice(0, 3);
  if (ma.length && ma.filter(w => B.has(w)).length < Math.min(2, ma.length)) return 0;
  // Código de modelo (A16, S26, X940...): se o original tem, o outro precisa ter também
  const modelos = [...A].filter(w => /^[a-z]{1,4}\d{1,4}[a-z]?$/.test(w) && !/^(fps|spf|ml|mg|kg|gb|tb)/.test(w));
  if (modelos.length && !modelos.some(w => B.has(w))) return 0;
  let comum = 0; for (const w of A) if (B.has(w)) comum++;
  return comum / Math.min(A.size, B.size);
}

export const lojasComBusca = Object.values(lojas).filter(l => l.buscar).map(l => l.nome);

// Lojas que bloqueiam a nuvem: quem pesquisa nelas é o computador (ponte).
export const PESQUISA_NO_COMPUTADOR = ['Kabum'];
export const lojasComPesquisa = Object.values(lojas).filter(l => l.pesquisar).map(l => l.nome);

// Pesquisa por texto em várias lojas ao mesmo tempo. so: só essas lojas; sem: menos essas.
export async function pesquisarLojas(termo, { so = null, sem = [], n = 6 } = {}) {
  const alvo = Object.values(lojas).filter(l => l.pesquisar && (!so || so.includes(l.nome)) && !sem.includes(l.nome));
  const listas = await Promise.all(alvo.map(l => l.pesquisar(termo, n).catch(() => [])));
  return listas.flat();
}

// O resultado tem a ver com o que a pessoa escreveu? (pelo menos ~60% das palavras)
export function combina(termo, titulo) {
  const T = [...palavras(termo)], B = palavras(titulo);
  if (!T.length) return false;
  return T.filter(w => B.has(w) || [...B].some(b => b.startsWith(w) && w.length >= 4)).length >= Math.ceil(T.length * 0.6);
}

// Links curtos (a.co, amzn.to...) e texto colado com o link no meio: devolve o link de verdade.
export async function resolverLink(texto) {
  const m = String(texto || '').match(/https?:\/\/[^\s"'<>]+/);
  if (!m) return null;
  let url = m[0].replace(/[),.;!]+$/, '');
  if (/^https?:\/\/(a\.co|amzn\.to|amzn\.eu|bit\.ly|tinyurl\.com|shre\.ink|mercadolivre\.com\/sec)\//i.test(url)) {
    try { const r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) }); url = r.url || url; } catch {}
  }
  return url;
}
