// Tela do Radar de Preço.
// Funciona de dois jeitos: "local" (servidor no computador, /api/...) ou "nuvem" (Supabase + login com Google),
// conforme o config.js. O resto da tela não sabe a diferença: tudo passa por `dados`.
import { montarProduto } from './lib/montar.js';
import { intervaloAtual } from './lib/analise.js';
import { LOJAS, LOJAS_COM_BUSCA } from './lib/lojas-info.js';

const CFG = window.RADAR_CONFIG || {};
const NUVEM = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
const $ = id => document.getElementById(id);
const brl = v => v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtData = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '');
const CORES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];

const state = { produtos: [], sel: null, intervaloHoras: 4, lojas: [], lojasComBusca: [], sugestoes: null, buscando: false };

async function api(metodo, caminho, dado) {
  const r = await fetch(caminho, { method: metodo, headers: dado ? { 'Content-Type': 'application/json' } : {}, body: dado ? JSON.stringify(dado) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.erro || 'Algo deu errado.'); e.dado = j; throw e; }
  return j;
}

/* ---------- Camada de dados ---------- */
const dadosLocal = {
  status: () => api('GET', '/api/status'),
  produtos: () => api('GET', '/api/produtos'),
  adicionarProduto: (link, precoAlvo) => api('POST', '/api/produtos', { link, precoAlvo }),
  adicionarLoja: (id, link) => api('POST', `/api/produtos/${id}/ofertas`, { link }),
  tirarLoja: ofertaId => api('DELETE', `/api/ofertas/${ofertaId}`),
  sugestoes: id => api('GET', `/api/produtos/${id}/sugestoes`),
  atualizar: id => api('POST', `/api/produtos/${id}/atualizar`),
  salvarAlvo: (id, v) => api('PATCH', `/api/produtos/${id}`, { precoAlvo: v }),
  remover: id => api('DELETE', `/api/produtos/${id}`),
  avisos: depois => api('GET', `/api/avisos?depois=${depois}`),
};

let sb = null; // cliente do Supabase (só na nuvem)
const falhou = (error, padrao) => { if (error) throw new Error(error.message || padrao); };
async function funcao(acao, corpo) {
  const { data, error } = await sb.functions.invoke('radar', { body: { acao, ...corpo } });
  if (error) {
    let msg = 'Não deu para falar com a nuvem. Tente de novo.';
    try { msg = (await error.context.json()).erro || msg; } catch {}
    throw new Error(msg);
  }
  return data;
}
async function produtosNuvem() {
  const { data, error } = await sb.from('produtos').select('*, ofertas(*, precos(quando, preco, preco_pix, disponivel))').order('criado_em', { ascending: false });
  falhou(error, 'Não deu para carregar seus produtos.');
  return data.map(p => montarProduto(p, p.ofertas.sort((a, b) => a.id - b.id)
    .map(o => ({ ...o, historico: o.precos.sort((a, b) => (a.quando < b.quando ? -1 : 1)) }))));
}
const umProduto = async id => (await produtosNuvem()).find(p => p.id === id);
const dadosNuvem = {
  status: async () => ({ lojas: LOJAS, lojasComBusca: LOJAS_COM_BUSCA, intervaloHoras: intervaloAtual() / 36e5 }),
  produtos: produtosNuvem,
  adicionarProduto: async (link, precoAlvo) => umProduto((await funcao('adicionarProduto', { link, precoAlvo })).produtoId),
  adicionarLoja: async (id, link) => { await funcao('adicionarLoja', { produtoId: id, link }); return umProduto(id); },
  tirarLoja: async ofertaId => {
    const p = state.produtos.find(x => x.ofertas.some(o => o.id === ofertaId));
    if (p.ofertas.length === 1) throw new Error('Essa é a única loja do produto. Para tirar, use “Parar de acompanhar”.');
    const { error } = await sb.from('ofertas').delete().eq('id', ofertaId); falhou(error, 'Não deu para tirar a loja.');
    return umProduto(p.id);
  },
  sugestoes: id => funcao('sugestoes', { produtoId: id }),
  atualizar: async id => { const r = await funcao('atualizarProduto', { produtoId: id }); return { produto: await umProduto(id), erros: r.erros }; },
  salvarAlvo: async (id, v) => { const { error } = await sb.from('produtos').update({ preco_alvo: v ? Number(v) : null }).eq('id', id); falhou(error, 'Não deu para salvar.'); return umProduto(id); },
  remover: async id => { const { error } = await sb.from('produtos').delete().eq('id', id); falhou(error, 'Não deu para remover.'); },
  avisos: async depois => { const { data, error } = await sb.from('avisos').select('*').gt('id', depois).order('id', { ascending: false }).limit(20); falhou(error); return data; },
};
const dados = NUVEM ? dadosNuvem : dadosLocal;

function ha(iso) {
  if (!iso) return 'ainda não';
  const m = Math.round((Date.now() - new Date(iso)) / 6e4);
  return m < 1 ? 'agora mesmo' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : `há ${Math.round(m / 1440)} dias`;
}
function proxima(iso) {
  if (!iso) return 'em instantes';
  const m = Math.round((new Date(iso).getTime() + state.intervaloHoras * 36e5 - Date.now()) / 6e4);
  return m <= 10 ? 'em instantes' : m < 60 ? `em ${m} min` : `em cerca de ${Math.round(m / 60)} h`;
}
const img = src => src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="muted small">sem foto</span>';
const melhor = p => p.ofertas.find(o => o.id === p.melhorOferta);

function variacao(p) {
  const v = p.historico.filter(h => h.preco != null && h.disponivel);
  if (v.length < 2) return '';
  const a = v[v.length - 2].preco, b = v[v.length - 1].preco;
  if (a === b) return '<span class="delta muted">sem mudança</span>';
  const pct = (b / a - 1) * 100;
  return `<span class="delta ${pct < 0 ? 'down' : 'up'}">${pct < 0 ? '▼' : '▲'} ${Math.abs(pct).toFixed(1).replace('.', ',')}%</span>`;
}

/* ---------- Lista ---------- */
function renderLista() {
  $('count').textContent = state.produtos.length ? `Acompanhando · ${state.produtos.length} ${state.produtos.length === 1 ? 'produto' : 'produtos'}` : '';
  if (!state.produtos.length) {
    $('items').innerHTML = '<div class="empty">Nenhum produto ainda.<br>Cole acima o link de um produto de uma das lojas da lista para começar.</div>';
    return;
  }
  $('items').innerHTML = state.produtos.map(p => {
    const m = melhor(p), n = p.ofertas.length, erro = p.ofertas.some(o => o.ultimoErro);
    return `
    <button class="item" type="button" data-id="${p.id}" aria-current="${p.id === state.sel}">
      <div class="thumb">${img(p.foto)}</div>
      <div style="min-width:0"><div class="item-name">${esc(p.titulo)}</div>
        <div class="item-sub">${n} ${n === 1 ? 'loja' : 'lojas'}${m && n > 1 ? ` · melhor na ${esc(m.loja)}` : n === 1 ? ` · ${esc(p.ofertas[0].loja)}` : ''}${erro ? ' · <span style="color:var(--bad)">erro em alguma loja</span>' : ''}</div>
        <span class="pill ${p.analise.tipo}"><span class="dot"></span>${esc(p.analise.curto)}</span></div>
      <div class="item-price"><span class="num">${brl(m?.atual)}</span>${variacao(p)}</div>
    </button>`;
  }).join('');
}
$('items').addEventListener('click', e => {
  const b = e.target.closest('.item'); if (!b) return;
  state.sel = Number(b.dataset.id); state.sugestoes = null; $('shell').dataset.view = 'detail';
  renderLista(); renderDetalhe(); window.scrollTo({ top: 0 });
});

/* ---------- Detalhe ---------- */
function renderDetalhe() {
  const p = state.produtos.find(x => x.id === state.sel);
  if (!p) { $('detail').innerHTML = ''; return; }
  const a = p.analise, m = melhor(p);
  const icon = { bom: '✓', ruim: '!', atencao: '…', info: 'i' }[a.tipo];
  const ordenadas = [...p.ofertas].sort((x, y) => (x.atual ?? Infinity) - (y.atual ?? Infinity));
  const cor = o => CORES[p.ofertas.indexOf(o) % CORES.length];
  $('detail').innerHTML = `
  <article class="detail">
    <button class="back" type="button" id="back">← Voltar à lista</button>
    <div class="d-head">
      <div class="d-title"><div class="photo">${img(p.foto)}</div>
        <div style="min-width:0"><span class="eyebrow">${p.ofertas.length} ${p.ofertas.length === 1 ? 'loja' : 'lojas'}${p.ean ? ` · código de barras ${esc(p.ean)}` : ''}</span>
          <h2>${esc(p.titulo)}</h2>
          <div class="updated"><span>Conferido ${ha(p.ultimaVerificacao)} · próxima ${proxima(p.ultimaVerificacao)}</span>
            <button type="button" class="link-btn" id="refresh">Atualizar agora</button></div>
        </div></div>
      <div style="text-align:right"><span class="eyebrow">Melhor preço agora</span><div class="num" style="font-size:26px;font-weight:600">${brl(m?.atual)}</div>
        ${m ? `<div class="muted small">na ${esc(m.loja)}${m.pix && m.pix < m.atual ? ` · ${brl(m.pix)} no Pix` : ''}</div>` : ''}</div>
    </div>
    <div class="verdict ${a.tipo}"><div class="v-icon">${icon}</div><strong>${esc(a.titulo)}</strong><span>${esc(a.texto)}</span></div>
    ${a.atual != null ? `<div class="stats">
      <div class="stat"><span class="eyebrow">Menor visto</span><span class="num">${brl(a.menor)}</span></div>
      <div class="stat"><span class="eyebrow">Média 30 dias</span><span class="num">${brl(a.media30)}</span></div>
      <div class="stat"><span class="eyebrow">Maior visto</span><span class="num">${brl(a.maior)}</span></div>
      <div class="stat"><span class="eyebrow">Leituras</span><span class="num">${p.ofertas.reduce((s, o) => s + o.historico.length, 0)}</span></div></div>` : ''}

    <section><div class="section-h"><h3>Comparar lojas</h3><span class="muted small">menor preço primeiro</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Loja e vendedor</th><th>Quem vende</th><th class="r">Menor visto</th><th class="r">Agora</th><th></th></tr></thead>
        <tbody>${ordenadas.map(o => `
          <tr class="${o.id === p.melhorOferta && p.ofertas.length > 1 ? 'best' : ''}">
            <td><span class="sw" style="background:${cor(o)}"></span><strong>${esc(o.loja)}</strong>${o.id === p.melhorOferta && p.ofertas.length > 1 ? ' <span class="pill bom">Melhor preço</span>' : ''}
              <div class="muted small">${esc(o.titulo || '')}</div>
              ${o.ultimoErro ? `<div class="erro-mini">Última leitura falhou: ${esc(o.ultimoErro)}</div>` : ''}</td>
            <td><span class="pill ${o.confianca.nivel}"><span class="dot"></span>${o.confianca.nivel === 'bom' ? 'Loja oficial' : 'Atenção'}</span><div class="muted small" style="max-width:30ch">${esc(o.confianca.texto)}</div></td>
            <td class="price muted">${brl(o.menor)}</td>
            <td class="price">${o.disponivel ? brl(o.atual) : '<span class="muted">indisponível</span>'}${o.pix && o.pix < o.atual ? `<div class="muted small">${brl(o.pix)} no Pix</div>` : ''}</td>
            <td class="acoes"><a class="link-btn" href="${esc(o.link)}" target="_blank" rel="noopener">Ver ↗</a>${p.ofertas.length > 1 ? `<button class="x" type="button" data-tirar="${o.id}" aria-label="Tirar ${esc(o.loja)} deste produto" title="Tirar esta loja">×</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      <div class="add-loja">
        <form class="field" id="formLoja"><input id="linkLoja" type="url" required placeholder="Cole o link do mesmo produto em outra loja" aria-label="Link do produto em outra loja" style="flex:1;min-width:220px;width:auto;font-family:var(--f-body)"><button class="btn" type="submit" id="btnLoja">Adicionar loja</button></form>
        <button class="btn primary" type="button" id="procurar" ${state.buscando ? 'disabled' : ''}>${state.buscando ? 'Procurando nas lojas…' : 'Procurar em outras lojas'}</button>
        <p class="erro" id="erroLoja" hidden></p>
        ${renderSugestoes(p)}
      </div>
    </section>

    <section><div class="section-h"><h3>Histórico de preço</h3><span class="muted small">desde ${fmtData(p.criadoEm)}</span></div>
      <div class="chart-wrap" id="chart"></div>
      <div class="legend">${p.ofertas.map(o => `<span><span class="sw" style="background:${cor(o)}"></span>${esc(o.loja)}</span>`).join('')}</div></section>

    <section><div class="section-h"><h3>Quando me avisar</h3></div>
      <div class="field"><label for="alvo">Preço que eu pagaria</label><input id="alvo" type="number" min="0" step="0.01" value="${p.precoAlvo ?? ''}" placeholder="R$"><button class="btn" id="salvarAlvo" type="button">Salvar</button></div>
      <p class="muted small" style="margin:8px 0 0">O aviso vale para qualquer loja deste produto. Também avisamos quando o melhor preço cair 10% ou mais, e quando bater o menor preço já visto (depois de 7 dias de histórico).</p>
    </section>
    <div class="actions"><button class="btn danger" id="remover" type="button">Parar de acompanhar</button></div>
  </article>`;
  desenharGrafico(p, cor);
}

function renderSugestoes(p) {
  const s = state.sugestoes;
  if (!s || s.produto !== p.id) return '';
  if (!s.lista.length) return `<p class="muted small">Não achei esse produto em ${esc(state.lojasComBusca.filter(l => !p.ofertas.some(o => o.loja === l)).join(', ') || 'outras lojas')}. Se você achar, cole o link acima.</p>`;
  return `<div class="sugestoes"><p class="muted small" style="margin:0">Achei estes. Confira se é o mesmo produto (tamanho, cor, FPS) antes de adicionar:</p>
    ${s.lista.map((x, i) => `
      <div class="sug">
        <div class="thumb">${img(x.foto)}</div>
        <div style="min-width:0"><strong>${esc(x.loja)}</strong> <span class="pill ${x.como === 'mesmo código de barras' ? 'bom' : 'atencao'}">${x.como === 'mesmo código de barras' ? 'Mesmo código de barras' : 'Nome parecido, confira'}</span>
          <div class="small" style="line-height:1.3">${esc(x.titulo)}</div>
          <a class="link-btn small" href="${esc(x.link)}" target="_blank" rel="noopener">Ver na loja ↗</a></div>
        <div style="text-align:right"><div class="num" style="font-weight:600">${brl(x.preco)}</div><button class="btn" type="button" data-sug="${i}">É esse, adicionar</button></div>
      </div>`).join('')}</div>`;
}

function desenharGrafico(p, cor) {
  const series = p.ofertas.map(o => ({ o, pts: o.historico.filter(h => h.preco != null && h.disponivel).map(h => ({ t: new Date(h.quando).getTime(), v: h.preco })) })).filter(s => s.pts.length);
  const todos = series.flatMap(s => s.pts);
  const box = $('chart');
  if (todos.length < 2) { box.innerHTML = '<p class="muted" style="margin:0">O gráfico aparece a partir da segunda leitura. O app confere sozinho a cada ' + state.intervaloHoras + ' h.</p>'; return; }
  const W = 680, H = 240, L = 70, R = 14, T = 14, B = 28;
  const t0 = Math.min(...todos.map(x => x.t)), t1 = Math.max(Date.now(), ...todos.map(x => x.t));
  let mn = Math.min(...todos.map(x => x.v)), mx = Math.max(...todos.map(x => x.v));
  const pad = (mx - mn) * 0.15 || mx * 0.05; mn -= pad; mx += pad;
  const x = t => L + (t - t0) / ((t1 - t0) || 1) * (W - L - R);
  const y = v => T + (1 - (v - mn) / (mx - mn)) * (H - T - B);
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = mn + (mx - mn) * i / 3;
    g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)" font-family="IBM Plex Mono, monospace">${brl(v).replace('R$', '').trim()}</text>`;
  }
  g += `<text x="${L}" y="${H - 8}" font-size="11" fill="var(--muted)">${fmtData(t0)}</text><text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--muted)">agora</text>`;
  if (p.precoAlvo && p.precoAlvo > mn && p.precoAlvo < mx) g += `<line x1="${L}" x2="${W - R}" y1="${y(p.precoAlvo)}" y2="${y(p.precoAlvo)}" stroke="var(--accent)" stroke-dasharray="4 4"/><text x="${W - R}" y="${y(p.precoAlvo) - 5}" text-anchor="end" font-size="11" fill="var(--accent)" font-weight="700">seu preço-alvo</text>`;
  for (const { o, pts } of series) {
    // Linha em degraus: o preço vale até a próxima leitura; segue até "agora" se a loja continua disponível
    let d = `M${x(pts[0].t)} ${y(pts[0].v)}`;
    for (let i = 1; i < pts.length; i++) d += `H${x(pts[i].t)}V${y(pts[i].v)}`;
    if (o.disponivel) d += `H${x(t1)}`;
    g += `<path d="${d}" fill="none" stroke="${cor(o)}" stroke-width="2.2" stroke-linejoin="round"/>`;
    const u = pts[pts.length - 1];
    g += `<circle cx="${x(o.disponivel ? t1 : u.t)}" cy="${y(u.v)}" r="4" fill="${cor(o)}" stroke="var(--surface)" stroke-width="2"/>`;
  }
  g += `<line id="hov" y1="${T}" y2="${H - B}" stroke="var(--muted)" visibility="hidden"/><rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico do preço em cada loja ao longo do tempo">${g}</svg><div class="tip" id="tip" hidden></div>`;
  const svg = box.querySelector('svg'), tip = $('tip'), hov = svg.querySelector('#hov'), hit = svg.querySelector('#hit');
  const mover = ev => {
    const r = svg.getBoundingClientRect(), cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const t = t0 + ((cx - r.left) / r.width * W - L) / (W - L - R) * (t1 - t0);
    const linhas = series.map(({ o, pts }) => { let k = -1; for (let i = 0; i < pts.length; i++) if (pts[i].t <= t) k = i; return k < 0 ? null : { o, v: pts[k].v }; })
      .filter(Boolean).sort((a, b) => a.v - b.v);
    if (!linhas.length) return sair();
    hov.setAttribute('x1', x(t)); hov.setAttribute('x2', x(t)); hov.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<b>${fmtData(t)}</b>` + linhas.map(l => `<div><span><span style="color:${cor(l.o)}">●</span> ${esc(l.o.loja)}</span><span class="num">${brl(l.v)}</span></div>`).join('');
    tip.style.left = Math.max(100, Math.min(r.width - 100, x(t) / W * r.width)) + 'px'; tip.style.top = '0';
  };
  const sair = () => { tip.hidden = true; hov.setAttribute('visibility', 'hidden'); };
  hit.addEventListener('mousemove', mover); hit.addEventListener('mouseleave', sair);
  hit.addEventListener('touchmove', mover, { passive: true }); hit.addEventListener('touchend', sair);
}

let confirmarRemocao = false;
$('detail').addEventListener('click', async e => {
  const p = state.produtos.find(x => x.id === state.sel); if (!p) return;
  const alvo = e.target.closest('button'); if (!alvo) return;
  if (alvo.id === 'back') { $('shell').dataset.view = 'list'; return; }
  if (alvo.id === 'refresh') {
    alvo.disabled = true; alvo.textContent = `Conferindo ${p.ofertas.length} ${p.ofertas.length === 1 ? 'loja' : 'lojas'}…`;
    try {
      const r = await dados.atualizar(p.id);
      trocar(r.produto);
      aviso(r.erros.length ? 'Algumas lojas não responderam' : 'Preços conferidos agora', r.erros.length ? r.erros.join(' · ') : p.titulo.slice(0, 70));
    } catch (err) { aviso('Não deu para conferir', err.message); renderDetalhe(); }
    return;
  }
  if (alvo.id === 'procurar') {
    state.buscando = true; renderDetalhe();
    try { state.sugestoes = { produto: p.id, lista: await dados.sugestoes(p.id) }; }
    catch (err) { state.sugestoes = null; aviso('Não deu para procurar', err.message); }
    state.buscando = false; renderDetalhe();
    return;
  }
  if (alvo.dataset.sug !== undefined) {
    const s = state.sugestoes.lista[Number(alvo.dataset.sug)];
    alvo.disabled = true; alvo.textContent = 'Adicionando…';
    try {
      const novo = await dados.adicionarLoja(p.id, s.link);
      state.sugestoes.lista = state.sugestoes.lista.filter(x => x !== s && x.loja !== s.loja);
      trocar(novo); aviso(`${s.loja} adicionada`, `Agora comparando ${novo.ofertas.length} lojas.`);
    } catch (err) { aviso('Não deu para adicionar', err.message); renderDetalhe(); }
    return;
  }
  if (alvo.dataset.tirar) {
    try { trocar(await dados.tirarLoja(Number(alvo.dataset.tirar))); } catch (err) { aviso('Não deu para tirar', err.message); }
    return;
  }
  if (alvo.id === 'salvarAlvo') {
    try { trocar(await dados.salvarAlvo(p.id, $('alvo').value || null)); aviso('Preço-alvo salvo', $('alvo').value ? `Avisamos quando qualquer loja chegar em ${brl($('alvo').value)}.` : 'Sem preço-alvo para esse produto.'); }
    catch (err) { aviso('Não deu para salvar', err.message); }
    return;
  }
  if (alvo.id === 'remover') {
    if (!confirmarRemocao) { confirmarRemocao = true; alvo.textContent = 'Clique de novo para confirmar (apaga o histórico)'; setTimeout(() => { confirmarRemocao = false; if (alvo.isConnected) alvo.textContent = 'Parar de acompanhar'; }, 5000); return; }
    confirmarRemocao = false;
    try { await dados.remover(p.id); } catch (err) { aviso('Não deu para remover', err.message); return; }
    state.produtos = state.produtos.filter(x => x.id !== p.id); state.sel = state.produtos[0]?.id ?? null;
    $('shell').dataset.view = 'list'; renderLista(); renderDetalhe();
  }
});
$('detail').addEventListener('submit', async e => {
  if (e.target.id !== 'formLoja') return;
  e.preventDefault();
  const p = state.produtos.find(x => x.id === state.sel), btn = $('btnLoja');
  btn.disabled = true; btn.textContent = 'Lendo a página…'; $('erroLoja').hidden = true;
  try { const novo = await dados.adicionarLoja(p.id, $('linkLoja').value); trocar(novo); aviso('Loja adicionada', `Agora comparando ${novo.ofertas.length} lojas.`); }
  catch (err) { btn.disabled = false; btn.textContent = 'Adicionar loja'; $('erroLoja').textContent = err.message; $('erroLoja').hidden = false; }
});
function trocar(p) { state.produtos = state.produtos.map(x => x.id === p.id ? p : x); renderLista(); renderDetalhe(); }

/* ---------- Adicionar produto ---------- */
$('addForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('addBtn'); btn.disabled = true; btn.textContent = 'Lendo a página…'; $('addErro').hidden = true;
  try {
    const p = await dados.adicionarProduto($('addLink').value, $('addAlvo').value || null);
    state.produtos.unshift(p); state.sel = p.id; state.sugestoes = null; $('addLink').value = ''; $('addAlvo').value = '';
    renderLista(); renderDetalhe(); $('shell').dataset.view = 'detail';
    aviso('Produto adicionado', `${brl(melhor(p)?.atual)} na ${p.ofertas[0].loja}. Use “Procurar em outras lojas” para comparar.`);
  } catch (err) { $('addErro').textContent = err.message; $('addErro').hidden = false; }
  finally { btn.disabled = false; btn.textContent = 'Adicionar'; }
});

/* ---------- Avisos ---------- */
let tt;
function aviso(titulo, texto) {
  $('toastTitle').textContent = titulo; $('toastBody').textContent = texto;
  $('toast').classList.add('show'); clearTimeout(tt); tt = setTimeout(() => $('toast').classList.remove('show'), 6000);
}
// Notificações. Local: só com a aba aberta. Nuvem: Web Push, chega mesmo com o app fechado.
const ehIphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
const instalado = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
let pushLigado = false;
async function atualizarBotaoAvisos() {
  const s = 'Notification' in window ? Notification.permission : 'denied';
  if (NUVEM && s === 'granted' && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    pushLigado = !!(reg && await reg.pushManager?.getSubscription());
  }
  const ligado = NUVEM ? pushLigado : s === 'granted';
  $('btnAvisosTxt').textContent = ligado ? 'Avisos ligados' : s === 'denied' ? 'Avisos bloqueados no navegador' : 'Ativar avisos';
  $('btnAvisos').disabled = ligado || s === 'denied';
}
const base64ParaBytes = b => { const p = '='.repeat((4 - b.length % 4) % 4); const r = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
$('btnAvisos').addEventListener('click', async () => {
  if (!('Notification' in window)) {
    return aviso('Avisos não disponíveis aqui', ehIphone && !instalado ? 'No iPhone, toque em Compartilhar → “Adicionar à Tela de Início” e abra o Radar por lá.' : 'Este navegador não mostra notificações.');
  }
  if (await Notification.requestPermission() !== 'granted') return atualizarBotaoAvisos();
  if (NUVEM) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ParaBytes(CFG.vapidPublica) });
      const j = sub.toJSON();
      const { error } = await sb.from('inscricoes_push').upsert({ endpoint: j.endpoint, chaves: j.keys }, { onConflict: 'endpoint' });
      falhou(error, 'Não deu para salvar este aparelho.');
      aviso('Avisos ligados neste aparelho', 'Quando o preço baixar, chega uma notificação aqui, mesmo com o app fechado.');
    } catch (e) { aviso('Não deu para ligar os avisos', e.message); }
  }
  atualizarBotaoAvisos();
});

let ultimoAviso = null;
async function checarAvisos() {
  if (ultimoAviso === null) {
    let salvo = null;
    try { salvo = Number(localStorage.getItem('radar-ultimo-aviso')) || null; } catch {}
    if (salvo == null) { // primeira vez: não repete avisos antigos
      const l = await dados.avisos(0).catch(() => []);
      ultimoAviso = l[0]?.id ?? 0;
      try { localStorage.setItem('radar-ultimo-aviso', String(ultimoAviso)); } catch {}
      return;
    }
    ultimoAviso = salvo;
  }
  const lista = await dados.avisos(ultimoAviso).catch(() => []);
  for (const a of [...lista].reverse()) {
    aviso(a.titulo, a.texto);
    if (!NUVEM && 'Notification' in window && Notification.permission === 'granted') new Notification(a.titulo, { body: a.texto });
    ultimoAviso = Math.max(ultimoAviso, a.id);
  }
  try { localStorage.setItem('radar-ultimo-aviso', String(ultimoAviso)); } catch {}
}

/* ---------- Início ---------- */
async function carregar() {
  const [st, produtos] = await Promise.all([dados.status(), dados.produtos()]);
  state.intervaloHoras = st.intervaloHoras; state.lojas = st.lojas; state.lojasComBusca = st.lojasComBusca;
  $('status').textContent = `${st.lojas.length} lojas · confere a cada ${st.intervaloHoras} h`;
  $('lojasLista').textContent = `Lojas que o app já lê: ${st.lojas.join(', ')}.`;
  state.produtos = produtos;
  if (!produtos.some(p => p.id === state.sel)) state.sel = produtos[0]?.id ?? null;
  renderLista();
  // Não redesenha o detalhe se a pessoa estiver digitando ou vendo sugestões
  if (!document.activeElement?.closest?.('#detail') && !state.buscando) renderDetalhe();
}
let iniciado = false;
function iniciarApp() {
  if (iniciado) return; iniciado = true;
  if (window.matchMedia('(min-width:861px)').matches) $('shell').dataset.view = 'detail';
  atualizarBotaoAvisos();
  carregar().catch(e => { $('status').textContent = NUVEM ? 'Não consegui carregar seus dados. Recarregue a página.' : 'Não consegui falar com o servidor. Ele está rodando?'; console.error(e); });
  checarAvisos();
  setInterval(() => { carregar().catch(() => {}); checarAvisos(); }, 60000);
}

// Login com Google (só na nuvem)
function carregarScript(src) {
  return new Promise((ok, falha) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => falha(new Error('Sem internet?')); document.head.appendChild(s); });
}
function mostrarConta(user) {
  const nome = user.user_metadata?.name || user.email || 'Você';
  const foto = user.user_metadata?.avatar_url;
  $('contaAv').innerHTML = foto ? `<img src="${esc(foto)}" alt="" referrerpolicy="no-referrer">` : esc(nome[0].toUpperCase());
  $('contaNome').textContent = nome.split(' ')[0];
  $('btnConta').hidden = false;
}
async function iniciarNuvem() {
  try {
    await carregarScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js');
  } catch (e) { $('status').textContent = 'Não consegui carregar o app. Confira a internet e recarregue.'; return; }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  const entrar = s => {
    if (!s) { $('login').hidden = false; return; }
    $('login').hidden = true; mostrarConta(s.user);
    try { if (localStorage.getItem('radar-conta') !== s.user.id) { localStorage.removeItem('radar-ultimo-aviso'); localStorage.setItem('radar-conta', s.user.id); } } catch {}
    iniciarApp();
  };
  sb.auth.onAuthStateChange((evento, s) => { if (evento === 'SIGNED_OUT') location.reload(); else if (s) entrar(s); });
  const { data } = await sb.auth.getSession();
  entrar(data.session);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
$('entrarGoogle').addEventListener('click', async () => {
  const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
  if (error) { $('loginErro').textContent = error.message; $('loginErro').hidden = false; }
});
$('btnConta').addEventListener('click', async () => { await sb.auth.signOut(); });

if (NUVEM) iniciarNuvem(); else iniciarApp();
