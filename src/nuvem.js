// Lógica da versão na nuvem (Supabase). Só usa fetch, então roda tanto no Node
// (verificador no GitHub) quanto no Deno (função da nuvem do Supabase).
import { acharLoja, lojasSuportadas, procurarEmOutrasLojas } from './lojas.js';
import { avisosNovos, melhorSerie } from '../public/lib/analise.js';

const erro = (status, msg) => Object.assign(new Error(msg), { status });

// Cliente mínimo do banco (API REST do Supabase), com a chave de serviço.
export function criarBanco(url, chave) {
  // Chaves antigas do Supabase são JWT (eyJ...) e vão também no Authorization; as novas (sb_secret_...) só no apikey.
  const base = { apikey: chave, 'Content-Type': 'application/json', ...(chave.startsWith('eyJ') ? { Authorization: `Bearer ${chave}` } : {}) };
  async function req(metodo, caminho, corpo, prefer) {
    const r = await fetch(`${url}/rest/v1/${caminho}`, {
      method: metodo, headers: prefer ? { ...base, Prefer: prefer } : base, body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!r.ok) throw new Error(`Banco respondeu ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  return {
    ler: (tabela, q = '') => req('GET', `${tabela}?${q}`),
    inserir: (tabela, linhas) => req('POST', tabela, linhas, 'return=representation'),
    atualizar: (tabela, q, dados) => req('PATCH', `${tabela}?${q}`, dados, 'return=representation'),
    apagar: (tabela, q) => req('DELETE', `${tabela}?${q}`),
  };
}

export async function historicoDoProduto(db, produtoId) {
  const ofertas = await db.ler('ofertas', `produto_id=eq.${produtoId}&select=id,loja`);
  if (!ofertas.length) return [];
  const precos = await db.ler('precos', `oferta_id=in.(${ofertas.map(o => o.id).join(',')})&order=quando.asc&select=oferta_id,quando,preco,disponivel`);
  return melhorSerie(ofertas.map(o => ({ loja: o.loja, historico: precos.filter(p => p.oferta_id === o.id) })));
}

// Grava uma leitura de preço e devolve os avisos que ela gerou.
export async function registrarLeitura(db, oferta, lido) {
  const [produto] = await db.ler('produtos', `id=eq.${oferta.produto_id}`);
  const antes = await historicoDoProduto(db, produto.id);
  const agora = new Date().toISOString();
  await db.inserir('precos', [{ oferta_id: oferta.id, usuario: oferta.usuario, quando: agora, preco: lido.preco, preco_pix: lido.precoPix ?? null, disponivel: !!(lido.disponivel && lido.preco != null) }]);
  await db.atualizar('ofertas', `id=eq.${oferta.id}`, { ultima_verificacao: agora, ultimo_erro: null, vendedor: lido.vendedor, titulo: lido.titulo || oferta.titulo, ean: lido.ean || oferta.ean });
  const extra = {};
  if (!produto.ean && lido.ean) extra.ean = lido.ean;
  if (!produto.foto && lido.foto) extra.foto = lido.foto;
  if (Object.keys(extra).length) await db.atualizar('produtos', `id=eq.${produto.id}`, extra);
  const depois = await historicoDoProduto(db, produto.id);
  const novo = depois[depois.length - 1];
  const avisos = novo ? avisosNovos(produto, antes, novo) : [];
  if (avisos.length) await db.inserir('avisos', avisos.map(a => ({ produto_id: produto.id, usuario: produto.usuario, titulo: a.titulo, texto: a.texto })));
  return avisos.map(a => ({ ...a, usuario: produto.usuario, produtoId: produto.id }));
}

export async function verificarOferta(db, oferta) {
  const loja = acharLoja(oferta.link);
  if (!loja) throw new Error('Loja não suportada.');
  try {
    return await registrarLeitura(db, oferta, await loja.ler(oferta.link));
  } catch (e) {
    await db.atualizar('ofertas', `id=eq.${oferta.id}`, { ultima_verificacao: new Date().toISOString(), ultimo_erro: e.message });
    throw e;
  }
}

async function lerLink(link) {
  let url;
  try { url = new URL(String(link || '').trim()); } catch { throw erro(400, 'Cole o link completo do produto, começando com https://'); }
  const loja = acharLoja(url.href);
  if (!loja) throw erro(400, `Essa loja ainda não funciona no app. Por enquanto ele lê: ${lojasSuportadas.join(', ')}.`);
  const linkFinal = loja.normalizar(url.href);
  try { return [linkFinal, await loja.ler(linkFinal)]; } catch (e) { throw erro(502, e.message); }
}

async function produtoDo(db, usuario, produtoId) {
  const [p] = await db.ler('produtos', `id=eq.${Number(produtoId)}&usuario=eq.${usuario}`);
  if (!p) throw erro(404, 'Produto não encontrado.');
  return p;
}
async function linkJaExiste(db, usuario, link) {
  return (await db.ler('ofertas', `usuario=eq.${usuario}&link=eq.${encodeURIComponent(link)}&select=id`)).length > 0;
}
async function criarOferta(db, usuario, produtoId, link, lido) {
  const [o] = await db.inserir('ofertas', [{ produto_id: produtoId, usuario, link, loja: lido.loja, titulo: lido.titulo, vendedor: lido.vendedor, ean: lido.ean ?? null }]);
  await registrarLeitura(db, o, lido);
}

// ---- Ações pedidas pela tela (a função da nuvem já conferiu quem é a pessoa) ----

export async function adicionarProduto(db, usuario, { link, precoAlvo }) {
  const [linkFinal, lido] = await lerLink(link);
  if (await linkJaExiste(db, usuario, linkFinal)) throw erro(409, 'Você já está acompanhando esse link.');
  const [p] = await db.inserir('produtos', [{ usuario, titulo: lido.titulo, foto: lido.foto, ean: lido.ean ?? null, preco_alvo: precoAlvo ? Number(precoAlvo) : null }]);
  await criarOferta(db, usuario, p.id, linkFinal, lido);
  return { produtoId: p.id };
}

export async function adicionarLoja(db, usuario, { produtoId, link }) {
  const p = await produtoDo(db, usuario, produtoId);
  const [linkFinal, lido] = await lerLink(link);
  if (await linkJaExiste(db, usuario, linkFinal)) throw erro(409, 'Esse link já está no app.');
  await criarOferta(db, usuario, p.id, linkFinal, lido);
  return { produtoId: p.id };
}

export async function sugestoes(db, usuario, { produtoId }) {
  const p = await produtoDo(db, usuario, produtoId);
  const ofertas = await db.ler('ofertas', `produto_id=eq.${p.id}&select=loja,ean`);
  const ean = p.ean || ofertas.find(o => o.ean)?.ean || null;
  const lista = await procurarEmOutrasLojas({ ean, titulo: p.titulo }, ofertas.map(o => o.loja));
  const meus = new Set((await db.ler('ofertas', `usuario=eq.${usuario}&select=link`)).map(o => o.link));
  return lista.filter(s => !meus.has(s.link));
}

export async function atualizarProduto(db, usuario, { produtoId }) {
  const p = await produtoDo(db, usuario, produtoId);
  const erros = [];
  for (const o of await db.ler('ofertas', `produto_id=eq.${p.id}`)) {
    try { await verificarOferta(db, o); } catch (e) { erros.push(`${o.loja}: ${e.message}`); }
  }
  return { erros };
}
