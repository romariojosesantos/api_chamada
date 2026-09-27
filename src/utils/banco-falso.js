// Só para testes: substitui o pool de src/config/database.js por um banco
// falso que registra cada query e responde conforme regras do teste. Precisa
// ser o PRIMEIRO require do arquivo de teste, antes de qualquer módulo que
// importe o banco.
//
//   const banco = require('../../utils/banco-falso');
//   banco.responder([['FROM professores', [{ id: 3, nome: 'Bia' }]]]);
//   ... chama o service ...
//   banco.queries  // ['SELECT ... [params]', ...]
const path = require('path');

const estado = { regras: [], queries: [] };

async function query(sql, params) {
  const texto = String(sql).replace(/\s+/g, ' ').trim();
  estado.queries.push(texto);
  const regra = estado.regras.find(([trecho]) => texto.includes(trecho));
  if (regra) return [regra[1], []];
  if (/^(INSERT|UPDATE|DELETE)/i.test(texto)) return [{ insertId: 1, affectedRows: 1 }, []];
  return [[], []];
}

const conexao = () => ({
  query,
  beginTransaction: async () => {},
  commit: async () => {},
  rollback: async () => {},
  release() {},
});
const pool = { ...conexao(), getConnection: async () => conexao(), on() {} };

const caminho = require.resolve(path.join(__dirname, '../config/database.js'));
require.cache[caminho] = { id: caminho, filename: caminho, loaded: true, exports: pool };

module.exports = {
  // Regras: [trecho do SQL, resultado]. A primeira que casar responde.
  responder(regras) {
    estado.regras = regras;
    estado.queries = [];
  },
  get queries() {
    return estado.queries;
  },
};
