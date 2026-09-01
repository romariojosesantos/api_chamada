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

// Buscar alunos por nome em TODAS as instituições (só master enxerga globalmente
// assim) — alimenta a busca com debounce da tela HistoricoAlunoMaster.js.
// Recebe opcionalmente `id_instituicao`: quando vem preenchido (a tela sempre
// manda a instituição atualmente selecionada pelo master), a busca fica
// restrita a essa instituição — sem isso, um master logado numa instituição
// via a topbar via alunos de TODAS as instituições ao buscar aqui, o que é
// inconsistente com o resto do sistema (cada tela só enxerga a instituição
// selecionada).
router.get('/buscar', masterMiddleware, asyncHandler(async (req, res) => {
  const { q, id_instituicao } = req.query;
  const search = String(q || '').trim();
  if (!search || search.length < 2) {
    return res.status(400).json({ error: 'Informe pelo menos 2 caracteres para buscar.' });
  }

  let sql = `SELECT a.id, a.nome, a.data_nascimento, a.sexo, a.telefone, a.turma, a.turno, a.transporte, a.Inf, a.status, a.id_instituicao, i.nome AS nome_instituicao
     FROM alunos a
     JOIN instituicoes i ON a.id_instituicao = i.id
     WHERE a.nome LIKE ? AND a.excluido_em IS NULL`;
  const params = [`%${search}%`];

  const instId = parseInt(id_instituicao);
  if (!isNaN(instId)) {
    sql += ' AND a.id_instituicao = ?';
    params.push(instId);
  }

  sql += ' ORDER BY a.nome ASC LIMIT 50';

  const [rows] = await pool.query(sql, params);
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

// Busca dia_semana/horario/turno de uma turma (atividade) — usado por
// PUT/POST de matrícula abaixo pra nunca aceitar esses 3 campos direto do
// cliente. O dia/horário/turno de uma matrícula tem que ser sempre o mesmo da
// turma que ela aponta (mesma regra que atividades.js aplica quando uma turma
// é editada — ver migrate-split-atividades-por-horario.js); confiar no que o
// front manda pra esses campos permitiria criar uma matrícula com posição
// inconsistente com a turma escolhida.
async function resolverHorarioDaTurma(idatividades) {
  if (!idatividades) return { dia_semana: '', horario: '', turno: '' };
  const [[turma]] = await pool.query(
    'SELECT dia_semana, horario, turno FROM atividades WHERE idatividades = ?',
    [idatividades]
  );
  if (!turma) return null;
  return { dia_semana: turma.dia_semana || '', horario: turma.horario || '', turno: turma.turno || '' };
}

// Editar uma matrícula específica (apenas master) — permite mexer em status e
// datas de uma matrícula ATIVA. Duas coisas NUNCA podem mudar aqui, mesmo numa
// matrícula ativa:
//   1. A turma (idatividades) — trocar a turma de uma matrícula que já existe
//      reescreveria por cima de qual turma o aluno esteve de fato nesse
//      período. Pra mudar de turma o jeito certo é encerrar essa matrícula e
//      criar uma nova (ver POST acima) — o front só oferece o seletor de
//      turma numa matrícula ainda não salva, mas o backend também recusa aqui
//      por segurança.
//   2. Qualquer campo, se a matrícula já virou histórico (data_fim
//      preenchido) — aí só resta excluir (ver DELETE abaixo), nunca editar.
router.put('/matricula/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const matriculaId = parseInt(req.params.id);
  if (isNaN(matriculaId)) return res.status(400).json({ error: 'ID da matrícula inválido.' });

  const { status, data_inicio, data_fim } = req.body;

  const [[matricula]] = await pool.query('SELECT idmatricula, data_fim, idatividades FROM matricula WHERE idmatricula = ?', [matriculaId]);
  if (!matricula) return res.status(404).json({ error: 'Matrícula não encontrada.' });
  if (matricula.data_fim) {
    return res.status(409).json({ error: 'Essa matrícula já foi encerrada e virou histórico — não pode mais ser editada, só excluída.' });
  }

  // idatividades é sempre o que já está gravado — ignora qualquer valor
  // diferente vindo do corpo da requisição (ver comentário acima).
  const idatividades = matricula.idatividades;
  const horarioTurma = await resolverHorarioDaTurma(idatividades);

  const [result] = await pool.query(
    `UPDATE matricula
     SET turno = ?, horario = ?, dia_semana = ?, status = ?, data_inicio = ?, data_fim = ?, idatividades = ?
     WHERE idmatricula = ?`,
    [
      horarioTurma.turno,
      horarioTurma.horario,
      horarioTurma.dia_semana,
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
  const { idaluno, idatividades, status, data_inicio, data_fim, id_instituicao } = req.body;

  const alunoId = parseInt(idaluno);
  const instId = parseInt(id_instituicao);

  if (isNaN(alunoId)) return res.status(400).json({ error: 'ID do aluno inválido.' });
  if (isNaN(instId)) return res.status(400).json({ error: 'ID da instituição inválido.' });
  if (!idatividades) return res.status(400).json({ error: 'Selecione uma turma.' });

  // Verifica se aluno pertence à instituição
  const [[aluno]] = await pool.query('SELECT id FROM alunos WHERE id = ? AND id_instituicao = ?', [alunoId, instId]);
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado nesta instituição.' });

  const horarioTurma = await resolverHorarioDaTurma(idatividades);
  if (!horarioTurma) return res.status(404).json({ error: 'Turma não encontrada.' });

  const [result] = await pool.query(
    `INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, status, data_inicio, data_fim, id_instituicao)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      alunoId,
      idatividades,
      horarioTurma.turno,
      horarioTurma.horario,
      horarioTurma.dia_semana,
      status || 'matriculado',
      data_inicio || null,
      data_fim || null,
      instId
    ]
  );

  await logAuditEvent('MATRICULA_CRIADA_MASTER', `Matrícula ID ${result.insertId} criada pelo master para aluno ${alunoId}`, instId);
  res.status(201).json({ id: result.insertId, message: 'Matrícula criada com sucesso.' });
}));

// Esta rota faz uma de duas coisas, dependendo do estado atual da matrícula:
//   - ATIVA (data_fim NULL): soft-delete — vira histórico (data_fim = hoje,
//     status 'cancelada', mesmo valor usado no resto do sistema — ver
//     atividades.js, matriculas.js, alunos.js — nunca 'encerrado', que só
//     existia aqui e deixava o histórico incoerente com o resto dos dados).
//   - JÁ HISTÓRICA (data_fim preenchido): hard-delete — remove a linha de
//     verdade. Uma matrícula histórica não pode ser "editada" (ver PUT acima),
//     então a única forma de corrigir um registro errado do passado é
//     apagando-o de vez; por isso essa ação é permanente e sem confirmação
//     adicional no backend — a tela precisa confirmar bem antes de chamar isso.
router.delete('/matricula/:id', masterMiddleware, asyncHandler(async (req, res) => {
  const matriculaId = parseInt(req.params.id);
  if (isNaN(matriculaId)) return res.status(400).json({ error: 'ID da matrícula inválido.' });

  const [[matricula]] = await pool.query('SELECT idmatricula, id_instituicao, data_fim FROM matricula WHERE idmatricula = ?', [matriculaId]);
  if (!matricula) return res.status(404).json({ error: 'Matrícula não encontrada.' });

  if (matricula.data_fim) {
    await pool.query('DELETE FROM matricula WHERE idmatricula = ?', [matriculaId]);
    await logAuditEvent('MATRICULA_EXCLUIDA_PERMANENTEMENTE_MASTER', `Matrícula ID ${matriculaId} (já histórica) excluída permanentemente pelo master`, matricula.id_instituicao);
    return res.json({ message: 'Matrícula excluída permanentemente.', permanente: true });
  }

  await pool.query(
    'UPDATE matricula SET data_fim = CURDATE(), status = ? WHERE idmatricula = ?',
    ['cancelada', matriculaId]
  );
  await logAuditEvent('MATRICULA_ENCERRADA_MASTER', `Matrícula ID ${matriculaId} encerrada pelo master`, matricula.id_instituicao);
  res.json({ message: 'Matrícula encerrada com sucesso.', permanente: false });
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
