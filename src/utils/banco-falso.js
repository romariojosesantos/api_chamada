// Só para testes: substitui o pool de src/config/database.js por um banco
// falso que registra cada query e responde conforme regras do teste. Precisa
// ser o PRIMEIRO require do arquivo de teste, antes de qualquer módulo que
// importe o banco.
//
//   const banco = require('../../utils/banco-falso');
//   banco.responder([['FROM professores', [{ id: 3, nome: 'Bia' }]]]);
//   ... chama o service ...
//   banco.queries     // ['SELECT ...', ...]
//   banco.parametros  // os params de cada query, na mesma ordem
// Uma regra cujo resultado é um Error faz a query falhar com ele.
const path = require('path');

const estado = { regras: [], queries: [], parametros: [] };

async function query(sql, params) {
  const texto = String(sql).replace(/\s+/g, ' ').trim();
  estado.queries.push(texto);
  estado.parametros.push(params);
  const regra = estado.regras.find(([trecho]) => texto.includes(trecho));
  if (regra?.[1] instanceof Error) throw regra[1];
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
    estado.parametros = [];
  },
  get queries() {
    return estado.queries;
  },
  get parametros() {
    return estado.parametros;
  },
};
