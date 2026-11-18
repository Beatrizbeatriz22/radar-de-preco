// Decide se é um bom momento de comprar, a partir do histórico guardado.
// historico: [{ quando: ISO, preco: número|null, disponivel: bool }] em ordem de tempo.

const DIA = 864e5;
const media = a => a.reduce((s, x) => s + x, 0) / a.length;
const mediana = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

export function analisar(historico, precoAlvo) {
  const validos = historico.filter(h => h.preco != null && h.disponivel);
  if (!validos.length) return { tipo: 'info', curto: 'Sem preço', titulo: 'Ainda não temos preço para esse produto', texto: 'Pode estar indisponível na loja. O app continua conferindo.' };

  const ult = validos[validos.length - 1];
  const atual = ult.preco;
  const t0 = new Date(validos[0].quando).getTime();
  const dias = Math.max(0, (new Date(ult.quando).getTime() - t0) / DIA);
  const desde = d => validos.filter(h => new Date(h.quando).getTime() >= Date.now() - d * DIA).map(h => h.preco);
  const ultimos90 = desde(90), ultimos30 = desde(30);
  const res = {
    atual,
    menor: Math.min(...ultimos90),
    maior: Math.max(...ultimos90),
    media30: media(ultimos30.length ? ultimos30 : [atual]),
    diasDeDados: Math.floor(dias),
    leituras: validos.length,
  };

  if (precoAlvo && atual <= precoAlvo) {
    return { ...res, tipo: 'bom', curto: 'No seu preço', titulo: 'Chegou no preço que você queria pagar', texto: `Está em ${brl(atual)}, e seu preço-alvo é ${brl(precoAlvo)}.` };
  }
  if (dias < 3) {
    return { ...res, tipo: 'info', curto: 'Juntando dados', titulo: 'Ainda estamos juntando o histórico', texto: `Começamos a acompanhar há pouco tempo (${validos.length} ${validos.length === 1 ? 'leitura' : 'leituras'}). Em alguns dias já dá para dizer se o preço está bom.` };
  }
  // Preço inflado: a média da última semana subiu bem acima do que era antes
  const antes = validos.filter(h => new Date(h.quando).getTime() < Date.now() - 10 * DIA).map(h => h.preco);
  const semana = desde(7);
  if (antes.length >= 5 && semana.length && media(semana) > mediana(antes) * 1.07) {
    const pct = Math.round((media(semana) / mediana(antes) - 1) * 100);
    return { ...res, tipo: 'ruim', curto: 'Preço inflado', titulo: `Espere: o preço subiu ${pct}% nos últimos dias`, texto: `Antes ele custava por volta de ${brl(mediana(antes))}. Lojas costumam subir o preço antes da Black Friday para anunciar desconto depois.` };
  }
  if (dias >= 7 && atual <= res.menor * 1.01) {
    return { ...res, tipo: 'bom', curto: 'Menor preço', titulo: 'Bom momento: menor preço desde que começamos a acompanhar', texto: `Histórico de ${Math.floor(dias)} dias. A média do período é ${brl(res.media30)}.` };
  }
  if (atual <= res.media30 * 0.93) {
    return { ...res, tipo: 'bom', curto: 'Bom preço', titulo: `Bom preço: ${Math.round((1 - atual / res.media30) * 100)}% abaixo da média`, texto: `O menor valor que já vimos foi ${brl(res.menor)}.` };
  }
  return { ...res, tipo: 'atencao', curto: 'Na média', titulo: 'Dá para esperar: o preço está na média', texto: `O menor valor que já vimos foi ${brl(res.menor)}.` };
}

// Depois de cada leitura: vale mandar aviso?
export function avisosNovos(produto, historico, novo) {
  const validos = historico.filter(h => h.preco != null && h.disponivel);
  const anterior = validos.length ? validos[validos.length - 1].preco : null;
  if (novo.preco == null || !novo.disponivel) return [];
  const lista = [];
  if (produto.preco_alvo && novo.preco <= produto.preco_alvo && (anterior == null || anterior > produto.preco_alvo)) {
    lista.push({ titulo: `${curto(produto.titulo)} chegou no seu preço`, texto: `${brl(novo.preco)} na ${novo.loja || produto.loja}. Seu preço-alvo era ${brl(produto.preco_alvo)}.` });
  }
  if (anterior != null && novo.preco <= anterior * 0.9) {
    lista.push({ titulo: `${curto(produto.titulo)} caiu ${Math.round((1 - novo.preco / anterior) * 100)}%`, texto: `De ${brl(anterior)} para ${brl(novo.preco)} na ${novo.loja || produto.loja}.` });
  }
  const dias = validos.length ? (Date.now() - new Date(validos[0].quando).getTime()) / DIA : 0;
  if (dias >= 7 && novo.preco < Math.min(...validos.map(h => h.preco)) * 0.99) {
    lista.push({ titulo: `Menor preço: ${curto(produto.titulo)}`, texto: `${brl(novo.preco)} na ${novo.loja || produto.loja}, o menor desde que começamos a acompanhar.` });
  }
  return lista.slice(0, 1); // um aviso por vez é suficiente
}

// Junta o histórico de várias lojas numa linha só: a cada leitura, o menor preço disponível
// entre as lojas (preço de uma loja vale por até 2 dias depois da última leitura dela).
export function melhorSerie(ofertas) {
  const eventos = ofertas.flatMap((o, i) => o.historico.map(h => ({ ...h, i, loja: o.loja, t: new Date(h.quando).getTime() })))
    .sort((a, b) => a.t - b.t);
  const ultimo = new Map();
  const serie = [];
  for (const e of eventos) {
    ultimo.set(e.i, e);
    let melhor = null;
    for (const u of ultimo.values()) {
      if (!u.disponivel || u.preco == null || e.t - u.t > 2 * DIA) continue;
      if (!melhor || u.preco < melhor.preco) melhor = u;
    }
    serie.push(melhor ? { quando: e.quando, preco: melhor.preco, disponivel: true, loja: melhor.loja } : { quando: e.quando, preco: null, disponivel: false, loja: null });
  }
  return serie;
}

// De quanto em quanto tempo conferir: a cada 4 h; na semana da Black Friday (24/11 a 01/12), a cada 1 h.
export function intervaloAtual(data = new Date()) {
  const ano = data.getFullYear();
  const ini = new Date(ano, 10, 24), fim = new Date(ano, 11, 2);
  return (data >= ini && data < fim ? 1 : 4) * 36e5;
}

export const brl = v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const curto = t => (t.length > 48 ? t.slice(0, 46).trimEnd() + '…' : t);
