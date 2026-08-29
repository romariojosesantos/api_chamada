// Registro de eventos de auditoria (quem fez o quê, quando) na tabela chamada_conexao.
const pool = require('./db');

/**
 * Grava um evento de auditoria. Nunca lança erro para quem chamou: um problema
 * ao registrar o log não pode derrubar a operação principal que está sendo auditada.
 * @param {string} evento - identificador curto do evento (ex.: 'SALVAR_CHAMADA_LOTE')
 * @param {string} detalhes - texto livre com contexto do evento
 * @param {number} id_instituicao - instituição à qual o evento pertence
 * @param {object|null} connection - conexão de transação a reutilizar (opcional); se omitido, usa o pool padrão
 */
async function logAuditEvent(evento, detalhes, id_instituicao, connection = null) {
  try {
    const db = connection || pool;
    await db.query(
      'INSERT INTO chamada_conexao (evento, detalhes, id_instituicao) VALUES (?, ?, ?)',
      [evento, detalhes, id_instituicao]
    );
  } catch (error) {
    console.error('Erro ao registrar evento de auditoria:', error);
    // Não lança erro para não interromper operações críticas
  }
}

module.exports = { logAuditEvent };
