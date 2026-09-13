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
const { podeMatricular } = require('./regras-matricula');
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
           (SELECT an.nivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS nivel,
           (SELECT an.subnivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS subnivel,
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
           (SELECT an.nivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS nivel,
           (SELECT an.subnivel FROM aluno_niveis an WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL ORDER BY an.data_inicio DESC LIMIT 1) AS subnivel,
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
      `SELECT idmatricula, idaluno, dia_semana, horario, idatividades FROM matricula
       WHERE id_instituicao = ? AND data_fim IS NULL
         AND (idaluno, dia_semana, horario) IN (${placeholdersPosicao})`,
      [req.id_instituicao, ...tuplasPosicao.flat()]
    );
    const existentesPorId = new Map(existentes.map(m => [m.idmatricula, m]));
    // Nunca era pra existir mais de uma matrícula ATIVA pro mesmo aluno+dia+
    // horário, mas um bug antigo (já corrigido) deixava isso acontecer — e
    // quando acontecia, um `new Map(existentes.map(...))` simples descartava
    // uma das duplicatas em silêncio (a última processada "ganhava" o slot no
    // Map), podendo fazer o UPDATE cair na linha ERRADA: a tela mostrava
    // "salvo com sucesso", mas a célula continuava exibindo o valor antigo,
    // porque a linha de verdade em uso não era a que recebeu o UPDATE. Agora,
    // se acharmos mais de uma linha pro mesmo slot, ficamos com a MAIS RECENTE
    // (maior idmatricula) e encerramos as outras automaticamente nesta mesma
    // transação — a edição se autocorrige na próxima vez que alguém tocar
    // naquela célula, em vez de perpetuar a duplicidade.
    const porSlot = new Map(); // "idaluno-dia-horario" -> [idmatricula, ...]
    existentes.forEach(m => {
      const chave = `${m.idaluno}-${m.dia_semana}-${m.horario}`;
      if (!porSlot.has(chave)) porSlot.set(chave, []);
      porSlot.get(chave).push(m.idmatricula);
    });
    const mapaExistentes = new Map();
    const duplicatasParaEncerrar = [];
    porSlot.forEach((ids, chave) => {
      const maisRecente = Math.max(...ids);
      mapaExistentes.set(chave, maisRecente);
      ids.filter(id => id !== maisRecente).forEach(id => duplicatasParaEncerrar.push(id));
    });

    // 1 SELECT pro turno de todo mundo envolvido.
    const idsAlunos = [...new Set(alteracoes.map(a => Number(a.aluno_id)))];
    const [alunosRows] = await connection.query('SELECT id, nome, turno FROM alunos WHERE id IN (?)', [idsAlunos]);
    const alunoPorId = new Map(alunosRows.map(a => [a.id, a]));

    // 1 SELECT pro turno de toda atividade envolvida — precisa pra checar
    // conflito de turno E pra gravar o turno CERTO em `matricula.turno` (antes
    // essa coluna copiava o turno do ALUNO, não da turma escolhida na célula;
    // ficava errado sempre que a célula era um ensaio, por exemplo). Também
    // inclui as atividades das matrículas ANTIGAS (não só as novas escolhas),
    // e o professor de cada uma — é o que permite montar o "de/para" salvo em
    // `criarNotificacao` (ver `detalhesAlteracoes` abaixo), pra tela de
    // notificações poder mostrar de qual turma pra qual turma cada aluno foi.
    const idsAtividades = [...new Set([
      ...alteracoes.map(a => a.id_atividade).filter(Boolean).map(Number),
      ...existentes.map(m => m.idatividades).filter(Boolean).map(Number)
    ])];
    let turmaPorAtividade = new Map();
    if (idsAtividades.length > 0) {
      const [atividadesRows] = await connection.query(
        `SELECT atv.idatividades, atv.nome, atv.turno, p.nome AS nome_professor
         FROM atividades atv LEFT JOIN professores p ON p.id = atv.idprofessor
         WHERE atv.idatividades IN (?)`,
        [idsAtividades]
      );
      turmaPorAtividade = new Map(atividadesRows.map(a => [a.idatividades, a]));
    }
    const formatarLadoTurma = (turma, dia_semana, horario) => turma
      ? { turma: turma.nome, professor: turma.nome_professor || null, dia_semana, horario, turno: turma.turno }
      : null;

    const paraInserir = [];
    const paraEncerrar = [];
    const paraAtualizar = [];
    const results = [];
    const conflitosTurno = [];
    const detalhesAlteracoes = [];

    for (const alteracao of alteracoes) {
      const { aluno_id, dia_semana, horario, id_atividade } = alteracao;
      const idExistente = mapaExistentes.get(`${Number(aluno_id)}-${dia_semana}-${horario}`);
      const aluno = alunoPorId.get(Number(aluno_id));
      const atividadeAntiga = existentesPorId.get(idExistente)?.idatividades;
      const de = formatarLadoTurma(turmaPorAtividade.get(Number(atividadeAntiga)), dia_semana, horario);

      if (id_atividade) {
        const turma = turmaPorAtividade.get(Number(id_atividade));
        if (turma && !podeMatricular(aluno?.turno, turma.turno)) {
          conflitosTurno.push(`${aluno?.nome || 'Aluno'} (turno ${aluno?.turno}) x "${turma.nome}" (turno ${turma.turno}), ${dia_semana} ${horario}`);
          continue; // pula essa célula sem travar o lote inteiro — mesmo espírito do upsert-bulk
        }

        if (idExistente) {
          paraAtualizar.push({ id: idExistente, id_atividade, turno: turma?.turno || '' });
          results.push({ action: 'updated', id: idExistente });
        } else {
          paraInserir.push({ aluno_id, dia_semana, horario, id_atividade, turno: turma?.turno || '' });
          results.push({ action: 'created', aluno_id, dia_semana, horario });
        }
        detalhesAlteracoes.push({ aluno_id: Number(aluno_id), aluno_nome: aluno?.nome || null, de, para: formatarLadoTurma(turma, dia_semana, horario) });
      } else if (idExistente) {
        paraEncerrar.push(idExistente);
        results.push({ action: 'deleted', id: idExistente });
        detalhesAlteracoes.push({ aluno_id: Number(aluno_id), aluno_nome: aluno?.nome || null, de, para: null });
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

    // Junta com as duplicatas descobertas acima (nunca se sobrepõem: essa
    // lista só tem as linhas MAIS ANTIGAS de cada slot duplicado, nunca a
    // `idExistente`/mais recente usada no restante da função).
    const idsParaEncerrar = [...new Set([...paraEncerrar, ...duplicatasParaEncerrar])];
    if (idsParaEncerrar.length > 0) {
      await connection.query('UPDATE matricula SET data_fim = CURDATE() WHERE idmatricula IN (?)', [idsParaEncerrar]);
    }

    if (paraAtualizar.length > 0) {
      const casosAtividade = paraAtualizar.map(() => 'WHEN ? THEN ?').join(' ');
      const casosTurno = paraAtualizar.map(() => 'WHEN ? THEN ?').join(' ');
      const idsParaAtualizar = paraAtualizar.map(x => x.id);
      await connection.query(
        `UPDATE matricula SET
           idatividades = CASE idmatricula ${casosAtividade} END,
           turno = CASE idmatricula ${casosTurno} END
         WHERE idmatricula IN (?)`,
        [
          ...paraAtualizar.flatMap(x => [x.id, x.id_atividade]),
          ...paraAtualizar.flatMap(x => [x.id, x.turno]),
          idsParaAtualizar
        ]
      );
    }

    // Depois de mexer nas matrículas, garante que alunos.status reflita a
    // situação atual de quem foi tocado (voltou a ter matrícula = ativo, ficou
    // sem nenhuma = inativo).
    const idsParaSincronizar = [...new Set(alteracoes
      .map(alteracao => Number(alteracao.aluno_id))
      .filter(id => Number.isInteger(id) && id > 0))];

    await syncAlunoStatusFromMatriculas(connection, idsParaSincronizar, req.id_instituicao);

    // Uma notificação por linha alterada inundaria a central quando alguém
    // salva um lote grande de uma vez (Ajuste de Grade é feito pra isso) — em
    // vez disso, um resumo agregado só quando algo realmente mudou. Passa
    // `connection` (mesma transação, ainda não commitada) — criarNotificacao
    // nunca lança erro por conta própria (ver notificacoes-service.js), então
    // isso não arrisca a transação principal; e evita abrir uma 2a conexão do
    // `pool` compartilhado enquanto essa ainda está em uso (em produção,
    // connectionLimit é 1 — abrir uma 2a travaria pra sempre esperando a
    // primeira ser liberada, o que só aconteceria depois desta mesma chamada).
    if (results.length > 0) {
      await criarNotificacao({
        tipo: 'movimentacao',
        titulo: 'Grade ajustada em lote',
        mensagem: `${results.length} ${results.length === 1 ? 'alteração feita' : 'alterações feitas'} na grade (Ajuste de Grade).`,
        id_instituicao: req.id_instituicao,
        detalhes: detalhesAlteracoes
      }, connection);
    }

    await connection.commit();
    res.json({
      success: true,
      updated: results.length,
      results,
      conflitos_turno: conflitosTurno,
      duplicatas_resolvidas: duplicatasParaEncerrar.length
    });

  } catch (error) {
    await connection.rollback();
    console.error('Erro ao atualizar matrículas:', error);
    res.status(500).json({ error: 'Erro ao atualizar matrículas: ' + error.message });
  } finally {
    connection.release();
  }
}));

// Lista, pra instituição atual, todo aluno com mais de uma matrícula ATIVA
// no mesmo dia_semana+horario — nunca devia acontecer (ver comentário em
// POST '/' acima), mas um bug antigo já deixou isso acontecer algumas vezes.
// Ferramenta manual pra um master/coordenador escolher qual manter, sem
// precisar de acesso direto ao banco.
router.get('/duplicidades', asyncHandler(async (req, res) => {
  const [grupos] = await pool.query(
    `SELECT idaluno, dia_semana, horario, GROUP_CONCAT(idmatricula) AS ids
     FROM matricula
     WHERE id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL
     GROUP BY idaluno, dia_semana, horario
     HAVING COUNT(*) > 1`,
    [req.id_instituicao]
  );

  if (grupos.length === 0) return res.json([]);

  const todosIds = grupos.flatMap(g => g.ids.split(',').map(Number));
  const [linhas] = await pool.query(
    `SELECT m.idmatricula, m.idaluno, a.nome AS nome_aluno, m.idatividades, atv.nome AS nome_turma,
            atv.dia_semana, atv.horario, atv.turno, p.nome AS nome_professor, m.data_inicio
     FROM matricula m
     JOIN alunos a ON a.id = m.idaluno
     LEFT JOIN atividades atv ON atv.idatividades = m.idatividades
     LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE m.idmatricula IN (?)
     ORDER BY m.idmatricula DESC`,
    [todosIds]
  );
  const linhaPorId = new Map(linhas.map(l => [l.idmatricula, l]));

  const resultado = grupos.map(g => {
    const ids = g.ids.split(',').map(Number);
    const opcoes = ids.map(id => linhaPorId.get(id)).filter(Boolean);
    return {
      idaluno: g.idaluno,
      nome_aluno: opcoes[0]?.nome_aluno || '',
      dia_semana: g.dia_semana,
      horario: g.horario,
      opcoes
    };
  });
  res.json(resultado);
}));

// Resolve uma duplicidade: mantém a matrícula `manter` e encerra (mesmo
// soft-close usado no resto do arquivo — data_fim = hoje) qualquer OUTRA
// matrícula ativa do mesmo aluno no mesmo dia_semana+horario.
router.post('/duplicidades/resolver', asyncHandler(async (req, res) => {
  const manter = parseInt(req.body.manter);
  if (!manter) return res.status(400).json({ error: 'Informe a matrícula a manter (manter).' });

  const [[matricula]] = await pool.query(
    'SELECT idmatricula, idaluno, dia_semana, horario FROM matricula WHERE idmatricula = ? AND id_instituicao = ? AND data_fim IS NULL',
    [manter, req.id_instituicao]
  );
  if (!matricula) return res.status(404).json({ error: 'Matrícula não encontrada (ou já encerrada) nesta instituição.' });

  const [outras] = await pool.query(
    `SELECT idmatricula FROM matricula
     WHERE id_instituicao = ? AND idaluno = ? AND dia_semana = ? AND horario = ?
       AND status = 'matriculado' AND data_fim IS NULL AND idmatricula != ?`,
    [req.id_instituicao, matricula.idaluno, matricula.dia_semana, matricula.horario, manter]
  );
  if (outras.length === 0) return res.json({ success: true, encerradas: 0 });

  const idsEncerrar = outras.map(o => o.idmatricula);
  await pool.query('UPDATE matricula SET data_fim = CURDATE() WHERE idmatricula IN (?)', [idsEncerrar]);
  // `pool` serve aqui igual a uma `connection` (mysql2/promise expõe `.query`
  // nos dois) — NUNCA usar `pool.getConnection()` sem depois dar `.release()`;
  // em produção o connectionLimit é 1, então uma conexão esquecida aberta
  // travaria toda e qualquer query seguinte pra sempre.
  await syncAlunoStatusFromMatriculas(pool, [matricula.idaluno], req.id_instituicao);
  await logAuditEvent('MATRICULA_DUPLICIDADE_RESOLVIDA', `Aluno #${matricula.idaluno}, ${matricula.dia_semana} ${matricula.horario}: manteve #${manter}, encerrou #${idsEncerrar.join(', #')}`, req.id_instituicao);

  res.json({ success: true, encerradas: idsEncerrar.length });
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
    `SELECT atv.idatividades, atv.nome, atv.dia_semana, atv.horario, atv.turno, p.nome AS nome_professor
     FROM atividades atv LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE atv.idatividades = ? AND atv.id_instituicao = ?`,
    [id_atividade, req.id_instituicao]
  );
  if (turmas.length === 0) return res.status(404).json({ error: 'Turma não encontrada.' });
  const turma = turmas[0];
  if (!turma.dia_semana || !turma.horario || !turma.turno) {
    return res.status(400).json({ error: 'Essa turma ainda não tem dia/horário/turno definidos.' });
  }

  const [alunos] = await pool.query(
    'SELECT id, nome, turno FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [aluno_id, req.id_instituicao]
  );
  if (alunos.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

  // Turno oposto: aluno cadastrado como "Tarde" não pode entrar numa turma
  // "Manhã" (e vice-versa) — mesma regra aplicada no import em massa. Ensaio
  // (turno "Noite") é sempre permitido, ver podeMatricular.
  const turnoAluno = alunos[0].turno ? String(alunos[0].turno).trim() : null;
  if (!podeMatricular(turnoAluno, turma.turno)) {
    return res.status(409).json({ error: `Conflito de turno: ${alunos[0].nome} é do turno ${turnoAluno}, mas essa turma é do turno ${turma.turno}.` });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // Já existe uma matrícula ativa desse aluno nesse exato dia+horário (ou
    // seja, ele já está "ocupado" nesse slot, na turma certa ou em outra)?
    // NÃO filtra por turno: dia+horário já é o slot de tempo real (ex.:
    // "Quarta HR3" é o mesmo período de aula esteja a turma marcada como
    // turno "Tarde" ou "Noite" — turno é só uma categorização da turma, não
    // um segundo eixo de tempo independente). Filtrar por turno aqui deixava
    // passar exatamente esse caso, criando duas matrículas ativas pro mesmo
    // horário de fato.
    const [existentes] = await connection.query(
      `SELECT idmatricula, idatividades, (SELECT nome FROM atividades WHERE idatividades = matricula.idatividades) AS nome_turma_atual
       FROM matricula
       WHERE idaluno = ? AND dia_semana = ? AND horario = ?
         AND id_instituicao = ? AND data_fim IS NULL`,
      [aluno_id, turma.dia_semana, turma.horario, req.id_instituicao]
    );

    if (existentes.length > 0 && Number(existentes[0].idatividades) === Number(id_atividade)) {
      await connection.rollback();
      return res.status(409).json({ error: 'Esse aluno já está matriculado nessa turma.' });
    }

    // Conflito de horário: o aluno já tem OUTRA turma nesse mesmo dia+horário
    // — bloqueia em vez de trocar automaticamente (mesma regra do import em
    // massa). Quem quiser mesmo mudar o aluno de turma usa o botão "Mover"
    // (POST /mover abaixo), que já pede essa intenção explicitamente.
    if (existentes.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        error: `Conflito de horário: ${alunos[0].nome} já está matriculado(a) em "${existentes[0].nome_turma_atual}" nesse mesmo dia/horário/turno. Use "Mover" se a intenção é trocar de turma.`
      });
    }

    await connection.query(
      `INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao)
       VALUES (?, ?, ?, ?, ?, 'matriculado', CURDATE(), ?)`,
      [aluno_id, id_atividade, turma.dia_semana, turma.horario, turma.turno, req.id_instituicao]
    );

    await syncAlunoStatusFromMatriculas(connection, [Number(aluno_id)], req.id_instituicao);

    // logAuditEvent/criarNotificacao recebem `connection` (mesma transação,
    // ainda não commitada) — nenhuma das duas lança erro por conta própria
    // (ver audit.js/notificacoes-service.js), então isso não arrisca a
    // transação principal, e evita abrir uma 2a conexão do `pool`
    // compartilhado enquanto essa ainda está em uso (em produção,
    // connectionLimit é 1 — uma 2a conexão travaria pra sempre esperando a
    // primeira ser liberada, o que só aconteceria depois desta mesma chamada).
    await logAuditEvent('ALUNO_MATRICULADO_TURMA', `Aluno #${aluno_id} -> turma #${id_atividade} "${turma.nome}"`, req.id_instituicao, connection);

    const alunoNome = alunos[0].nome;
    const localTurma = `"${turma.nome}" (${turma.dia_semana} ${turma.horario}, ${turma.turno})`;
    await criarNotificacao({
      tipo: 'matricula',
      titulo: 'Novo aluno matriculado',
      mensagem: `${alunoNome} foi matriculado(a) em ${localTurma}.`,
      id_instituicao: req.id_instituicao,
      id_aluno: Number(aluno_id),
      detalhes: [{
        aluno_id: Number(aluno_id),
        aluno_nome: alunoNome,
        de: null,
        para: { turma: turma.nome, professor: turma.nome_professor || null, dia_semana: turma.dia_semana, horario: turma.horario, turno: turma.turno }
      }]
    }, connection);

    await connection.commit();
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
    `SELECT m.idmatricula, m.idaluno, atv.nome AS nome_turma, atv.dia_semana, atv.horario, atv.turno, p.nome AS nome_professor
     FROM matricula m
     LEFT JOIN atividades atv ON atv.idatividades = m.idatividades
     LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE m.idmatricula = ? AND m.id_instituicao = ? AND m.data_fim IS NULL`,
    [matricula_id, req.id_instituicao]
  );
  if (origemRows.length === 0) return res.status(404).json({ error: 'Matrícula de origem não encontrada ou já encerrada.' });
  const origem = origemRows[0];
  const aluno_id = origem.idaluno;

  const [turmas] = await pool.query(
    `SELECT atv.idatividades, atv.nome, atv.dia_semana, atv.horario, atv.turno, p.nome AS nome_professor
     FROM atividades atv LEFT JOIN professores p ON p.id = atv.idprofessor
     WHERE atv.idatividades = ? AND atv.id_instituicao = ?`,
    [id_atividade_destino, req.id_instituicao]
  );
  if (turmas.length === 0) return res.status(404).json({ error: 'Turma de destino não encontrada.' });
  const turma = turmas[0];
  if (!turma.dia_semana || !turma.horario || !turma.turno) {
    return res.status(400).json({ error: 'Essa turma ainda não tem dia/horário/turno definidos.' });
  }

  const [[aluno]] = await pool.query('SELECT nome, turno FROM alunos WHERE id = ?', [aluno_id]);

  // Mesma regra de turno usada em /matricular — faltava aqui, permitindo mover
  // um aluno pra uma turma de turno diferente sem aviso nenhum.
  if (!podeMatricular(aluno?.turno, turma.turno)) {
    return res.status(409).json({ error: `Conflito de turno: ${aluno?.nome || 'Aluno'} é do turno ${aluno?.turno}, mas essa turma é do turno ${turma.turno}.` });
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.query(
      `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idmatricula = ?`,
      [matricula_id]
    );

    // Essa rota só recebia a matrícula de ORIGEM explicitamente — nunca
    // checava se o aluno já tinha OUTRA matrícula ativa bem no dia+horário de
    // DESTINO (possível mesmo com turmas de turno diferente, já que dia+
    // horário não inclui turno: ex. "Ensaio" de Quarta HR3 à Tarde E outro
    // "Ensaio" de Quarta HR3 à Noite contam como o mesmo slot). Sem essa
    // checagem, mover pra lá criava uma SEGUNDA matrícula ativa no mesmo
    // slot em vez de substituir — a mesma classe de bug corrigida no POST
    // '/' acima. Encerra qualquer uma que já exista ali (exceto a que
    // acabamos de encerrar) antes de inserir a nova.
    const [duplicataNoDestino] = await connection.query(
      `SELECT idmatricula FROM matricula
       WHERE id_instituicao = ? AND idaluno = ? AND dia_semana = ? AND horario = ?
         AND status = 'matriculado' AND data_fim IS NULL AND idmatricula != ?`,
      [req.id_instituicao, aluno_id, turma.dia_semana, turma.horario, matricula_id]
    );
    if (duplicataNoDestino.length > 0) {
      await connection.query(
        'UPDATE matricula SET data_fim = CURDATE() WHERE idmatricula IN (?)',
        [duplicataNoDestino.map(d => d.idmatricula)]
      );
    }

    await connection.query(
      `INSERT INTO matricula (idaluno, idatividades, dia_semana, horario, turno, status, data_inicio, id_instituicao)
       VALUES (?, ?, ?, ?, ?, 'matriculado', CURDATE(), ?)`,
      [aluno_id, id_atividade_destino, turma.dia_semana, turma.horario, turma.turno, req.id_instituicao]
    );

    await syncAlunoStatusFromMatriculas(connection, [Number(aluno_id)], req.id_instituicao);

    // logAuditEvent/criarNotificacao recebem `connection` (mesma transação,
    // ainda não commitada) — ver o mesmo comentário em /matricular acima:
    // evita travar em produção (connectionLimit: 1) esperando uma 2a conexão
    // que só se abriria depois desta mesma chamada terminar.
    await logAuditEvent('ALUNO_MOVIDO_TURMA', `Aluno #${aluno_id} -> turma #${id_atividade_destino} "${turma.nome}" (matrícula #${matricula_id} encerrada)`, req.id_instituicao, connection);

    await criarNotificacao({
      tipo: 'movimentacao',
      titulo: 'Aluno mudou de turma',
      mensagem: `${aluno?.nome || 'Aluno'} foi movido(a) para "${turma.nome}" (${turma.dia_semana} ${turma.horario}, ${turma.turno}).`,
      id_instituicao: req.id_instituicao,
      id_aluno: Number(aluno_id),
      detalhes: [{
        aluno_id: Number(aluno_id),
        aluno_nome: aluno?.nome || null,
        de: origem.nome_turma
          ? { turma: origem.nome_turma, professor: origem.nome_professor || null, dia_semana: origem.dia_semana, horario: origem.horario, turno: origem.turno }
          : null,
        para: { turma: turma.nome, professor: turma.nome_professor || null, dia_semana: turma.dia_semana, horario: turma.horario, turno: turma.turno }
      }]
    }, connection);

    await connection.commit();
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
