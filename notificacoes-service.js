// Criação de notificações institucionais/de sistema (tabela `notificacoes`).
// Separado de notificacoes.js (o router) pra outros módulos (matriculas.js,
// alunos.js) poderem chamar `criarNotificacao` sem precisar importar rotas.
//
// Mesmo princípio do audit.js: nunca lança erro pra quem chamou — uma falha ao
// registrar a notificação não pode derrubar a operação principal (matricular
// aluno, marcar como inativo, etc.) que está sendo notificada.
const pool = require('./db');

/**
 * @param {object} dados
 * @param {string} dados.tipo - 'sistema' | 'matricula' | 'movimentacao' | 'desistencia'
 * @param {string} dados.titulo
 * @param {string|null} [dados.mensagem]
 * @param {number|null} [dados.id_instituicao] - null = visível pra todo mundo (aviso de sistema global)
 * @param {number|null} [dados.id_aluno] - aluno relacionado, quando aplicável
 * @param {number|null} [dados.criado_por] - id_usuario que gerou manualmente; null = automático
 * @param {object|null} [connection] - conexão de transação a reutilizar (opcional)
 */
async function criarNotificacao({ tipo, titulo, mensagem = null, id_instituicao = null, id_aluno = null, criado_por = null }, connection = null) {
  try {
    const db = connection || pool;
    await db.query(
      'INSERT INTO notificacoes (tipo, titulo, mensagem, id_instituicao, id_aluno, criado_por) VALUES (?, ?, ?, ?, ?, ?)',
      [tipo, titulo, mensagem, id_instituicao, id_aluno, criado_por]
    );
  } catch (error) {
    console.error('Erro ao criar notificação:', error);
  }
}

module.exports = { criarNotificacao };
