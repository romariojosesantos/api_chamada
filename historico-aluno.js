// Ficha completa de um aluno, só para perfil master (pode ver/editar alunos de
// QUALQUER instituição, por isso as rotas daqui não passam pelo middleware de
// x-institution-id — vem de req.body/params, não de req.id_instituicao). Usado
// pela tela HistoricoAlunoMaster.js: busca, edição de dados cadastrais,
// matrículas e contatos de emergência, e histórico de presença.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { masterMiddleware } = require('./auth');
const { logAuditEvent } = require('./audit');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Listar atividades de uma instituição (apenas master) — usado no formulário de
// matrícula da ficha do aluno, pra popular o select de atividades.
router.get('/atividades/:instituicaoId', masterMiddleware, asyncHandler(async (req, res) => {
  const instId = parseInt(req.params.instituicaoId);
  if (isNaN(instId)) return res.status(400).json({ error: 'ID da instituição inválido.' });

  const [rows] = await pool.query(
    `SELECT idatividades AS id, nome, idprofessor, id_instituicao
     FROM atividades
     WHERE id_instituicao = ?
     ORDER BY nome ASC`,
    [instId]
  );
  res.json(rows);
}));

// Buscar alunos por nome em TODAS as instituições (só master enxerga globalmente
// assim) — alimenta a busca com debounce da tela HistoricoAlunoMaster.js.
router.get('/buscar', masterMiddleware, asyncHandler(async (req, res) => {
  const { q } = req.query;
  const search = String(q || '').trim();
  if (!search || search.length < 2) {
    return res.status(400).json({ error: 'Informe pelo menos 2 caracteres para buscar.' });
  }

  const [rows] = await pool.query(
    `SELECT a.id, a.nome, a.data_nascimento, a.sexo, a.telefone, a.turma, a.turno, a.transporte, a.Inf, a.status, a.id_instituicao, i.nome AS nome_instituicao
     FROM alunos a
     JOIN instituicoes i ON a.id_instituicao = i.id
     WHERE a.nome LIKE ?
     ORDER BY a.nome ASC
     LIMIT 50`,
    [`%${search}%`]
  );
  res.json(rows);
}));

// Ficha completa: dados do aluno + TODO o histórico de matrículas (inclusive
// encerradas, ao contrário das outras rotas de matrícula do sistema) + contatos
// de emergência + todo o histórico de presença.
router.get('/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const alunoId = parseInt(req.params.id);
  if (isNaN(alunoId)) return res.status(400).json({ error: 'ID do aluno inválido.' });

  // Dados do aluno + instituição
  const [[aluno]] = await pool.query(
    `SELECT a.*, i.nome AS nome_instituicao
     FROM alunos a
     JOIN instituicoes i ON a.id_instituicao = i.id
     WHERE a.id = ?`,
    [alunoId]
  );

  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });

  // Histórico de matrículas (todas, incluindo encerradas)
  const [matriculas] = await pool.query(
    `SELECT m.idmatricula AS id,
            m.idaluno,
            m.idatividades,
            atv.nome AS nome_atividade,
            p.nome AS nome_professor,
            m.turno,
            m.horario,
            m.dia_semana,
            m.status,
            m.data_inicio,
            m.data_fim,
            m.id_instituicao
     FROM matricula m
     LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
     LEFT JOIN professores p ON atv.idprofessor = p.id
     WHERE m.idaluno = ?
     ORDER BY m.data_inicio DESC, atv.nome ASC`,
    [alunoId]
  );

  // Contatos de emergência — tolerante se a tabela não existir (ambiente sem essa
  // migração aplicada ainda continua funcionando, só sem essa seção da ficha).
  let contatos = [];
  try {
    const [rows] = await pool.query(
      `SELECT id, id_aluno, nome, telefone, parentesco
       FROM contatos_emergencia
       WHERE id_aluno = ?
       ORDER BY id`,
      [alunoId]
    );
    contatos = rows;
  } catch (err) {
    if (err.message && err.message.includes("contatos_emergencia")) {
      console.warn('[historico-aluno] Tabela contatos_emergencia não existe. Continuando sem contatos.');
    } else {
      throw err;
    }
  }

  // Histórico de presenças
  const [presencas] = await pool.query(
    `SELECT p.id, p.aluno_id, p.data, p.status, p.observacao, p.id_instituicao
     FROM presenca p
     WHERE p.aluno_id = ?
     ORDER BY p.data DESC`,
    [alunoId]
  );

  res.json({
    aluno,
    matriculas,
    contatos,
    presencas
  });
}));

// Atualizar dados cadastrais do aluno (apenas master). NOTA: não inclui
// acompanhamento/ponto — o formulário da ficha (HistoricoAlunoMaster.js) também
// não tem campos pra esses dois, então hoje não dá pra editá-los por aqui (só
// pelo PATCH de campo único em alunos.js).
router.put('/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const alunoId = parseInt(req.params.id);
  if (isNaN(alunoId)) return res.status(400).json({ error: 'ID do aluno inválido.' });

  const { nome, data_nascimento, sexo, telefone, turma, turno, transporte, Inf, status } = req.body;

  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });

  const [[aluno]] = await pool.query('SELECT id_instituicao FROM alunos WHERE id = ?', [alunoId]);
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });

  const [result] = await pool.query(
    `UPDATE alunos
     SET nome = ?, data_nascimento = ?, sexo = ?, telefone = ?, turma = ?, turno = ?, transporte = ?, Inf = ?, status = ?
     WHERE id = ?`,
    [
      nome.trim(),
      data_nascimento || null,
      sexo || null,
      telefone || null,
      turma || null,
      turno || null,
      transporte || null,
      Inf || null,
      status || 'ativo',
      alunoId
    ]
  );

  await logAuditEvent('ALUNO_ATUALIZADO_MASTER', `Aluno ID ${alunoId} atualizado pelo master`, aluno.id_instituicao);
  res.json({ message: 'Dados do aluno atualizados com sucesso.' });
}));

// Editar uma matrícula específica (apenas master) — permite mexer em qualquer
// campo, inclusive reabrir uma matrícula encerrada (limpando data_fim).
router.put('/matricula/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const matriculaId = parseInt(req.params.id);
  if (isNaN(matriculaId)) return res.status(400).json({ error: 'ID da matrícula inválido.' });

  const { turno, horario, dia_semana, status, data_inicio, data_fim, idatividades } = req.body;

  const [[matricula]] = await pool.query('SELECT idmatricula FROM matricula WHERE idmatricula = ?', [matriculaId]);
  if (!matricula) return res.status(404).json({ error: 'Matrícula não encontrada.' });

  const [result] = await pool.query(
    `UPDATE matricula
     SET turno = ?, horario = ?, dia_semana = ?, status = ?, data_inicio = ?, data_fim = ?, idatividades = ?
     WHERE idmatricula = ?`,
    [
      turno || '',
      horario || '',
      dia_semana || '',
      status || 'matriculado',
      data_inicio || null,
      data_fim || null,
      idatividades || null,
      matriculaId
    ]
  );

  const [[matriculaInfo]] = await pool.query('SELECT id_instituicao FROM matricula WHERE idmatricula = ?', [matriculaId]);
  await logAuditEvent('MATRICULA_ATUALIZADA_MASTER', `Matrícula ID ${matriculaId} atualizada pelo master`, matriculaInfo?.id_instituicao);
  res.json({ message: 'Matrícula atualizada com sucesso.' });
}));

// Criar nova matrícula para um aluno (apenas master) — diferente de matriculas.js,
// aqui o id_instituicao vem explícito no corpo (o master não está "dentro" de uma
// instituição selecionada, pode estar editando o aluno de qualquer uma).
router.post('/matricula', masterMiddleware, asyncHandler(async (req, res) => {
  const { idaluno, idatividades, turno, horario, dia_semana, status, data_inicio, data_fim, id_instituicao } = req.body;

  const alunoId = parseInt(idaluno);
  const instId = parseInt(id_instituicao);

  if (isNaN(alunoId)) return res.status(400).json({ error: 'ID do aluno inválido.' });
  if (isNaN(instId)) return res.status(400).json({ error: 'ID da instituição inválido.' });

  // Verifica se aluno pertence à instituição
  const [[aluno]] = await pool.query('SELECT id FROM alunos WHERE id = ? AND id_instituicao = ?', [alunoId, instId]);
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado nesta instituição.' });

  const [result] = await pool.query(
    `INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, status, data_inicio, data_fim, id_instituicao)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      alunoId,
      idatividades || null,
      turno || '',
      horario || '',
      dia_semana || '',
      status || 'matriculado',
      data_inicio || null,
      data_fim || null,
      instId
    ]
  );

  await logAuditEvent('MATRICULA_CRIADA_MASTER', `Matrícula ID ${result.insertId} criada pelo master para aluno ${alunoId}`, instId);
  res.status(201).json({ id: result.insertId, message: 'Matrícula criada com sucesso.' });
}));

// Encerrar (soft delete via data_fim + status) uma matrícula (apenas master).
router.delete('/matricula/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const matriculaId = parseInt(req.params.id);
  if (isNaN(matriculaId)) return res.status(400).json({ error: 'ID da matrícula inválido.' });

  const [result] = await pool.query(
    'UPDATE matricula SET data_fim = CURDATE(), status = ? WHERE idmatricula = ?',
    ['encerrado', matriculaId]
  );

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Matrícula não encontrada.' });

  const [[matriculaInfo]] = await pool.query('SELECT id_instituicao FROM matricula WHERE idmatricula = ?', [matriculaId]);
  await logAuditEvent('MATRICULA_ENCERRADA_MASTER', `Matrícula ID ${matriculaId} encerrada pelo master`, matriculaInfo?.id_instituicao);
  res.json({ message: 'Matrícula encerrada com sucesso.' });
}));

// --- Contatos de emergência (versão master — ver também contatos-emergencia.js,
// a versão de instituição usada pela tela GerenciarMatriculas.js) ---

router.put('/contato/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const { nome, telefone, parentesco } = req.body;

  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome do contato é obrigatório.' });
  if (!telefone || !telefone.trim()) return res.status(400).json({ error: 'Telefone do contato é obrigatório.' });

  const [result] = await pool.query(
    'UPDATE contatos_emergencia SET nome = ?, telefone = ?, parentesco = ? WHERE id = ?',
    [nome.trim(), telefone.trim(), parentesco?.trim() || null, id]
  );

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Contato não encontrado.' });

  const [[contatoInfo]] = await pool.query('SELECT id_instituicao FROM contatos_emergencia WHERE id = ?', [id]);
  await logAuditEvent('CONTATO_EMERGENCIA_ATUALIZADO_MASTER', `Contato de emergência ID ${id} atualizado pelo master`, contatoInfo?.id_instituicao);
  res.json({ message: 'Contato atualizado com sucesso.' });
}));

router.post('/contato', masterMiddleware, asyncHandler(async (req, res) => {
  const { id_aluno, nome, telefone, parentesco, id_instituicao } = req.body;
  const alunoId = parseInt(id_aluno);
  const instId = parseInt(id_instituicao);

  if (isNaN(alunoId)) return res.status(400).json({ error: 'ID do aluno inválido.' });
  if (!nome || !nome.trim()) return res.status(400).json({ error: 'Nome do contato é obrigatório.' });
  if (!telefone || !telefone.trim()) return res.status(400).json({ error: 'Telefone do contato é obrigatório.' });

  const [result] = await pool.query(
    'INSERT INTO contatos_emergencia (id_aluno, nome, telefone, parentesco, id_instituicao) VALUES (?, ?, ?, ?, ?)',
    [alunoId, nome.trim(), telefone.trim(), parentesco?.trim() || null, isNaN(instId) ? null : instId]
  );

  await logAuditEvent('CONTATO_EMERGENCIA_CRIADO_MASTER', `Contato de emergência criado pelo master para aluno ${alunoId}`, isNaN(instId) ? null : instId);
  res.status(201).json({ id: result.insertId, message: 'Contato criado com sucesso.' });
}));

router.delete('/contato/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'ID inválido.' });

  const [result] = await pool.query('DELETE FROM contatos_emergencia WHERE id = ?', [id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Contato não encontrado.' });

  const [[contatoInfo]] = await pool.query('SELECT id_instituicao FROM contatos_emergencia WHERE id = ?', [id]);
  await logAuditEvent('CONTATO_EMERGENCIA_DELETADO_MASTER', `Contato de emergência ID ${id} deletado pelo master`, contatoInfo?.id_instituicao);
  res.json({ message: 'Contato removido com sucesso.' });
}));

module.exports = router;
