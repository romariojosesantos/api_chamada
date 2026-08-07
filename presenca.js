const express = require('express');
const router = express.Router();
const pool = require('./db');
const { validate } = require('./validation');
const { logAuditEvent } = require('./audit');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Buscar histórico de presença
router.get('/', asyncHandler(async (req, res) => {
  const sql = `
    SELECT p.aluno_id, a.nome, p.data, p.status, p.observacao
    FROM presenca p
    JOIN alunos a ON p.aluno_id = a.id
    WHERE p.id_instituicao = ?
      AND NOT EXISTS (
        SELECT 1 FROM dias_sem_aula d 
        WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
      )
    ORDER BY a.nome ASC, p.data DESC
  `;
  const [results] = await pool.query(sql, [req.id_instituicao, req.id_instituicao]);
  res.json(results);
}));

// Salvar chamada (Upsert Lote)
router.post('/', validate('presenca'), asyncHandler(async (req, res) => {
  const { data, chamadas } = req.body;
  const connection = await pool.getConnection();

  try {
    if (chamadas.length === 0) return res.status(200).json({ message: 'Sem dados para salvar.' });

    // Verificar se a data é um dia sem aula
    const [diaSemAula] = await connection.query(
      `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
      [data, req.id_instituicao]
    );

    if (diaSemAula.length > 0) {
      return res.status(400).json({ 
        error: 'Não é possível registrar presença neste dia',
        motivo: diaSemAula[0].motivo || 'Dia sem aula',
        isDiaSemAula: true
      });
    }

    await connection.beginTransaction();

    // Separar chamadas para deletar (status null) e para inserir/atualizar (status não null)
    const chamadasParaDeletar = chamadas.filter(c => c.status === null);
    const chamadasParaInserir = chamadas.filter(c => c.status !== null);

    // Deletar registros onde status é null (desmarcar presença)
    if (chamadasParaDeletar.length > 0) {
      const deleteSql = `
        DELETE FROM presenca 
        WHERE aluno_id IN (${chamadasParaDeletar.map(() => '?').join(',')}) 
        AND data = ? 
        AND id_instituicao = ?
      `;
      const alunoIds = chamadasParaDeletar.map(c => c.aluno_id);
      await connection.query(deleteSql, [...alunoIds, data, req.id_instituicao]);
    }

    // Inserir/atualizar registros onde status não é null
    let afetados = chamadasParaDeletar.length;
    if (chamadasParaInserir.length > 0) {
      const sql = `
        INSERT INTO presenca (aluno_id, data, status, id_instituicao, observacao)
        VALUES ?
        ON DUPLICATE KEY UPDATE 
          status = VALUES(status),
          observacao = VALUES(observacao)
      `;
      const values = chamadasParaInserir.map(c => [c.aluno_id, data, c.status, req.id_instituicao, c.observacao || null]);
      
      const [result] = await connection.query(sql, [values]);
      afetados += result.affectedRows;
    }

    // Registrar evento na tabela de conexões/auditoria
    await logAuditEvent('SALVAR_CHAMADA_LOTE', `Data: ${data}, Alunos: ${chamadas.length}, Afetados: ${afetados}`, req.id_instituicao, connection);

    await connection.commit();

    res.status(201).json({ 
      message: 'Presenças processadas com sucesso!',
      detalhes: { total: chamadas.length, registros_afetados: afetados }
    });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

// Finalizar chamada - registrar ausências automaticamente para alunos esperados sem registro
router.post('/finalizar', asyncHandler(async (req, res) => {
  const { data, turno } = req.body;
  const inst = req.id_instituicao;

  if (!data) {
    return res.status(400).json({ error: 'Data é obrigatória.' });
  }

  // Verificar se a data é um dia sem aula
  const [diaSemAula] = await pool.query(
    `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
    [data, inst]
  );

  if (diaSemAula.length > 0) {
    return res.status(400).json({
      error: 'Não é possível finalizar chamada neste dia',
      motivo: diaSemAula[0].motivo || 'Dia sem aula',
      isDiaSemAula: true
    });
  }

  // Determinar dia da semana
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[new Date(`${data}T12:00:00`).getDay()];

  // Buscar alunos esperados (matricula ativa para o dia da semana)
  const [esperados] = await pool.query(
    `SELECT DISTINCT a.id
     FROM alunos a
     JOIN matricula m ON a.id = m.idaluno
     WHERE TRIM(m.dia_semana) = ?
       AND TRIM(LOWER(m.status)) = 'matriculado'
       AND m.data_fim IS NULL
       AND a.id_instituicao = ?
       AND a.status = 'ativo'`,
    [diaDaSemana, inst]
  );

  // Buscar alunos que já têm registro na data
  const [comRegistro] = await pool.query(
    `SELECT DISTINCT aluno_id FROM presenca WHERE data = ? AND id_instituicao = ?`,
    [data, inst]
  );

  const idsComRegistro = new Set(comRegistro.map(r => r.aluno_id));
  const ausentesParaInserir = esperados
    .filter(a => !idsComRegistro.has(a.id))
    .map(a => [a.id, data, 'ausente', null, inst]);

  // Inserir ausências
  let ausentesRegistrados = 0;
  if (ausentesParaInserir.length > 0) {
    await pool.query(
      `INSERT INTO presenca (aluno_id, data, status, observacao, id_instituicao) VALUES ?`,
      [ausentesParaInserir]
    );
    ausentesRegistrados = ausentesParaInserir.length;
  }

  res.json({
    message: 'Chamada finalizada com sucesso',
    ausentes_registrados: ausentesRegistrados
  });
}));

module.exports = router;