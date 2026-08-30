// CRUD de "turmas" (atividades). Desde a migração que separou `atividades`
// por horário (migrate-split-atividades-por-horario.js), cada linha aqui já é
// uma turma real: nome + professor + dia_semana + horario + turno, com seus
// próprios alunos matriculados — não mais um nome genérico compartilhado por
// vários horários diferentes.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');
const { syncAlunoStatusFromMatriculas } = require('./status-sync');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DIAS_VALIDOS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta'];
const TURNOS_VALIDOS = ['Manhã', 'Tarde'];

// Valida os campos comuns a criar/editar turma e resolve o professor: se vier
// `idprofessor`, usa direto; se vier só `professor_nome`, acha o professor
// existente com esse nome ou cria um novo — evita o usuário precisar ir numa
// tela separada só pra cadastrar o professor antes de criar a turma.
async function validarECresolverProfessor(req, res, body) {
  const { nome, dia_semana, horario, turno, idprofessor, professor_nome } = body;

  const nomeLimpo = String(nome || '').trim();
  if (!nomeLimpo) {
    res.status(400).json({ error: 'Nome da turma é obrigatório.' });
    return null;
  }
  if (!DIAS_VALIDOS.includes(dia_semana)) {
    res.status(400).json({ error: 'Dia da semana inválido. Use: ' + DIAS_VALIDOS.join(', ') });
    return null;
  }
  if (!horario || !String(horario).trim()) {
    res.status(400).json({ error: 'Horário é obrigatório.' });
    return null;
  }
  if (!TURNOS_VALIDOS.includes(turno)) {
    res.status(400).json({ error: 'Turno inválido. Use: ' + TURNOS_VALIDOS.join(', ') });
    return null;
  }

  let idProfessorFinal = idprofessor ? Number(idprofessor) : null;

  if (!idProfessorFinal && professor_nome && String(professor_nome).trim()) {
    const nomeProf = String(professor_nome).trim();
    const [existente] = await pool.query(
      'SELECT id FROM professores WHERE nome = ? AND id_instituicao = ?',
      [nomeProf, req.id_instituicao]
    );
    if (existente.length > 0) {
      idProfessorFinal = existente[0].id;
    } else {
      const [criado] = await pool.query(
        'INSERT INTO professores (nome, id_instituicao) VALUES (?, ?)',
        [nomeProf, req.id_instituicao]
      );
      idProfessorFinal = criado.insertId;
    }
  }

  return { nomeLimpo, dia_semana, horario: String(horario).trim(), turno, idProfessorFinal };
}

// Listar todas as turmas da instituição, já com professor e contagem de
// alunos ativos prontos (evita o front ter que cruzar com outra rota).
// Inclui as encerradas também — quem decide esconder ou não é o front (ver
// GradeTurmas.js, que tira as encerradas da grade semanal, e Turmas.js, que
// mostra as duas com um filtro).
router.get('/', asyncHandler(async (req, res) => {
  const sql = `
    SELECT atv.idatividades AS id, atv.nome, atv.dia_semana, atv.horario, atv.turno, atv.idprofessor,
           atv.data_inicio, atv.data_fim,
           p.nome AS nome_professor,
           (SELECT COUNT(*) FROM matricula m
            WHERE m.idatividades = atv.idatividades AND m.status = 'matriculado' AND m.data_fim IS NULL) AS total_alunos
    FROM atividades atv
    LEFT JOIN professores p ON atv.idprofessor = p.id
    WHERE atv.id_instituicao = ?
    ORDER BY atv.nome ASC, atv.dia_semana ASC, atv.turno ASC, atv.horario ASC
  `;
  const [results] = await pool.query(sql, [req.id_instituicao]);
  res.json(results);
}));

// Criar turma nova. data_inicio começa hoje por padrão (pode vir informada
// explicitamente no corpo, ex.: pra registrar uma turma que já existia antes).
router.post('/', asyncHandler(async (req, res) => {
  const dados = await validarECresolverProfessor(req, res, req.body);
  if (!dados) return; // validarECresolverProfessor já respondeu o erro

  // Evita criar duas turmas idênticas (mesmo nome+professor+dia+horário+turno)
  // por duplo clique ou reenvio do formulário.
  const [duplicada] = await pool.query(
    `SELECT idatividades FROM atividades
     WHERE nome = ? AND dia_semana = ? AND horario = ? AND turno = ? AND id_instituicao = ?
       AND idprofessor <=> ? AND data_fim IS NULL`,
    [dados.nomeLimpo, dados.dia_semana, dados.horario, dados.turno, req.id_instituicao, dados.idProfessorFinal]
  );
  if (duplicada.length > 0) {
    return res.status(409).json({ error: 'Já existe uma turma ativa com esse nome, professor, dia e horário.' });
  }

  const dataInicio = req.body.data_inicio || new Date().toISOString().split('T')[0];

  const [result] = await pool.query(
    'INSERT INTO atividades (nome, idprofessor, id_instituicao, dia_semana, horario, turno, data_inicio) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [dados.nomeLimpo, dados.idProfessorFinal, req.id_instituicao, dados.dia_semana, dados.horario, dados.turno, dataInicio]
  );

  await logAuditEvent('TURMA_CRIADA', `Turma "${dados.nomeLimpo}" (${dados.dia_semana} ${dados.horario} ${dados.turno})`, req.id_instituicao);

  res.status(201).json({
    id: result.insertId,
    nome: dados.nomeLimpo,
    dia_semana: dados.dia_semana,
    horario: dados.horario,
    turno: dados.turno,
    idprofessor: dados.idProfessorFinal,
    data_inicio: dataInicio,
    data_fim: null
  });
}));

// Editar turma (nome, professor, dia/horário/turno).
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [existentes] = await pool.query(
    'SELECT idatividades FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (existentes.length === 0) return res.status(404).json({ error: 'Turma não encontrada.' });

  const dados = await validarECresolverProfessor(req, res, req.body);
  if (!dados) return;

  await pool.query(
    'UPDATE atividades SET nome = ?, idprofessor = ?, dia_semana = ?, horario = ?, turno = ? WHERE idatividades = ? AND id_instituicao = ?',
    [dados.nomeLimpo, dados.idProfessorFinal, dados.dia_semana, dados.horario, dados.turno, id, req.id_instituicao]
  );

  // Mantém as matrículas da turma consistentes com o horário dela — a mesma
  // regra que a migração que separou atividades por horário garantiu (ver
  // migrate-split-atividades-por-horario.js): toda matrícula de uma turma tem
  // que ter o mesmo dia/horário/turno da turma.
  await pool.query(
    'UPDATE matricula SET dia_semana = ?, horario = ?, turno = ? WHERE idatividades = ? AND id_instituicao = ?',
    [dados.dia_semana, dados.horario, dados.turno, id, req.id_instituicao]
  );

  await logAuditEvent('TURMA_EDITADA', `Turma #${id} -> "${dados.nomeLimpo}" (${dados.dia_semana} ${dados.horario} ${dados.turno})`, req.id_instituicao);

  res.json({ success: true });
}));

// Encerrar turma (soft-close): marca data_fim = hoje na própria turma E
// encerra (soft-delete, mesmo padrão do resto do sistema) todas as matrículas
// ativas dela. Diferente de apagar: a turma continua existindo, só marcada
// como encerrada — o histórico de quem passou por ela fica intacto e
// consultável (ver GET '/:id/alunos-historico' abaixo).
router.post('/:id/encerrar', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [turmas] = await pool.query(
    'SELECT idatividades, nome, data_fim FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (turmas.length === 0) return res.status(404).json({ error: 'Turma não encontrada.' });
  if (turmas[0].data_fim) return res.status(409).json({ error: 'Essa turma já está encerrada.' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const hoje = new Date().toISOString().split('T')[0];

    await connection.query('UPDATE atividades SET data_fim = ? WHERE idatividades = ?', [hoje, id]);

    const [alunosAtivos] = await connection.query(
      `SELECT idmatricula, idaluno FROM matricula WHERE idatividades = ? AND status = 'matriculado' AND data_fim IS NULL`,
      [id]
    );

    if (alunosAtivos.length > 0) {
      const idsMatricula = alunosAtivos.map(m => m.idmatricula);
      await connection.query(
        `UPDATE matricula SET data_fim = ?, status = 'cancelada' WHERE idmatricula IN (?)`,
        [hoje, idsMatricula]
      );
      await syncAlunoStatusFromMatriculas(connection, alunosAtivos.map(m => m.idaluno), req.id_instituicao);
    }

    await connection.commit();

    await logAuditEvent('TURMA_ENCERRADA', `Turma #${id} "${turmas[0].nome}" — ${alunosAtivos.length} aluno(s) desmatriculado(s) junto`, req.id_instituicao);

    res.json({ success: true, alunos_desmatriculados: alunosAtivos.length });
  } catch (error) {
    await connection.rollback();
    console.error('Erro ao encerrar turma:', error);
    res.status(500).json({ error: 'Erro ao encerrar turma: ' + error.message });
  } finally {
    connection.release();
  }
}));

// Reabrir turma encerrada: só limpa data_fim da turma — NÃO rematricula
// automaticamente quem foi desmatriculado no encerramento (isso teria que ser
// uma decisão manual, matricular de novo quem for o caso).
router.post('/:id/reabrir', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [turmas] = await pool.query(
    'SELECT idatividades, nome, data_fim FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (turmas.length === 0) return res.status(404).json({ error: 'Turma não encontrada.' });
  if (!turmas[0].data_fim) return res.status(409).json({ error: 'Essa turma já está ativa.' });

  await pool.query('UPDATE atividades SET data_fim = NULL WHERE idatividades = ?', [id]);

  await logAuditEvent('TURMA_REABERTA', `Turma #${id} "${turmas[0].nome}"`, req.id_instituicao);

  res.json({ success: true });
}));

// Histórico de quem já passou por essa turma (matrículas encerradas) — o
// modal "Matricular" da tela de Turmas usa isso pra mostrar uma aba de
// histórico ao lado dos alunos ativos.
router.get('/:id/alunos-historico', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [turmas] = await pool.query(
    'SELECT idatividades FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (turmas.length === 0) return res.status(404).json({ error: 'Turma não encontrada.' });

  const [historico] = await pool.query(
    `SELECT m.idmatricula AS id, m.idaluno AS aluno_id, a.nome AS nome_aluno,
            m.data_inicio, m.data_fim, m.status
     FROM matricula m
     JOIN alunos a ON a.id = m.idaluno
     WHERE m.idatividades = ? AND m.data_fim IS NOT NULL
     ORDER BY m.data_fim DESC`,
    [id]
  );

  res.json(historico);
}));

// Apagar turma — bloqueado se houver QUALQUER matrícula vinculada (ativa ou
// já encerrada). Não é só "sem aluno matriculado hoje": apagar uma turma que
// tem histórico de matrícula deixaria esse histórico com uma atividade
// "fantasma" (sem nome, sem professor) nos relatórios — por isso o bloqueio é
// mais rígido que só "matrícula ativa".
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [existentes] = await pool.query(
    'SELECT idatividades, nome FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (existentes.length === 0) return res.status(404).json({ error: 'Turma não encontrada.' });

  const [contagem] = await pool.query(
    `SELECT
       SUM(CASE WHEN status = 'matriculado' AND data_fim IS NULL THEN 1 ELSE 0 END) AS ativas,
       COUNT(*) AS total
     FROM matricula WHERE idatividades = ?`,
    [id]
  );
  const { ativas, total } = contagem[0];

  if (total > 0) {
    const detalheAtivas = ativas > 0 ? `${ativas} aluno(s) matriculado(s) agora` : 'nenhum aluno matriculado agora, mas';
    const detalheHistorico = total > ativas ? ` e ${total - ativas} matrícula(s) encerrada(s) no histórico` : '';
    return res.status(409).json({
      error: `Essa turma tem ${detalheAtivas}${detalheHistorico}. Remova os alunos primeiro (ou mantenha a turma, mesmo vazia, para preservar o histórico).`
    });
  }

  await pool.query('DELETE FROM atividades WHERE idatividades = ? AND id_instituicao = ?', [id, req.id_instituicao]);

  await logAuditEvent('TURMA_APAGADA', `Turma #${id} "${existentes[0].nome}"`, req.id_instituicao);

  res.json({ success: true });
}));

module.exports = router;
