// Banco de dados local (SQLite, já vem com o Node). Fica em dados/radar.db.
// Um "produto" é o que a pessoa quer comprar; cada "oferta" é esse produto numa loja.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pasta = join(dirname(fileURLToPath(import.meta.url)), '..', 'dados');
mkdirSync(pasta, { recursive: true });

export const db = new DatabaseSync(process.env.RADAR_DB || join(pasta, 'radar.db'));
export const agora = () => new Date().toISOString();

db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');

const colunas = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);

// Versão 1 (uma loja por produto) → versão 2 (várias lojas por produto), sem perder o histórico.
if (colunas('produtos').includes('link')) {
  db.exec(`
    BEGIN;
    CREATE TABLE ofertas (
      id INTEGER PRIMARY KEY,
      produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
      link TEXT NOT NULL, loja TEXT NOT NULL, titulo TEXT, vendedor TEXT, ean TEXT,
      criado_em TEXT NOT NULL, ultima_verificacao TEXT, ultimo_erro TEXT
    );
    INSERT INTO ofertas (id, produto_id, link, loja, titulo, vendedor, criado_em, ultima_verificacao, ultimo_erro)
      SELECT id, id, link, loja, titulo, vendedor, criado_em, ultima_verificacao, ultimo_erro FROM produtos;
    CREATE TABLE produtos_v2 (
      id INTEGER PRIMARY KEY, usuario TEXT NOT NULL DEFAULT 'eu',
      titulo TEXT NOT NULL, foto TEXT, ean TEXT, preco_alvo REAL, criado_em TEXT NOT NULL
    );
    INSERT INTO produtos_v2 (id, usuario, titulo, foto, preco_alvo, criado_em)
      SELECT id, usuario, titulo, foto, preco_alvo, criado_em FROM produtos;
    DROP TABLE produtos;
    ALTER TABLE produtos_v2 RENAME TO produtos;
    CREATE TABLE precos_v2 (
      id INTEGER PRIMARY KEY, oferta_id INTEGER NOT NULL REFERENCES ofertas(id) ON DELETE CASCADE,
      quando TEXT NOT NULL, preco REAL, preco_pix REAL, disponivel INTEGER NOT NULL
    );
    INSERT INTO precos_v2 (id, oferta_id, quando, preco, preco_pix, disponivel)
      SELECT id, produto_id, quando, preco, preco_pix, disponivel FROM precos;
    DROP TABLE precos;
    ALTER TABLE precos_v2 RENAME TO precos;
    COMMIT;
  `);
  console.log('Banco atualizado: agora cada produto pode ter várias lojas.');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY,
    usuario TEXT NOT NULL DEFAULT 'eu',      -- preparado para contas separadas (login com Google)
    titulo TEXT NOT NULL, foto TEXT, ean TEXT, preco_alvo REAL, criado_em TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ofertas (
    id INTEGER PRIMARY KEY,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    link TEXT NOT NULL, loja TEXT NOT NULL, titulo TEXT, vendedor TEXT, ean TEXT,
    criado_em TEXT NOT NULL, ultima_verificacao TEXT, ultimo_erro TEXT
  );
  CREATE TABLE IF NOT EXISTS precos (
    id INTEGER PRIMARY KEY,
    oferta_id INTEGER NOT NULL REFERENCES ofertas(id) ON DELETE CASCADE,
    quando TEXT NOT NULL, preco REAL, preco_pix REAL, disponivel INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS avisos (
    id INTEGER PRIMARY KEY,
    produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    quando TEXT NOT NULL, titulo TEXT NOT NULL, texto TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS precos_oferta ON precos (oferta_id, quando);
  CREATE INDEX IF NOT EXISTS ofertas_produto ON ofertas (produto_id);
  PRAGMA foreign_keys = ON;
`);
