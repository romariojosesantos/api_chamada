// CRUD de professor (tela "Educadores") — diferente de GET /api/professores
// em _server.js, que é só uma lista enxuta de nomes pro autocomplete/filtro de
// outras telas. Aqui é a administração de verdade: criar, renomear, ativar/
// desativar, apagar (só se nunca deu aula) e transferir turmas em massa de um
// professor pra outro.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');
const { resolverNomeParecido } = require('./nome-similar');
const { exigirRecurso } = require('./permissoes-middleware');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const exigir = (recurso) => exigirRecurso('/professores', recurso);

// Lista todos os professores da instituição (ativos e inativos — quem decide
// esconder é o front), com quantas turmas ativas cada um dá (como principal
// OU como co-professor, ver atividade_professores) e quantos alunos matriculados no total.
router.get('/', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT p.id, p.nome, p.nome_completo, p.ativo,
       (SELECT COUNT(DISTINCT atv.idatividades)
        FROM atividades atv
        WHERE atv.id_instituicao = p.id_instituicao AND atv.data_fim IS NULL
          AND (atv.idprofessor = p.id OR EXISTS (
            SELECT 1 FROM atividade_professores ap WHERE ap.idatividades = atv.idatividades AND ap.idprofessor = p.id
          ))
       ) AS total_turmas_ativas,
       (SELECT COUNT(DISTINCT m.idaluno)
        FROM matricula m
        JOIN atividades atv ON atv.idatividades = m.idatividades
        WHERE m.id_instituicao = p.id_instituicao AND m.status = 'matriculado' AND m.data_fim IS NULL
          AND (atv.idprofessor = p.id OR EXISTS (
            SELECT 1 FROM atividade_professores ap WHERE ap.idatividades = atv.idatividades AND ap.idprofessor = p.id
          ))
       ) AS total_alunos
     FROM professores p
     WHERE p.id_instituicao = ?
     ORDER BY p.ativo DESC, p.nome ASC`,
    [req.id_instituicao]
  );
  res.json(rows);
}));

// Cria professor novo. Passa pela mesma detecção de nome parecido usada no
// import em massa (ver nome-similar.js): corrige sozinho se for só diferença
// de grafia (reaproveita o já cadastrado em vez de duplicar), ou cria mesmo
// assim mas avisa se for só "parecido" (pode ser gente diferente de verdade).
router.post('/', exigir('criar'), asyncHandler(async (req, res) => {
  const nomeEnviado = String(req.body.nome || '').trim();
  if (!nomeEnviado) return res.status(400).json({ error: 'Nome é obrigatório.' });
  const nomeCompletoEnviado = String(req.body.nome_completo || '').trim() || null;

  const [existentes] = await pool.query(
    'SELECT nome FROM professores WHERE id_instituicao = ?',
    [req.id_instituicao]
  );
  const nomesExistentes = existentes.map(p => p.nome);
  const resultado = resolverNomeParecido(nomeEnviado, nomesExistentes);

  if (resultado.tipo === 'exato' || resultado.tipo === 'corrigido') {
    const nomeFinal = resultado.tipo === 'corrigido' ? resultado.nome : nomeEnviado;
    const [[existente]] = await pool.query(
      'SELECT id, nome, ativo FROM professores WHERE nome = ? AND id_instituicao = ?',
      [nomeFinal, req.id_instituicao]
    );
    return res.status(409).json({
      error: `"${existente.nome}" já está cadastrado.`,
      professor_existente: existente
    });
  }

  const [result] = await pool.query(
    'INSERT INTO professores (nome, nome_completo, ativo, id_instituicao) VALUES (?, ?, 1, ?)',
    [nomeEnviado, nomeCompletoEnviado, req.id_instituicao]
  );

  await logAuditEvent('PROFESSOR_CRIADO', `Professor "${nomeEnviado}" (#${result.insertId})`, req.id_instituicao);

  res.status(201).json({
    id: result.insertId,
    nome: nomeEnviado,
    nome_completo: nomeCompletoEnviado,
    ativo: 1,
    parecido_com: resultado.tipo === 'suspeita' ? resultado.nome : null
  });
}));

// Edita nome e/ou ativo. Renomear passa pela mesma checagem de nome parecido
// (contra os outros professores, não contra ele mesmo).
router.patch('/:id', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nome, ativo, nome_completo } = req.body;

  const [[atual]] = await pool.query(
    'SELECT id, nome, nome_completo, ativo FROM professores WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!atual) return res.status(404).json({ error: 'Professor não encontrado.' });

  let nomeFinal = atual.nome;
  let avisoParecido = null;
  if (nome !== undefined) {
    const nomeEnviado = String(nome || '').trim();
    if (!nomeEnviado) return res.status(400).json({ error: 'Nome não pode ficar vazio.' });
    if (nomeEnviado !== atual.nome) {
      const [outros] = await pool.query(
        'SELECT nome FROM professores WHERE id_instituicao = ? AND id != ?',
        [req.id_instituicao, id]
      );
      const resultado = resolverNomeParecido(nomeEnviado, outros.map(p => p.nome));
      if (resultado.tipo === 'exato' || resultado.tipo === 'corrigido') {
        return res.status(409).json({ error: `Já existe um professor chamado "${resultado.tipo === 'corrigido' ? resultado.nome : nomeEnviado}".` });
      }
      if (resultado.tipo === 'suspeita') avisoParecido = resultado.nome;
      nomeFinal = nomeEnviado;
    }
  }

  const ativoFinal = ativo === undefined ? atual.ativo : (ativo ? 1 : 0);
  const nomeCompletoFinal = nome_completo === undefined ? atual.nome_completo : (String(nome_completo || '').trim() || null);

  await pool.query(
    'UPDATE professores SET nome = ?, nome_completo = ?, ativo = ? WHERE id = ? AND id_instituicao = ?',
    [nomeFinal, nomeCompletoFinal, ativoFinal, id, req.id_instituicao]
  );

  if (nomeFinal !== atual.nome) {
    await logAuditEvent('PROFESSOR_RENOMEADO', `Professor #${id}: "${atual.nome}" -> "${nomeFinal}"`, req.id_instituicao);
  }
  if (Number(ativoFinal) !== Number(atual.ativo)) {
    await logAuditEvent(ativoFinal ? 'PROFESSOR_REATIVADO' : 'PROFESSOR_DESATIVADO', `Professor #${id} "${nomeFinal}"`, req.id_instituicao);
  }

  res.json({ id: Number(id), nome: nomeFinal, nome_completo: nomeCompletoFinal, ativo: Number(ativoFinal), parecido_com: avisoParecido });
}));

// Apaga só se o professor nunca deu aula (nem como principal, nem como
// co-professor) — nem turma ativa nem histórico. Mesma regra/mensagem-estilo
// do DELETE de turma em atividades.js: histórico não pode ficar com um
// professor "fantasma".
router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [[existente]] = await pool.query(
    'SELECT id, nome FROM professores WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!existente) return res.status(404).json({ error: 'Professor não encontrado.' });

  const [[contagem]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM atividades WHERE idprofessor = ? AND id_instituicao = ?) AS como_principal,
       (SELECT COUNT(*) FROM atividade_professores WHERE idprofessor = ? AND id_instituicao = ?) AS como_adicional`,
    [id, req.id_instituicao, id, req.id_instituicao]
  );

  if (contagem.como_principal > 0 || contagem.como_adicional > 0) {
    return res.status(409).json({
      error: `"${existente.nome}" já deu aula em alguma turma (histórico ou ativa). Desative em vez de apagar, ou transfira as turmas dele antes.`
    });
  }

  await pool.query('DELETE FROM professores WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);

  await logAuditEvent('PROFESSOR_APAGADO', `Professor #${id} "${existente.nome}"`, req.id_instituicao);

  res.json({ success: true });
}));

// Lista as turmas ATIVAS onde esse professor é o PRINCIPAL (usado pela tela
// pra mostrar o que vai ser afetado antes de confirmar a transferência).
router.get('/:id/turmas', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [turmas] = await pool.query(
    `SELECT idatividades AS id, nome, dia_semana, horario, turno
     FROM atividades WHERE idprofessor = ? AND id_instituicao = ? AND data_fim IS NULL
     ORDER BY nome ASC, dia_semana ASC, horario ASC`,
    [id, req.id_instituicao]
  );
  res.json(turmas);
}));

// Transfere TODAS as turmas ativas onde `id` é o professor principal pro
// professor `id_destino` — pra quando um professor sai e outro assume tudo de
// uma vez, em vez de editar turma por turma. Não toca em co-professores
// (atividade_professores) — se o professor de origem também era co-professor
// em alguma turma, isso é decidido à parte (turma continua tendo outro
// principal).
router.post('/:id/transferir', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const idDestino = Number(req.body.id_destino);
  if (!idDestino) return res.status(400).json({ error: 'Informe id_destino.' });
  if (idDestino === Number(id)) return res.status(400).json({ error: 'Professor de origem e destino não podem ser o mesmo.' });

  const [[origem]] = await pool.query('SELECT id, nome FROM professores WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!origem) return res.status(404).json({ error: 'Professor de origem não encontrado.' });

  const [[destino]] = await pool.query('SELECT id, nome FROM professores WHERE id = ? AND id_instituicao = ?', [idDestino, req.id_instituicao]);
  if (!destino) return res.status(404).json({ error: 'Professor de destino não encontrado.' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [turmas] = await connection.query(
      `SELECT idatividades, nome FROM atividades WHERE idprofessor = ? AND id_instituicao = ? AND data_fim IS NULL`,
      [id, req.id_instituicao]
    );

    if (turmas.length > 0) {
      await connection.query(
        `UPDATE atividades SET idprofessor = ? WHERE idprofessor = ? AND id_instituicao = ? AND data_fim IS NULL`,
        [idDestino, id, req.id_instituicao]
      );
    }

    await logAuditEvent(
      'PROFESSOR_TURMAS_TRANSFERIDAS',
      `${turmas.length} turma(s) de "${origem.nome}" (#${id}) transferida(s) pra "${destino.nome}" (#${idDestino}): ${turmas.map(t => t.nome).join(', ')}`,
      req.id_instituicao,
      connection
    );

    await connection.commit();

    res.json({ turmas_transferidas: turmas.length, turmas: turmas.map(t => ({ id: t.idatividades, nome: t.nome })) });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

module.exports = router;
