// Registro de eventos de auditoria (quem fez o quê, quando) na tabela chamada_conexao.
const pool = require('../config/database');
const { usuarioAtual } = require('./contexto-requisicao');

/**
 * Grava um evento de auditoria. Nunca lança erro para quem chamou: um problema
 * ao registrar o log não pode derrubar a operação principal que está sendo auditada.
 * O usuário vem da requisição atual (ver contexto-requisicao.js); fica NULL nos crons.
 * @param {string} evento - identificador curto do evento (ex.: 'SALVAR_CHAMADA_LOTE')
 * @param {string} detalhes - texto livre com contexto do evento
 * @param {number} id_instituicao - instituição à qual o evento pertence
 * @param {object|null} connection - conexão de transação a reutilizar (opcional); se omitido, usa o pool padrão
 */
async function logAuditEvent(evento, detalhes, id_instituicao, connection = null) {
  const db = connection || pool;
  try {
    await db.query(
      'INSERT INTO chamada_conexao (evento, detalhes, id_instituicao, id_usuario) VALUES (?, ?, ?, ?)',
      [evento, detalhes, id_instituicao, usuarioAtual()],
    );
  } catch (error) {
    // Banco ainda sem a coluna (migrate-add-auditoria-usuario.js não rodou):
    // grava sem o usuário em vez de perder o evento.
    if (error.code === 'ER_BAD_FIELD_ERROR') {
      await db
        .query('INSERT INTO chamada_conexao (evento, detalhes, id_instituicao) VALUES (?, ?, ?)', [
          evento,
          detalhes,
          id_instituicao,
        ])
        .catch((erro) => console.error('Erro ao registrar evento de auditoria:', erro));
      return;
    }
    console.error('Erro ao registrar evento de auditoria:', error);
    // Não lança erro para não interromper operações críticas
  }
}

module.exports = { logAuditEvent };
