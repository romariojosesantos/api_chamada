// Leitura e gravação de presença (chamada). O ponto mais sensível do sistema:
// a gravação é feita em lote (todos os alunos de uma chamada de uma vez) dentro
// de uma transação, para nunca salvar uma chamada pela metade.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { validate } = require('./validation');
const { logAuditEvent } = require('./audit');
const { criarNotificacao } = require('./notificacoes-service');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Cláusula SQL pra "presença desse período" — um registro SEM período (de
// antes da coluna `periodo` existir, ver migrate-add-periodo-presenca.js)
// conta como fallback só quando o período consultado NÃO é 'noite'. Motivo:
// antes dessa coluna existir, a tela de Chamada nem tinha como fazer a
// chamada da noite separadamente (a opção "Noite" no seletor de turno é
// nova) — um registro antigo sem período, por definição, NUNCA pode ter sido
// da noite, só podia ter vindo de uma chamada de manhã ou tarde. Sem essa
// restrição, um aluno com presença antiga de outro turno aparecia "presente"
// na noite mesmo sem a chamada da noite ter sido feita ainda.
function condicaoPeriodo(periodo) {
  return periodo === 'noite'
    ? { sql: 'periodo = ?', params: [periodo] }
    : { sql: '(periodo = ? OR periodo IS NULL)', params: [periodo] };
}

// Buscar histórico de presença. Exclui datas marcadas como "sem aula" DEPOIS
// de já terem presença lançada — evita que um feriado cadastrado
// retroativamente continue aparecendo no histórico.
//
// Filtro por data OPCIONAL (`data` exata, ou `data_inicio`+`data_fim`) — sem
// nenhum dos dois, mantém o comportamento de sempre (histórico inteiro da
// instituição). Adicionado porque a tela de Chamada só usa o dia atual (`data`)
// e o export por período só usa o intervalo escolhido (`data_inicio`/
// `data_fim`), mas os dois chamavam essa rota sem filtro nenhum — cada poll de
// 15s da Chamada baixando TODO o histórico da instituição (17 mil+ linhas já
// na instituição 1), pra usar só o dia de hoje.
router.get('/', asyncHandler(async (req, res) => {
  const { data, data_inicio, data_fim } = req.query;
  let sql = `
    SELECT p.aluno_id, a.nome, p.data, p.status, p.periodo, p.observacao
    FROM presenca p
    JOIN alunos a ON p.aluno_id = a.id
    WHERE p.id_instituicao = ?
      AND NOT EXISTS (
        SELECT 1 FROM dias_sem_aula d
        WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
      )
  `;
  const params = [req.id_instituicao, req.id_instituicao];
  if (data) {
    sql += ' AND DATE(p.data) = ?';
    params.push(data);
  } else if (data_inicio && data_fim) {
    sql += ' AND DATE(p.data) BETWEEN ? AND ?';
    params.push(data_inicio, data_fim);
  }
  sql += ' ORDER BY a.nome ASC, p.data DESC';
  const [results] = await pool.query(sql, params);
  res.json(results);
}));

// Salvar chamada em lote (upsert): grava presença de vários alunos para uma
// mesma data numa única transação. Se um aluno já tem registro para a data,
// o status é atualizado (ON DUPLICATE KEY UPDATE) em vez de duplicar a linha.
// Recusa a gravação inteira se a data estiver marcada como "sem aula".
//
// `status: null` é o sinal do frontend para "desmarcar" (ex.: clicar de novo em
// "Presente" para tirar a marcação — ver handleTogglePresence em AttendanceList.jsx).
// Como a coluna `status` é NOT NULL, esse caso não é um upsert: é tratado como
// pedido para APAGAR o registro de presença existente daquele aluno na data.
router.post('/', validate('presenca'), asyncHandler(async (req, res) => {
  const { data, chamadas } = req.body;
  // Sem `periodo` (chamada antiga/turno não mapeado): grava NULL, mesmo
  // comportamento de antes da coluna existir — nunca bloqueia o salvamento
  // por causa disso.
  const periodo = req.body.periodo || null;
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

    // Deletar registros onde status é null (desmarcar presença). Ver
    // condicaoPeriodo() no topo do arquivo.
    if (chamadasParaDeletar.length > 0) {
      const { sql: condPeriodo, params: paramsPeriodo } = condicaoPeriodo(periodo);
      const deleteSql = `
        DELETE FROM presenca
        WHERE aluno_id IN (${chamadasParaDeletar.map(() => '?').join(',')})
        AND data = ?
        AND id_instituicao = ?
        AND ${condPeriodo}
      `;
      const alunoIds = chamadasParaDeletar.map(c => c.aluno_id);
      await connection.query(deleteSql, [...alunoIds, data, req.id_instituicao, ...paramsPeriodo]);
    }

    // Inserir/atualizar registros onde status não é null. A chave única agora
    // inclui `periodo` (ver migrate-add-periodo-presenca.js) — o mesmo aluno
    // pode ter uma linha pro turno do dia e outra pro ensaio da noite, sem
    // uma sobrescrever a outra.
    let afetados = chamadasParaDeletar.length;
    if (chamadasParaInserir.length > 0) {
      const sql = `
        INSERT INTO presenca (aluno_id, data, status, id_instituicao, observacao, periodo)
        VALUES ?
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          observacao = VALUES(observacao)
      `;
      const values = chamadasParaInserir.map(c => [c.aluno_id, data, c.status, req.id_instituicao, c.observacao || null, periodo]);

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

// Registra quando um aluno precisou ser adicionado manualmente (via busca) na
// chamada, por não ter aparecido na lista automática (/api/alunos/por-dia) do
// turno/transporte/dia. Isso indica um provável problema de CADASTRO — mas
// pode ser o turno (matrícula) OU o transporte (a lista já filtra por
// transporte também, ver jaVisivel em AttendanceList.jsx), então checamos os
// dois aqui pra apontar exatamente qual, em vez de sempre culpar "turno" (bug
// de mensagem: várias adições manuais eram na real por transporte errado).
// Grava em `adicoes_manuais_chamada` (estruturado, pro relatório mensal),
// além do log de auditoria + notificação de sempre. Chamado pelo frontend
// assim que o professor seleciona o aluno na busca (ver addManualStudent em
// AttendanceList.jsx), independente de ele marcar presença.
router.post('/adicao-manual', asyncHandler(async (req, res) => {
  const { aluno_id, data, turno, transporte } = req.body;

  if (!aluno_id || !data || !turno) {
    return res.status(400).json({ error: 'aluno_id, data e turno são obrigatórios.' });
  }

  const [[aluno]] = await pool.query(
    'SELECT nome, transporte FROM alunos WHERE id = ? AND id_instituicao = ?',
    [aluno_id, req.id_instituicao]
  );
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });

  const norm = (s) => String(s || '').toLowerCase().trim();
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[new Date(`${data}T12:00:00`).getDay()];

  // Turno: existe ALGUMA matrícula ativa dele pra esse dia da semana com
  // turno igual ao selecionado na Chamada? (turno vem da MATRÍCULA, não do
  // atributo fixo `alunos.turno` — um aluno pode ter mais de uma).
  const [matriculasDoDia] = await pool.query(
    `SELECT turno FROM matricula
     WHERE idaluno = ? AND id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL
       AND TRIM(dia_semana) = ? AND data_inicio <= ?`,
    [aluno_id, req.id_instituicao, diaDaSemana, data]
  );
  const turnoOk = matriculasDoDia.some(m => norm(m.turno) === norm(turno));

  // Transporte: só é um problema se havia de fato um filtro de transporte
  // selecionado na tela (mesmo fallback "Sem transporte definido" usado em
  // AttendanceList.jsx pra aluno sem transporte cadastrado).
  const alunoTransporte = (aluno.transporte && aluno.transporte.trim()) ? aluno.transporte : 'Sem transporte definido';
  const transporteOk = !transporte || !transporte.trim() || norm(alunoTransporte) === norm(transporte);

  const motivoProvavel = !turnoOk && !transporteOk ? 'ambos'
    : !turnoOk ? 'turno'
    : !transporteOk ? 'transporte'
    : 'indefinido';

  const motivoTexto = {
    turno: `o turno cadastrado na matrícula não bate com "${turno}"`,
    transporte: `o transporte cadastrado ("${alunoTransporte}") não bate com o filtro selecionado ("${transporte}")`,
    ambos: `nem o turno da matrícula nem o transporte cadastrado batem com o que estava selecionado (turno "${turno}", transporte "${transporte}")`,
    indefinido: 'turno e transporte batem — motivo não identificado, vale conferir o cadastro mesmo assim'
  }[motivoProvavel];

  await pool.query(
    `INSERT INTO adicoes_manuais_chamada
       (id_instituicao, aluno_id, data, turno_selecionado, transporte_selecionado, aluno_transporte, motivo_provavel)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.id_instituicao, aluno_id, data, turno, transporte || null, alunoTransporte, motivoProvavel]
  );

  await logAuditEvent(
    'ALUNO_ADICIONADO_MANUALMENTE_CHAMADA',
    `Aluno ID: ${aluno_id} (${aluno.nome}) adicionado manualmente na chamada de ${data} (turno: ${turno}, transporte: ${transporte || '-'}) — não apareceu na lista automática. Motivo provável: ${motivoTexto}.`,
    req.id_instituicao
  );

  await criarNotificacao({
    tipo: 'sistema',
    titulo: 'Aluno adicionado manualmente à chamada',
    mensagem: `${aluno.nome} não apareceu automaticamente na lista de chamada de ${data} e precisou ser adicionado via busca — ${motivoTexto}.`,
    id_instituicao: req.id_instituicao,
    id_aluno: aluno_id
  });

  res.status(201).json({ success: true });
}));

// Relatório "Alunos adicionados manualmente" — lista pra um mês (?mes=YYYY-MM,
// padrão o mês atual), com o motivo provável (turno/transporte/ambos/
// indefinido) de cada caso. Serve pra limpar cadastro errado em lote em vez
// de depender de alguém lembrar de cada notificação avulsa.
router.get('/adicoes-manuais', asyncHandler(async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
  const [rows] = await pool.query(
    `SELECT am.id, am.aluno_id, a.nome AS aluno_nome, am.data, am.turno_selecionado,
       am.transporte_selecionado, am.aluno_transporte, am.motivo_provavel, am.criado_em
     FROM adicoes_manuais_chamada am
     JOIN alunos a ON a.id = am.aluno_id
     WHERE am.id_instituicao = ? AND DATE_FORMAT(am.data, '%Y-%m') = ?
     ORDER BY am.data DESC, a.nome ASC`,
    [req.id_instituicao, mes]
  );
  res.json({ mes, adicoes: rows });
}));

// Finalizar chamada: para a data+turno informados, registra 'ausente' para todo
// aluno esperado (matriculado ativo, com aula nesse dia da semana, DAQUELE
// turno) que AINDA não tem nenhum registro de presença na data. Não sobrescreve
// registros existentes (presente/ausente/justificado) — só preenche quem ficou
// sem marcação nenhuma. Recusa se a data estiver marcada como "sem aula".
//
// Filtra por `m.turno` (turno DA MATRÍCULA, não o atributo fixo do aluno) —
// mesmo raciocínio de GET /api/alunos/por-dia e relatorios.js: um aluno com
// matrícula dupla (turma do dia + ensaio à noite) só deve ser marcado ausente
// no turno que ele de fato tem matrícula, nunca no outro. Usar `a.turno`
// aqui causava o inverso do esperado: um aluno cujo turno cadastrado é
// "Manhã" mas que só tinha matrícula de "Tarde" (dado legado/edge case)
// podia ser marcado ausente no turno errado ao finalizar a chamada errada.
// Núcleo de "Finalizar Chamada" pra UM turno — extraído em função própria pra
// dar pra reaproveitar tanto em POST /finalizar (um turno de cada vez, como
// sempre foi) quanto em POST /finalizar-dia (todos os turnos do dia de uma
// vez, ver mais abaixo). Retorna `{ diaSemAula, motivo }` se a data estiver
// bloqueada, ou `{ ausentesRegistrados }` no sucesso — nunca lança erro por
// "turno sem ninguém esperado" (só não insere nada, ausentesRegistrados fica 0).
async function finalizarChamadaTurno(inst, data, turno) {
  const [diaSemAula] = await pool.query(
    `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
    [data, inst]
  );
  if (diaSemAula.length > 0) {
    return { diaSemAula: true, motivo: diaSemAula[0].motivo || 'Dia sem aula' };
  }

  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[new Date(`${data}T12:00:00`).getDay()];

  // Buscar alunos esperados (matricula ativa para o dia da semana, do turno pedido)
  const [esperados] = await pool.query(
    `SELECT DISTINCT a.id
     FROM alunos a
     JOIN matricula m ON a.id = m.idaluno
     WHERE TRIM(m.dia_semana) = ?
       AND TRIM(LOWER(m.status)) = 'matriculado'
       AND m.data_fim IS NULL
       AND a.id_instituicao = ?
       AND a.status = 'ativo'
       AND LOWER(TRIM(m.turno)) = LOWER(TRIM(?))`,
    [diaDaSemana, inst, turno]
  );

  // Período correspondente ao turno desta chamada (ver migrate-add-periodo-
  // presenca.js) — "finalizar" só deve considerar "já tem registro" o
  // registro DESSE período; um aluno já presente de manhã não pode contar
  // como "já registrado" pra fins de finalizar a chamada da noite.
  const periodo = String(turno || '').toLowerCase().includes('manh') ? 'manha'
    : String(turno || '').toLowerCase().includes('tard') ? 'tarde'
    : String(turno || '').toLowerCase().includes('noit') ? 'noite'
    : null;

  // Buscar alunos que já têm registro na data, NESSE período. Ver
  // condicaoPeriodo() no topo do arquivo — pra "manha"/"tarde" também conta
  // um registro antigo sem período (ex.: já marcado presente antes desta
  // atualização) como "já registrado"; pra "noite" NUNCA conta um registro
  // sem período, senão "Finalizar Chamada" da noite nem preenchia ausente
  // pra quem só tinha presença antiga de outro turno.
  const { sql: condPeriodo, params: paramsPeriodo } = condicaoPeriodo(periodo);
  const [comRegistro] = await pool.query(
    `SELECT DISTINCT aluno_id FROM presenca WHERE data = ? AND id_instituicao = ? AND ${condPeriodo}`,
    [data, inst, ...paramsPeriodo]
  );

  const idsComRegistro = new Set(comRegistro.map(r => r.aluno_id));
  const ausentesParaInserir = esperados
    .filter(a => !idsComRegistro.has(a.id))
    .map(a => [a.id, data, 'ausente', null, inst, periodo]);

  // Inserir ausências. IGNORE é proposital: se duas pessoas clicarem em
  // "Finalizar Chamada" quase ao mesmo tempo, as duas leem o mesmo retrato de
  // "quem ainda não tem registro" antes de qualquer uma delas inserir — as
  // duas tentam inserir os mesmos alunos. Sem IGNORE, a segunda gravação
  // inteira falha com erro de chave duplicada (presenca tem índice único por
  // aluno+instituição+data) e a pessoa vê um "erro de conexão" mesmo a chamada
  // já tendo sido finalizada com sucesso pela outra pessoa. Com IGNORE, o
  // MySQL só pula as linhas que já existem (não é uma falha real) e
  // affectedRows reflete só o que ESTA chamada conseguiu inserir de fato.
  let ausentesRegistrados = 0;
  if (ausentesParaInserir.length > 0) {
    const [result] = await pool.query(
      `INSERT IGNORE INTO presenca (aluno_id, data, status, observacao, id_instituicao, periodo) VALUES ?`,
      [ausentesParaInserir]
    );
    ausentesRegistrados = result.affectedRows;
  }

  return { ausentesRegistrados };
}

router.post('/finalizar', asyncHandler(async (req, res) => {
  const { data, turno } = req.body;
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });
  if (!turno) return res.status(400).json({ error: 'Turno é obrigatório.' });

  const resultado = await finalizarChamadaTurno(req.id_instituicao, data, turno);
  if (resultado.diaSemAula) {
    return res.status(400).json({
      error: 'Não é possível finalizar chamada neste dia',
      motivo: resultado.motivo,
      isDiaSemAula: true
    });
  }

  res.json({
    message: resultado.ausentesRegistrados > 0 ? 'Chamada finalizada com sucesso' : 'Chamada já estava finalizada',
    ausentes_registrados: resultado.ausentesRegistrados
  });
}));

// Finalizar TODOS os turnos pendentes de um dia, de uma vez (botão "Finalizar"
// da lista de pendências do Painel do Gestor — ver GET /pendencias-mes) — em
// vez de precisar entrar na Chamada e finalizar turno por turno. Tenta os 3
// turnos canônicos (Manhã/Tarde/Noite, os únicos usados no seletor de turno
// da Chamada); um turno sem ninguém esperado naquele dia simplesmente não
// insere nada (ver finalizarChamadaTurno), não é erro.
const TURNOS_CANONICOS = ['Manhã', 'Tarde', 'Noite'];
router.post('/finalizar-dia', asyncHandler(async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const porTurno = [];
  let totalAusentesRegistrados = 0;
  for (const turno of TURNOS_CANONICOS) {
    const resultado = await finalizarChamadaTurno(req.id_instituicao, data, turno);
    if (resultado.diaSemAula) {
      return res.status(400).json({
        error: 'Não é possível finalizar chamada neste dia',
        motivo: resultado.motivo,
        isDiaSemAula: true
      });
    }
    if (resultado.ausentesRegistrados > 0) {
      totalAusentesRegistrados += resultado.ausentesRegistrados;
      porTurno.push({ turno, ausentes_registrados: resultado.ausentesRegistrados });
    }
  }

  res.json({
    message: totalAusentesRegistrados > 0 ? 'Chamada do dia finalizada com sucesso' : 'Chamada já estava finalizada',
    ausentes_registrados: totalAusentesRegistrados,
    por_turno: porTurno
  });
}));

// Lista, pra um mês (?mes=YYYY-MM, padrão o mês atual), quais DIAS já
// passaram e ainda têm turno com aluno esperado sem nenhum registro de
// presença — pra mostrar no Painel do Gestor sem precisar navegar dia a dia
// na Chamada. Só considera até hoje (dia futuro não tem "pendência", só
// ainda não aconteceu) e ignora dias marcados como "sem aula". Mesma condição
// de período (NULL só cobre manhã/tarde) do resto do sistema.
router.get('/pendencias-mes', asyncHandler(async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
  const inst = req.id_instituicao;
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const primeiroDiaMes = `${mes}-01`;
  if (primeiroDiaMes > hoje) return res.json({ mes, dias: [] });
  const [ano, mesNum] = mes.split('-').map(Number);
  const ultimoDiaCalendario = `${mes}-${String(new Date(ano, mesNum, 0).getDate()).padStart(2, '0')}`;
  const dataFim = ultimoDiaCalendario > hoje ? hoje : ultimoDiaCalendario;

  const PERIODO_LABEL_SQL = `CASE
    WHEN LOWER(m.turno) LIKE '%manh%' THEN 'Manhã'
    WHEN LOWER(m.turno) LIKE '%tard%' THEN 'Tarde'
    WHEN LOWER(m.turno) LIKE '%noit%' THEN 'Noite'
  END`;
  const PERIODO_SQL = `CASE
    WHEN LOWER(m.turno) LIKE '%manh%' THEN 'manha'
    WHEN LOWER(m.turno) LIKE '%tard%' THEN 'tarde'
    WHEN LOWER(m.turno) LIKE '%noit%' THEN 'noite'
  END`;

  const [rows] = await pool.query(
    `WITH RECURSIVE datas AS (
       SELECT ? as data
       UNION ALL
       SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
     ),
     dias_letivos AS (
       SELECT data FROM datas
       WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = datas.data AND id_instituicao = ?)
     ),
     esperados AS (
       SELECT dl.data, a.id AS aluno_id, ${PERIODO_LABEL_SQL} AS turno, ${PERIODO_SQL} AS periodo
       FROM dias_letivos dl
       JOIN matricula m ON TRIM(m.dia_semana) = ELT(
           DAYOFWEEK(dl.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
         )
         AND dl.data >= m.data_inicio AND (m.data_fim IS NULL OR dl.data <= m.data_fim)
       JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
       WHERE m.status = 'matriculado'
     )
     SELECT e.data, e.turno, COUNT(DISTINCT e.aluno_id) AS pendentes
     FROM esperados e
     WHERE e.turno IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM presenca p
         WHERE p.aluno_id = e.aluno_id AND p.id_instituicao = ? AND DATE(p.data) = e.data
           AND (p.periodo = e.periodo OR (p.periodo IS NULL AND e.periodo <> 'noite'))
       )
     GROUP BY e.data, e.turno
     ORDER BY e.data DESC, e.turno`,
    [primeiroDiaMes, dataFim, inst, inst, inst]
  );

  const porDia = new Map();
  rows.forEach(r => {
    const dataStr = r.data instanceof Date ? r.data.toISOString().split('T')[0] : r.data;
    if (!porDia.has(dataStr)) porDia.set(dataStr, []);
    porDia.get(dataStr).push({ turno: r.turno, pendentes: r.pendentes });
  });
  const dias = [...porDia.entries()]
    .map(([data, turnos]) => ({ data, turnos }))
    .sort((a, b) => b.data.localeCompare(a.data));

  res.json({ mes, dias });
}));

module.exports = router;
