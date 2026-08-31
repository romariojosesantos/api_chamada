// Consultas de matrícula com filtros (status, dia da semana, aluno específico) +
// a rota de salvamento em lote usada pela tela de Ajuste de Grade.
//
// `m.data_fim IS NULL` aparece em quase toda query deste arquivo: uma matrícula
// com data_fim preenchida está encerrada (soft-delete via /matricula/:id em
// historico-aluno.js, ou pelo próprio import de Excel quando a atividade muda de
// horário) — não é um intervalo de vigência, é um "isso não vale mais".
//
// NOTA sobre o banco: existem as tabelas `dias_semana` (lookup Segunda..Domingo)
// e `matricula_dias` (junção matricula <-> dias_semana) no banco de teste, com
// todas as matrículas já marcadas como "migradas" via `matricula.dias_migrados`.
// Esse par de tabelas não existe no banco de produção e nenhuma rota deste
// arquivo (nem do resto do backend) as usa — todo o código continua lendo/
// escrevendo direto em `matricula.dia_semana` (uma linha de matrícula por dia da
// semana, como o import de Excel em alunos.js já faz). Parece uma migração
// começada e não finalizada num ambiente de teste; não foi adotada aqui.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { syncAlunoStatusFromMatriculas } = require('./status-sync');
const { logAuditEvent } = require('./audit');
const { criarNotificacao } = require('./notificacoes-service');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Listar matrículas ativas por instituição, com vínculo aluno → atividade → dia da semana.
// Aceita filtros opcionais via querystring: ?status=matriculado&dia_semana=Segunda
router.get('/por-instituicao', asyncHandler(async (req, res) => {
  const { status, dia_semana, id_atividade } = req.query;

  let sql = `
    SELECT m.idmatricula AS id,
           a.id AS aluno_id,
           a.nome AS nome_aluno,
           a.turno AS aluno_turno,
           a.transporte,
           atv.idatividades AS id_atividade,
           atv.nome AS nome_atividade,
           m.dia_semana,
           m.horario,
           m.turno,
           m.status,
           p.nome AS nome_professor
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
    LEFT JOIN professores p ON atv.idprofessor = p.id
    WHERE m.id_instituicao = ?
    AND m.data_fim IS NULL
  `;
  const params = [req.id_instituicao];

  if (status) {
    sql += " AND m.status = ?";
    params.push(status);
  }

  // dia_semana vem em português por extenso (ex.: "Segunda") e pode ter espaços
  // extras no banco, por isso o TRIM na comparação.
  if (dia_semana) {
    sql += " AND TRIM(m.dia_semana) = ?";
    params.push(dia_semana);
  }

  // Filtra pra uma turma específica (usado pela tela de Turmas, pra listar só
  // quem está matriculado numa turma).
  if (id_atividade) {
    sql += " AND m.idatividades = ?";
    params.push(id_atividade);
  }

  sql += " ORDER BY a.nome ASC, m.dia_semana ASC";

  const [results] = await pool.query(sql, params);
  res.json(results);
}));

// Buscar matrículas correntes de um aluno específico (compatibilidade com frontend)
router.get('/aluno/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const sql = `
    SELECT m.idmatricula AS id,
           a.id AS aluno_id,
           a.nome AS nome_aluno,
           a.turno AS aluno_turno,
           a.transporte,
           atv.idatividades AS id_atividade,
           atv.nome AS nome_atividade,
           m.dia_semana,
           m.horario,
           m.turno,
           m.status,
           p.nome AS nome_professor
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
    LEFT JOIN professores p ON atv.idprofessor = p.id
    WHERE m.idaluno = ? AND m.id_instituicao = ?
    AND m.data_fim IS NULL
    ORDER BY m.dia_semana ASC
  `;

  const [results] = await pool.query(sql, [id, req.id_instituicao]);
  res.json(results);
}));

// Buscar histórico de matrículas por período (para relatórios de Excel) — aqui
// SIM inclui matrículas encerradas (sem filtro de data_fim), já que o relatório
// de exportação precisa saber quem estava matriculado em cada dia do passado,
// mesmo que a matrícula já tenha terminado hoje.
router.get('/historico-periodo', asyncHandler(async (req, res) => {
  const { data_inicio, data_fim } = req.query;

  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórias' });
  }

  const sql = `
    SELECT m.idaluno,
           a.nome,
           m.idatividades,
           atv.nome AS nome_atividade,
           m.dia_semana,
           m.turno,
           m.data_inicio,
           m.data_fim,
           m.status AS matricula_status,
           m.id_instituicao
    FROM matricula m
    JOIN alunos a ON m.idaluno = a.id
    LEFT JOIN atividades atv ON m.idatividades = atv.idatividades
    WHERE m.id_instituicao = ?
    ORDER BY a.nome, m.data_inicio
  `;

  const [results] = await pool.query(sql, [req.id_instituicao]);
  res.json(results);
}));

// Atualizar matrículas em lote — usado pela tela de Ajuste de Grade: cada célula
// da grade (aluno × dia × horário) manda uma "alteracao" com a nova atividade
// (ou vazio, para remover):
//   - id_atividade preenchido + já existe matrícula na mesma posição -> troca a atividade.
//   - id_atividade preenchido + não existe -> cria matrícula nova.
//   - id_atividade vazio + existe -> encerra (soft-delete) a matrícula daquela posição.
//
// Faz 2 SELECTs e até 3 escritas EM LOTE, nunca uma query por célula — a
// versão anterior fazia 1 a 3 idas ao banco POR alteração (SELECT da posição
// + UPDATE/INSERT), o que virava dezenas de segundos pra um lote grande (essa
// tela existe pra editar várias células de uma vez) e estourava o timeout da
// função serverless — a transação já tinha sido commitada no banco quando o
// timeout estourava, por isso salvava mesmo aparecendo erro pro usuário.
router.post('/', asyncHandler(async (req, res) => {
  const { alteracoes } = req.body;

  if (!alteracoes || !Array.isArray(alteracoes) || alteracoes.length === 0) {
    return res.status(400).json({ error: 'Nenhuma alteração fornecida' });
  }
  for (const a of alteracoes) {
    if (!a.aluno_id || !a.dia_semana || !a.horario) {
      return res.status(400).json({ error: 'Dados incompletos na alteração' });
    }
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // 1 SELECT pra achar TODAS as matrículas já existentes nas posições
    // envolvidas (comparação de tupla, suportada pelo MySQL), em vez de uma
    // consulta por célula.
    const tuplasPosicao = alteracoes.map(a => [Number(a.aluno_id), a.dia_semana, a.horario]);
    const placeholdersPosicao = tuplasPosicao.map(() => '(?,?,?)').join(',');
    const [existentes] = await connection.query(
      `SELECT idmatricula, idaluno, dia_semana, horario FROM matricula
       WHERE id_instituicao = ? AND data_fim IS NULL
         AND (idaluno, dia_semana, horario) IN (${placeholdersPosicao})`,
      [req.id_instituicao, ...tuplasPosicao.flat()]
    );
    const mapaExistentes = new Map(existentes.map(m => [`${m.idaluno}-${m.dia_semana}-${m.horario}`, m.idmatricula]));

    // 1 SELECT pro turno de todo mundo envolvido (usado só nas criações, mas
    // sair sempre com a lista inteira é mais simples e ainda é 1 query só).
    const idsAlunos = [...new Set(alteracoes.map(a => Number(a.aluno_id)))];
    const [alunosRows] = await connection.query('SELECT id, turno FROM alunos WHERE id IN (?)', [idsAlunos]);
    const turnoPorAluno = new Map(alunosRows.map(a => [a.id, a.turno || '']));

    const paraInserir = [];
    const paraEncerrar = [];
    const paraAtualizar = [];
    const results = [];

    for (const alteracao of alteracoes) {
      const { aluno_id, dia_semana, horario, id_atividade } = alteracao;
      const idExistente = mapaExistentes.get(`${Number(aluno_id)}-${dia_semana}-${horario}`);

      if (id_atividade) {
        if (idExistente) {
          paraAtualizar.push({ id: idExistente, id_atividade });
          results.push({ action: 'updated', id: idExistente });
        } else {
          paraInserir.push({ aluno_id, dia_semana, horario, id_atividade, turno: turnoPorAluno.get(Number(aluno_id)) || '' });
          results.push({ action: 'created', aluno_id, dia_semana, horario });
        }
      } else if (idExistente) {
        paraEncerrar.push(idExistente);
        results.push({ action: 'deleted', id: idExistente });
      }
    }

    if (paraInserir.length > 0) {
      const valores = paraInserir.map(x => [x.aluno_id, x.id_atividade, x.dia_semana, x.horario, x.turno, 'matriculado', req.id_instituicao]);
      await connection.query(
        `INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao)
         VALUES ${valores.map(() => '(?, ?, ?, ?, ?, ?, CURDATE(), ?)').join(', ')}`,
        valores.flat()
      );
    }

    if (paraEncerrar.length > 0) {
      await connection.query('UPDATE matricula SET data_fim = CURDATE() WHERE idmatricula IN (?)', [paraEncerrar]);
    }

    if (paraAtualizar.length > 0) {
      const casos = paraAtualizar.map(() => 'WHEN ? THEN ?').join(' ');
      const valoresCase = paraAtualizar.flatMap(x => [x.id, x.id_atividade]);
      await connection.query(
        `UPDATE matricula SET idatividades = CASE idmatricula ${casos} END WHERE idmatricula IN (?)`,
        [...valoresCase, paraAtualizar.map(x => x.id)]
      );
    }

    // Depois de mexer nas matrículas, garante que alunos.status reflita a
    // situação atual de quem foi tocado (voltou a ter matrícula = ativo, ficou
    // sem nenhuma = inativo).
    const idsParaSincronizar = [...new Set(alteracoes
      .map(alteracao => Number(alteracao.aluno_id))
      .filter(id => Number.isInteger(id) && id > 0))];

    await syncAlunoStatusFromMatriculas(connection, idsParaSincronizar, req.id_instituicao);
    await connection.commit();

    // Uma notificação por linha alterada inundaria a central quando alguém
    // salva um lote grande de uma vez (Ajuste de Grade é feito pra isso) — em
    // vez disso, um resumo agregado só quando algo realmente mudou.
    if (results.length > 0) {
      await criarNotificacao({
        tipo: 'movimentacao',
        titulo: 'Grade ajustada em lote',
        mensagem: `${results.length} ${results.length === 1 ? 'alteração feita' : 'alterações feitas'} na grade (Ajuste de Grade).`,
        id_instituicao: req.id_instituicao
      });
    }

    res.json({ success: true, updated: results.length, results });

  } catch (error) {
    await connection.rollback();
    console.error('Erro ao atualizar matrículas:', error);
    res.status(500).json({ error: 'Erro ao atualizar matrículas: ' + error.message });
  } finally {
    connection.release();
  }
}));

// Matricular um aluno numa turma específica (tela de Turmas) — bem mais
// simples que o POST '/' em lote acima, que é pra edição de grade
// célula-a-célula. O dia/horário/turno vêm da PRÓPRIA turma (não do corpo da
// requisição), então não tem como criar uma matrícula com posição
// inconsistente com a atividade.
router.post('/matricular', asyncHandler(async (req, res) => {
  const { aluno_id, id_atividade } = req.body;

  if (!aluno_id || !id_atividade) {
    return res.status(400).json({ error: 'aluno_id e id_atividade são obrigatórios.' });
  }

  const [turmas] = await pool.query(
    'SELECT idatividades, nome, dia_semana, horario, turno FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id_atividade, req.id_instituicao]
  );
  if (turmas.length === 0) return res.status(404).json({ error: 'Turma não encontrada.' });
  const turma = turmas[0];
  if (!turma.dia_semana || !turma.horario || !turma.turno) {
    return res.status(400).json({ error: 'Essa turma ainda não tem dia/horário/turno definidos.' });
  }

  const [alunos] = await pool.query(
    'SELECT id, nome FROM alunos WHERE id = ? AND id_instituicao = ?',
    [aluno_id, req.id_instituicao]
  );
  if (alunos.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Já existe uma matrícula ativa desse aluno nesse exato dia+horário+turno
    // (ou seja, ele já está "ocupado" nesse slot, na turma certa ou em outra)?
    const [existentes] = await connection.query(
      `SELECT idmatricula, idatividades FROM matricula
       WHERE idaluno = ? AND dia_semana = ? AND horario = ? AND turno = ?
         AND id_instituicao = ? AND data_fim IS NULL`,
      [aluno_id, turma.dia_semana, turma.horario, turma.turno, req.id_instituicao]
    );

    if (existentes.length > 0 && Number(existentes[0].idatividades) === Number(id_atividade)) {
      await connection.rollback();
      return res.status(409).json({ error: 'Esse aluno já está matriculado nessa turma.' });
    }

    // Se ele já tinha outra turma nesse mesmo horário, encerra antes de criar
    // a nova (um aluno não pode estar em duas turmas ao mesmo tempo) — isso
    // também é o sinal de que essa chamada é uma TROCA de turma, não uma
    // matrícula nova (ver notificação abaixo).
    const eraTroca = existentes.length > 0;
    if (eraTroca) {
      await connection.query(
        `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula = ?`,
        [existentes[0].idmatricula]
      );
    }

    await connection.query(
      `INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao)
       VALUES (?, ?, ?, ?, ?, 'matriculado', CURDATE(), ?)`,
      [aluno_id, id_atividade, turma.dia_semana, turma.horario, turma.turno, req.id_instituicao]
    );

    await syncAlunoStatusFromMatriculas(connection, [Number(aluno_id)], req.id_instituicao);
    await connection.commit();

    await logAuditEvent('ALUNO_MATRICULADO_TURMA', `Aluno #${aluno_id} -> turma #${id_atividade} "${turma.nome}"`, req.id_instituicao);

    const alunoNome = alunos[0].nome;
    const localTurma = `"${turma.nome}" (${turma.dia_semana} ${turma.horario}, ${turma.turno})`;
    await criarNotificacao({
      tipo: eraTroca ? 'movimentacao' : 'matricula',
      titulo: eraTroca ? 'Aluno mudou de turma' : 'Novo aluno matriculado',
      mensagem: eraTroca
        ? `${alunoNome} foi movido(a) para ${localTurma}.`
        : `${alunoNome} foi matriculado(a) em ${localTurma}.`,
      id_instituicao: req.id_instituicao,
      id_aluno: Number(aluno_id)
    });

    res.status(201).json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error('Erro ao matricular aluno na turma:', error);
    res.status(500).json({ error: 'Erro ao matricular aluno: ' + error.message });
  } finally {
    connection.release();
  }
}));

// Mover um aluno de uma matrícula pra outra turma qualquer — mesmo dia/horário
// ou não, mesma área ou não (usado pelo modal "Mover" de GradeTurmas.js).
// Diferente de POST /matricular (que só troca automaticamente quando o
// conflito está no MESMO dia+horário+turno da turma de destino), aqui a
// matrícula de origem é conhecida explicitamente (matricula_id) — então
// funciona pra qualquer combinação de origem/destino. Encerra a antiga e cria
// a nova numa transação só (evita o aluno ficar sem matrícula nenhuma se a
// segunda metade falhar, que era o risco de fazer isso como dois requests
// separados do cliente).
router.post('/mover', asyncHandler(async (req, res) => {
  const { matricula_id, id_atividade_destino } = req.body;

  if (!matricula_id || !id_atividade_destino) {
    return res.status(400).json({ error: 'matricula_id e id_atividade_destino são obrigatórios.' });
  }

  const [origemRows] = await pool.query(
    'SELECT idmatricula, idaluno FROM matricula WHERE idmatricula = ? AND id_instituicao = ? AND data_fim IS NULL',
    [matricula_id, req.id_instituicao]
  );
  if (origemRows.length === 0) return res.status(404).json({ error: 'Matrícula de origem não encontrada ou já encerrada.' });
  const aluno_id = origemRows[0].idaluno;

  const [turmas] = await pool.query(
    'SELECT idatividades, nome, dia_semana, horario, turno FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
    [id_atividade_destino, req.id_instituicao]
  );
  if (turmas.length === 0) return res.status(404).json({ error: 'Turma de destino não encontrada.' });
  const turma = turmas[0];
  if (!turma.dia_semana || !turma.horario || !turma.turno) {
    return res.status(400).json({ error: 'Essa turma ainda não tem dia/horário/turno definidos.' });
  }

  const [[aluno]] = await pool.query('SELECT nome FROM alunos WHERE id = ?', [aluno_id]);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula = ?`,
      [matricula_id]
    );

    await connection.query(
      `INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao)
       VALUES (?, ?, ?, ?, ?, 'matriculado', CURDATE(), ?)`,
      [aluno_id, id_atividade_destino, turma.dia_semana, turma.horario, turma.turno, req.id_instituicao]
    );

    await syncAlunoStatusFromMatriculas(connection, [Number(aluno_id)], req.id_instituicao);
    await connection.commit();

    await logAuditEvent('ALUNO_MOVIDO_TURMA', `Aluno #${aluno_id} -> turma #${id_atividade_destino} "${turma.nome}" (matrícula #${matricula_id} encerrada)`, req.id_instituicao);

    await criarNotificacao({
      tipo: 'movimentacao',
      titulo: 'Aluno mudou de turma',
      mensagem: `${aluno?.nome || 'Aluno'} foi movido(a) para "${turma.nome}" (${turma.dia_semana} ${turma.horario}, ${turma.turno}).`,
      id_instituicao: req.id_instituicao,
      id_aluno: Number(aluno_id)
    });

    res.json({ success: true });
  } catch (error) {
    await connection.rollback();
    console.error('Erro ao mover aluno de turma:', error);
    res.status(500).json({ error: 'Erro ao mover aluno: ' + error.message });
  } finally {
    connection.release();
  }
}));

// Cancelar (encerrar) uma matrícula específica — usado pra remover um aluno
// de uma turma na tela de Turmas. Soft-delete via data_fim, igual ao resto do
// sistema (nunca apaga a linha, pra manter histórico).
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [matriculas] = await pool.query(
    'SELECT idmatricula, idaluno FROM matricula WHERE idmatricula = ? AND id_instituicao = ? AND data_fim IS NULL',
    [id, req.id_instituicao]
  );
  if (matriculas.length === 0) {
    return res.status(404).json({ error: 'Matrícula não encontrada ou já cancelada.' });
  }

  await pool.query(
    `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula = ?`,
    [id]
  );

  await syncAlunoStatusFromMatriculas(pool, [matriculas[0].idaluno], req.id_instituicao);

  await logAuditEvent('MATRICULA_CANCELADA', `Matrícula #${id} (aluno #${matriculas[0].idaluno})`, req.id_instituicao);

  res.json({ success: true });
}));

module.exports = router;
