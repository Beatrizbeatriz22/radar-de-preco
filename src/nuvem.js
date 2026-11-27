// Lógica da versão na nuvem (Supabase). Só usa fetch, então roda tanto no Node
// (verificador no GitHub) quanto no Deno (função da nuvem do Supabase).
import { acharLoja, lojasSuportadas, procurarEmOutrasLojas, pesquisarLojas, PESQUISA_NO_COMPUTADOR, combina, resolverLink } from './lojas.js';
import { avisosNovos, melhorSerie } from '../public/lib/analise.js';

const erro = (status, msg) => Object.assign(new Error(msg), { status });

// Contas que rodam o "Radar no computador" para todo mundo (lê as lojas que bloqueiam a nuvem).
export const CONTAS_PONTE = ['beatriz@radardepreco.local'];

// Cliente mínimo do banco (API REST do Supabase), com a chave de serviço.
export function criarBanco(url, chave) {
  // Chaves antigas do Supabase são JWT (eyJ...) e vão também no Authorization; as novas (sb_secret_...) só no apikey.
  const base = { apikey: chave, 'Content-Type': 'application/json', ...(chave.startsWith('eyJ') ? { Authorization: `Bearer ${chave}` } : {}) };
  async function req(metodo, caminho, corpo, prefer) {
    const r = await fetch(`${url}/rest/v1/${caminho}`, {
      method: metodo, headers: prefer ? { ...base, Prefer: prefer } : base, body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!r.ok) throw Object.assign(new Error(`Banco respondeu ${r.status}: ${(await r.text()).slice(0, 300)}`), { codigoBanco: r.status });
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

// A loja recusou a nuvem (403/503): daí em diante quem lê é o computador.
export const lojaBloqueou = e => /bloqueou|verificação de robô/i.test(e?.message || '');
const MSG_COMPUTADOR = 'Essa loja não deixa a nuvem ler. O preço vem do Radar no computador.';

export async function verificarOferta(db, oferta) {
  const loja = acharLoja(oferta.link);
  if (!loja) throw new Error('Loja não suportada.');
  try {
    return await registrarLeitura(db, oferta, await loja.ler(oferta.link));
  } catch (e) {
    const bloqueou = lojaBloqueou(e);
    await db.atualizar('ofertas', `id=eq.${oferta.id}`, { ultima_verificacao: new Date().toISOString(), ultimo_erro: bloqueou ? MSG_COMPUTADOR : e.message, ...(bloqueou ? { so_computador: true } : {}) });
    throw e;
  }
}

async function lerLink(texto) {
  const link = await resolverLink(texto);
  let url;
  try { url = new URL(String(link || '').trim()); } catch { throw erro(400, 'Não achei um link aí. Cole o link do produto ou escreva o que você quer.'); }
  const loja = acharLoja(url.href);
  if (!loja) throw erro(400, `Essa loja (${url.hostname.replace(/^www\./, '')}) ainda não funciona no app. Tente escrever o nome do produto para eu procurar nas lojas que funcionam.`);
  const linkFinal = loja.normalizar(url.href);
  try { return [linkFinal, await loja.ler(linkFinal)]; } catch (e) {
    // Loja que bloqueia a nuvem: o produto entra assim mesmo e o computador lê depois.
    if (lojaBloqueou(e)) return [linkFinal, null, loja.nome];
    throw erro(502, e.message);
  }
}

async function produtoDo(db, usuario, produtoId) {
  const [p] = await db.ler('produtos', `id=eq.${Number(produtoId)}&usuario=eq.${usuario}`);
  if (!p) throw erro(404, 'Produto não encontrado.');
  return p;
}
async function ofertaComLink(db, usuario, link) {
  return (await db.ler('ofertas', `usuario=eq.${usuario}&link=eq.${encodeURIComponent(link)}&select=id,produto_id`))[0] || null;
}
async function criarOferta(db, usuario, produtoId, link, lido, nomeLoja) {
  if (!lido) { // loja bloqueou a nuvem: fica esperando o computador
    await db.inserir('ofertas', [{ produto_id: produtoId, usuario, link, loja: nomeLoja, so_computador: true, ultimo_erro: MSG_COMPUTADOR }]);
    return;
  }
  const [o] = await db.inserir('ofertas', [{ produto_id: produtoId, usuario, link, loja: lido.loja, titulo: lido.titulo, vendedor: lido.vendedor, ean: lido.ean ?? null }]);
  await registrarLeitura(db, o, lido);
}
const tituloEsperando = loja => `Produto da ${loja} (esperando o Radar do computador)`;
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const txt = (v, n) => (v == null ? null : String(v).slice(0, n));
// Foto de lembrete: imagem pequena que a tela já reduziu (data:image/jpeg;base64,...), até ~200 KB
const fotoLembrete = f => (typeof f === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f) && f.length < 280000 ? f : null);
function faixa(precoAlvo, precoMin) {
  let max = num(precoAlvo), min = num(precoMin);
  if (!max && min) { max = min; min = null; }
  if (min && max && min > max) [min, max] = [max, min];
  if (min === max) min = null;
  return { preco_alvo: max, preco_min: min };
}

// ---- Ações pedidas pela tela (a função da nuvem já conferiu quem é a pessoa) ----

export async function adicionarProduto(db, usuario, { link, precoAlvo, precoMin, fotoLembrete: foto, dica }) {
  const [linkFinal, lidoNuvem, nomeLoja] = await lerLink(link);
  const ja = await ofertaComLink(db, usuario, linkFinal);
  if (ja) return { produtoId: ja.produto_id, jaExistia: true };
  // Se a loja bloqueou, usa o nome e a foto que a pesquisa já mostrou (o preço vem do computador)
  const lido = lidoNuvem;
  const titulo = lido ? lido.titulo : txt(dica?.titulo, 300) || tituloEsperando(nomeLoja);
  const fotoLoja = lido?.foto ?? (/^https:\/\//.test(dica?.foto || '') ? txt(dica.foto, 1000) : null);
  const [p] = await db.inserir('produtos', [{ usuario, titulo, foto: fotoLoja, ean: lido?.ean ?? null, ...faixa(precoAlvo, precoMin), foto_lembrete: fotoLembrete(foto) }]);
  await criarOferta(db, usuario, p.id, linkFinal, lido, nomeLoja);
  return { produtoId: p.id, soComputador: !lido };
}

export async function adicionarLoja(db, usuario, { produtoId, link }) {
  const p = await produtoDo(db, usuario, produtoId);
  const [linkFinal, lido, nomeLoja] = await lerLink(link);
  const ja = await ofertaComLink(db, usuario, linkFinal);
  if (ja) { if (ja.produto_id === p.id) return { produtoId: p.id, jaExistia: true }; throw erro(409, 'Esse link já está em outro produto seu.'); }
  await criarOferta(db, usuario, p.id, linkFinal, lido, nomeLoja);
  return { produtoId: p.id, soComputador: !lido };
}

// Vários resultados da pesquisa viram um produto só, com uma loja para cada.
export async function adicionarEscolhidos(db, usuario, { itens = [], precoAlvo, precoMin, fotoLembrete: foto }) {
  itens = itens.filter(i => i?.link).slice(0, 8);
  if (!itens.length) throw erro(400, 'Marque pelo menos um produto.');
  const { produtoId, jaExistia } = await adicionarProduto(db, usuario, { link: itens[0].link, precoAlvo, precoMin, fotoLembrete: foto, dica: itens[0] });
  if (jaExistia) await db.atualizar('produtos', `id=eq.${produtoId}&usuario=eq.${usuario}`, faixa(precoAlvo, precoMin));
  const erros = [];
  for (const i of itens.slice(1)) {
    try { await adicionarLoja(db, usuario, { produtoId, link: i.link }); } catch (e) { erros.push(`${i.loja || 'Loja'}: ${e.message}`); }
  }
  return { produtoId, erros };
}

export async function sugestoes(db, usuario, { produtoId }) {
  const p = await produtoDo(db, usuario, produtoId);
  const ofertas = await db.ler('ofertas', `produto_id=eq.${p.id}&select=loja,ean`);
  const ean = p.ean || ofertas.find(o => o.ean)?.ean || null;
  const lista = await procurarEmOutrasLojas({ ean, titulo: p.busca || p.titulo }, ofertas.map(o => o.loja));
  const meus = new Set((await db.ler('ofertas', `usuario=eq.${usuario}&select=link`)).map(o => o.link));
  return lista.filter(s => !meus.has(s.link));
}

export async function atualizarProduto(db, usuario, { produtoId }) {
  const p = await produtoDo(db, usuario, produtoId);
  const erros = [];
  if (p.modo === 'parecido') { await verificarParecido(db, p); return { erros }; }
  for (const o of await db.ler('ofertas', `produto_id=eq.${p.id}`)) {
    if (o.so_computador) continue; // essa o computador lê
    try { await verificarOferta(db, o); } catch (e) { erros.push(`${o.loja}: ${lojaBloqueou(e) ? 'essa loja só o computador consegue ler.' : e.message}`); }
  }
  return { erros };
}

// ---- Pesquisa por texto ("ps5 slim", "papete feminina bege") ----

const ordenar = (termo, lista) => lista
  .map((r, i) => ({ ...r, combina: combina(termo, r.titulo), i }))
  .sort((a, b) => (b.combina - a.combina) || (a.i - b.i))
  .map(({ i, ...r }) => r);

export async function pesquisar(db, usuario, { termo }) {
  termo = String(termo || '').trim().slice(0, 100);
  if (termo.length < 2) throw erro(400, 'Escreva o que você quer comprar.');
  const resultados = ordenar(termo, await pesquisarLojas(termo, { sem: PESQUISA_NO_COMPUTADOR }));
  const [b] = await db.inserir('buscas', [{ usuario, termo, resultados }]);
  return { buscaId: b.id, resultados, lojasNoComputador: PESQUISA_NO_COMPUTADOR };
}

// "Aceito algo parecido": o app procura de novo a cada conferência e acompanha o mais barato de cada loja.
export async function acompanharParecido(db, usuario, { termo, precoAlvo, precoMin, fotoLembrete: foto }) {
  termo = String(termo || '').trim().slice(0, 100);
  if (termo.length < 2) throw erro(400, 'Escreva o que você quer comprar.');
  const titulo = termo.charAt(0).toUpperCase() + termo.slice(1);
  const [p] = await db.inserir('produtos', [{ usuario, titulo, busca: termo, modo: 'parecido', ...faixa(precoAlvo, precoMin), foto_lembrete: fotoLembrete(foto) }]);
  const { lojas } = await verificarParecido(db, p);
  return { produtoId: p.id, lojas };
}

// Escolhe, em cada loja, o mais barato que combina com o que a pessoa escreveu e grava como a "oferta" daquela loja.
// achados: resultados já pesquisados (o computador manda os da Kabum); se vazio, pesquisa nas lojas da nuvem.
export async function verificarParecido(db, produto, achados = null) {
  const termo = produto.busca || produto.titulo;
  const lista = (achados ?? await pesquisarLojas(termo, { sem: PESQUISA_NO_COMPUTADOR, n: 10 })).filter(r => r.preco > 0 && combina(termo, r.titulo));
  // Tira coisas baratas demais para ser o produto (acessório, capinha...): abaixo de 40% da mediana
  const precos = lista.map(r => r.preco).sort((a, b) => a - b);
  const mediana = precos[Math.floor(precos.length / 2)] || 0;
  const bons = lista.filter(r => r.preco >= mediana * 0.4);
  const porLoja = new Map();
  for (const r of bons) if (!porLoja.has(r.loja) || r.preco < porLoja.get(r.loja).preco) porLoja.set(r.loja, r);
  const ofertas = await db.ler('ofertas', `produto_id=eq.${produto.id}`);
  const avisos = [];
  for (const [loja, r] of porLoja) {
    let o = ofertas.find(x => x.loja === loja);
    try {
      if (!o) [o] = await db.inserir('ofertas', [{ produto_id: produto.id, usuario: produto.usuario, link: r.link, loja, titulo: r.titulo, vendedor: r.vendedor || loja, da_busca: true, so_computador: PESQUISA_NO_COMPUTADOR.includes(loja) }]);
      else if (o.link !== r.link) [o] = await db.atualizar('ofertas', `id=eq.${o.id}`, { link: r.link, titulo: r.titulo });
      avisos.push(...await registrarLeitura(db, o, { preco: r.preco, titulo: r.titulo, foto: r.foto, vendedor: r.vendedor || loja, disponivel: true, loja }));
    } catch (e) { if (e.codigoBanco !== 409) throw e; } // mesmo link já está em outro produto da pessoa: pula
  }
  if (!achados) await db.atualizar('produtos', `id=eq.${produto.id}`, { buscado_em: new Date().toISOString() });
  return { lojas: [...porLoja.keys()], avisos };
}

// ---- Radar no computador (ponte): lê e pesquisa nas lojas que bloqueiam a nuvem ----

// Lista o que o computador precisa ler. A conta da ponte vê de todo mundo; as outras, só as suas.
export async function ponteTarefas(db, usuario, _dados, quem) {
  const filtro = quem?.ponte ? '' : `usuario=eq.${usuario}&`;
  const ofertas = await db.ler('ofertas', `${filtro}so_computador=is.true&da_busca=is.false&select=id,link,loja,ultima_verificacao&order=ultima_verificacao.asc.nullsfirst&limit=500`);
  const desde = new Date(Date.now() - 15 * 60e3).toISOString();
  const buscas = await db.ler('buscas', `${filtro}computador_em=is.null&criado_em=gt.${desde}&select=id,termo&limit=20`);
  const parecidos = await db.ler('produtos', `${filtro}modo=eq.parecido&select=id,busca,titulo,buscado_computador_em&order=buscado_computador_em.asc.nullsfirst&limit=200`);
  return { ofertas, buscas, parecidos, lojas: PESQUISA_NO_COMPUTADOR };
}

async function ofertaPermitida(db, usuario, ofertaId, quem) {
  const [o] = await db.ler('ofertas', `id=eq.${Number(ofertaId)}${quem?.ponte ? '' : `&usuario=eq.${usuario}`}`);
  if (!o) throw erro(404, 'Loja não encontrada.');
  return o;
}
// Avisos para o dono do produto: a ponte recebe as inscrições de notificação dele para mandar o aviso.
async function inscricoesDe(db, dono) {
  return db.ler('inscricoes_push', `usuario=eq.${dono}&select=id,endpoint,chaves`);
}

export async function registrarLeituraComputador(db, usuario, { ofertaId, lido }, quem) {
  const o = await ofertaPermitida(db, usuario, ofertaId, quem);
  const limpo = {
    preco: num(lido?.preco), precoPix: num(lido?.precoPix), disponivel: !!lido?.disponivel,
    titulo: txt(lido?.titulo, 300), foto: /^https:\/\//.test(lido?.foto || '') ? txt(lido.foto, 1000) : null,
    vendedor: txt(lido?.vendedor, 120), ean: /^\d{8,14}$/.test(lido?.ean || '') ? lido.ean : null,
  };
  const [p] = await db.ler('produtos', `id=eq.${o.produto_id}`);
  if (p && limpo.titulo && p.titulo === tituloEsperando(o.loja)) await db.atualizar('produtos', `id=eq.${p.id}`, { titulo: limpo.titulo });
  const avisos = await registrarLeitura(db, o, limpo);
  return { avisos, inscricoes: avisos.length && quem?.ponte && o.usuario !== usuario ? await inscricoesDe(db, o.usuario) : [] };
}

export async function erroLeituraComputador(db, usuario, { ofertaId, mensagem }, quem) {
  const o = await ofertaPermitida(db, usuario, ofertaId, quem);
  await db.atualizar('ofertas', `id=eq.${o.id}`, { ultima_verificacao: new Date().toISOString(), ultimo_erro: `O computador não conseguiu ler: ${String(mensagem || '').slice(0, 200)}` });
  return { ok: true };
}

const limparAchado = r => ({
  loja: txt(r?.loja, 40), link: /^https:\/\//.test(r?.link || '') ? txt(r.link, 600) : null, titulo: txt(r?.titulo, 300),
  preco: num(r?.preco), foto: /^https:\/\//.test(r?.foto || '') ? txt(r.foto, 1000) : null, vendedor: txt(r?.vendedor, 120),
});
const lojasDoComputador = lista => (Array.isArray(lista) ? lista : []).map(limparAchado).filter(r => r.link && r.titulo && r.preco && PESQUISA_NO_COMPUTADOR.includes(r.loja) && acharLoja(r.link)?.nome === r.loja).slice(0, 12);

// O computador terminou de pesquisar (Kabum): junta com o que a nuvem já tinha achado.
export async function resultadoBuscaComputador(db, usuario, { buscaId, resultados }, quem) {
  const [b] = await db.ler('buscas', `id=eq.${Number(buscaId)}${quem?.ponte ? '' : `&usuario=eq.${usuario}`}`);
  if (!b) throw erro(404, 'Busca não encontrada.');
  const novos = ordenar(b.termo, lojasDoComputador(resultados));
  await db.atualizar('buscas', `id=eq.${b.id}`, { resultados: [...b.resultados, ...novos], computador_em: new Date().toISOString() });
  return { ok: true };
}

export async function resultadoParecidoComputador(db, usuario, { produtoId, resultados }, quem) {
  const [p] = await db.ler('produtos', `id=eq.${Number(produtoId)}&modo=eq.parecido${quem?.ponte ? '' : `&usuario=eq.${usuario}`}`);
  if (!p) throw erro(404, 'Produto não encontrado.');
  const { avisos } = await verificarParecido(db, p, lojasDoComputador(resultados));
  await db.atualizar('produtos', `id=eq.${p.id}`, { buscado_computador_em: new Date().toISOString() });
  return { avisos, inscricoes: avisos.length && quem?.ponte && p.usuario !== usuario ? await inscricoesDe(db, p.usuario) : [] };
}
