// Testes rápidos da regra de "bom momento": node scripts/testar-analise.js
import assert from 'node:assert/strict';
import { analisar, avisosNovos } from '../src/analise.js';

const DIA = 864e5;
const serie = precos => precos.map((p, i) => ({ quando: new Date(Date.now() - (precos.length - 1 - i) * DIA).toISOString(), preco: p, disponivel: true }));

assert.equal(analisar(serie([100]), null).tipo, 'info', 'pouco histórico = juntando dados');
assert.equal(analisar(serie([100]), 120).tipo, 'bom', 'abaixo do preço-alvo = bom');
assert.equal(analisar(serie([...Array(20).fill(100), 112, 113, 114, 115, 116, 117, 118]), null).curto, 'Preço inflado');
assert.equal(analisar(serie([...Array(10).fill(100), 90]), null).tipo, 'bom', 'menor preço = bom');
assert.equal(analisar(serie(Array(10).fill(100)), null).tipo, 'bom', 'preço estável no menor valor conta como menor preço');
assert.equal(analisar(serie([90, 100, 100, 100, 100, 100, 100, 100, 100, 100]), null).curto, 'Na média');
assert.equal(analisar([{ quando: new Date().toISOString(), preco: null, disponivel: false }], null).curto, 'Sem preço');

const prod = { titulo: 'Protetor', loja: 'Amazon', preco_alvo: 80 };
assert.equal(avisosNovos(prod, serie([90]), { preco: 79, disponivel: true }).length, 1, 'aviso ao cruzar o preço-alvo');
assert.equal(avisosNovos(prod, serie([79]), { preco: 78, disponivel: true }).length, 0, 'não repete aviso se já estava abaixo');
assert.match(avisosNovos({ ...prod, preco_alvo: null }, serie([100]), { preco: 85, disponivel: true })[0].titulo, /caiu 15%/);
// Várias lojas: a linha do produto segue o menor preço disponível
import { melhorSerie } from '../src/analise.js';
const t = h => new Date(Date.UTC(2026, 10, 16, h)).toISOString();
const m = melhorSerie([
  { loja: 'A', historico: [{ quando: t(1), preco: 100, disponivel: true }, { quando: t(5), preco: 90, disponivel: true }] },
  { loja: 'B', historico: [{ quando: t(2), preco: 95, disponivel: true }, { quando: t(6), preco: 80, disponivel: false }] },
]);
assert.deepEqual(m.map(x => [x.preco, x.loja]), [[100, 'A'], [95, 'B'], [90, 'A'], [90, 'A']]);
assert.match(avisosNovos(prod, serie([90]), { preco: 79, disponivel: true, loja: 'Drogasil' })[0].texto, /Drogasil/);
// A lista de lojas da tela (nuvem) bate com os leitores
import { lojasSuportadas, lojasComBusca } from '../src/lojas.js';
import { LOJAS, LOJAS_COM_BUSCA } from '../public/lib/lojas-info.js';
assert.deepEqual([...LOJAS].sort(), [...lojasSuportadas].sort(), 'public/lib/lojas-info.js desatualizado');
assert.deepEqual([...LOJAS_COM_BUSCA].sort(), [...lojasComBusca].sort(), 'public/lib/lojas-info.js desatualizado (busca)');
console.log('Todos os testes da análise passaram.');
