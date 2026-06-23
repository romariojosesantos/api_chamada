const pool = require('./db');

// Helper para registrar eventos de auditoria de forma consistente
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
