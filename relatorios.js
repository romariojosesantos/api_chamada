// Relatórios agregados de presença para o dashboard. Em todas as 3 rotas, um
// aluno só é "esperado" se tiver matrícula ativa (`m.status = 'matriculado'`,
// `m.data_fim IS NULL` — não encerrada) para o dia da semana em questão, E a
// data não estiver marcada em `dias_sem_aula` (feriado/recesso — nesse caso
// ninguém é esperado, independente de matrícula).
const express = require('express');
const router = express.Router();
const pool = require('./db');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Snapshot de um único dia: alunos ativos, esperados x presentes (geral, por
// turno e por transporte), frequência e a lista de quem foi marcado presente.
// Se a data cair num dia sem aula, devolve tudo zerado com `is_dia_sem_aula: true`
// em vez de rodar as queries — não tem "esperado" nem "falta" nesses dias.
router.get('/estatisticas-diarias', asyncHandler(async (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const dateObj = new Date(`${data}T12:00:00`);
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[dateObj.getDay()];
  const inst = req.id_instituicao;

  // Verificar se é dia sem aula
  const [diaSemAula] = await pool.query(
    `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
    [data, inst]
  );

  if (diaSemAula.length > 0) {
    return res.json({
      data,
      dia_semana: diaDaSemana,
      is_dia_sem_aula: true,
      motivo: diaSemAula[0].motivo,
      total_ativos_instituicao: 0,
      total_esperado: 0,
      total_presentes: 0,
      total_ausentes: 0,
      por_turno: [],
      por_transporte: {}
    });
  }

  // Todas as queries rodam em paralelo — apenas agregados, sem trazer registros individuais
  const [
    [ativosRes],
    [turnoStatsRes],
    [transporteStatsRes],
    [ausentesCountRes],
    [justificativasRes],
    [totalPresencasRegistradasRes],
    [listaPresencasRegistradasRes],
    [presentesReaisPorTurnoRes],
    [justificadosCountRes],
    [ativosSemMatriculaRes]
  ] = await Promise.all([
    // 1. Total de alunos ativos
    pool.query(
      "SELECT COUNT(*) as total FROM alunos WHERE id_instituicao = ? AND status = 'ativo' AND excluido_em IS NULL",
      [inst]
    ),

    // 2. Por turno: esperados e presentes no dia (agrupado no banco)
    pool.query(
      `SELECT
         a.turno,
         COUNT(DISTINCT a.id) AS esperados,
         COUNT(DISTINCT CASE WHEN p.status = 'presente' THEN a.id END) AS presentes
       FROM alunos a
       JOIN matricula m ON a.id = m.idaluno AND TRIM(m.dia_semana) = ? AND m.status = 'matriculado'
         AND m.data_fim IS NULL
       LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
       WHERE a.id_instituicao = ? AND a.status = 'ativo'
       GROUP BY a.turno`,
      [diaDaSemana, data, inst]
    ),

    // 3. Por transporte: esperados e presentes no dia (agrupado no banco)
    pool.query(
      `SELECT
         a.transporte,
         a.turno,
         COUNT(DISTINCT a.id) AS esperados,
         COUNT(DISTINCT CASE WHEN p.status = 'presente' THEN a.id END) AS presentes
       FROM alunos a
       JOIN matricula m ON a.id = m.idaluno AND TRIM(m.dia_semana) = ? AND m.status = 'matriculado'
         AND m.data_fim IS NULL
       LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
       WHERE a.id_instituicao = ? AND a.status = 'ativo'
       GROUP BY a.transporte, a.turno`,
      [diaDaSemana, data, inst]
    ),

    // 4. Total de ausentes (esperados mas sem presença) — só o número
    pool.query(
      `SELECT COUNT(DISTINCT a.id) AS total
       FROM alunos a
       JOIN matricula m ON a.id = m.idaluno AND TRIM(m.dia_semana) = ? AND m.status = 'matriculado'
         AND m.data_fim IS NULL
       LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
       WHERE a.id_instituicao = ? AND a.status = 'ativo'
         AND (p.status IS NULL OR p.status != 'presente')`,
      [diaDaSemana, data, inst]
    ),

    // 5. Contagem de justificativas por tipo
    pool.query(
      `SELECT 
         COALESCE(p.observacao, 'Sem justificativa') AS justificativa,
         COUNT(DISTINCT a.id) AS quantidade
       FROM alunos a
       JOIN matricula m ON a.id = m.idaluno AND TRIM(m.dia_semana) = ? AND m.status = 'matriculado'
         AND m.data_fim IS NULL
       LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
       WHERE a.id_instituicao = ? AND a.status = 'ativo'
         AND (p.status IS NULL OR p.status != 'presente')
       GROUP BY p.observacao`,
      [diaDaSemana, data, inst]
    ),

    // 6. Total de presenças registradas no dia (apenas status = presente), independente de matrícula
    pool.query(
      `SELECT COUNT(*) as total
       FROM presenca
       WHERE id_instituicao = ? AND DATE(data) = ? AND status = 'presente'`,
      [inst, data]
    ),

    // 7. Lista detalhada de presenças do dia (apenas status = presente), independente de matrícula
    pool.query(
      `SELECT p.id, p.aluno_id, a.nome as aluno_nome, p.status, p.observacao, p.data
       FROM presenca p
       LEFT JOIN alunos a ON p.aluno_id = a.id
       WHERE p.id_instituicao = ? AND DATE(p.data) = ? AND p.status = 'presente'
       ORDER BY a.nome ASC`,
      [inst, data]
    ),

    // 8. Presentes reais por turno do aluno, independente de matrícula para o dia
    pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(a.turno), ''), 'Não Definido') AS turno,
         COUNT(DISTINCT p.aluno_id) AS presentes_reais
       FROM presenca p
       JOIN alunos a ON p.aluno_id = a.id
       WHERE p.id_instituicao = ? AND DATE(p.data) = ? AND p.status = 'presente'
       GROUP BY a.turno`,
      [inst, data]
    ),

    // 9. Alunos ÚNICOS com falta justificada no dia — status literal 'justificado',
    // não "tem alguma observação" (é o mesmo critério do relatório por período).
    pool.query(
      `SELECT COUNT(DISTINCT p.aluno_id) as total
       FROM presenca p
       WHERE p.id_instituicao = ? AND DATE(p.data) = ? AND p.status = 'justificado'`,
      [inst, data]
    ),

    // 10. Alunos marcados como ativo mas SEM NENHUMA matrícula (nem ativa, nem
    // histórica) — sinal de dado incompleto: a ficha existe mas o aluno nunca
    // foi de fato matriculado em turma nenhuma (ex.: import que criou o aluno
    // mas não conseguiu casar a atividade dele com nenhuma turma).
    pool.query(
      `SELECT COUNT(*) as total
       FROM alunos a
       WHERE a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
         AND NOT EXISTS (SELECT 1 FROM matricula m WHERE m.idaluno = a.id)`,
      [inst]
    )
  ]);

  // Monta agrupamento de transporte com breakdown por turno
  const porTransporte = {};
  const normTurno = (t) => {
    const s = String(t || '').toLowerCase();
    if (s.includes('manh')) return 'Manhã';
    if (s.includes('tard')) return 'Tarde';
    if (s.includes('noit')) return 'Noite';
    return t || 'Não Definido';
  };
  for (const row of transporteStatsRes) {
    const transp = row.transporte || 'Não Definido';
    const turno = normTurno(row.turno);
    if (!porTransporte[transp]) porTransporte[transp] = { total: 0, pres: 0, turnos: {} };
    porTransporte[transp].total += row.esperados;
    porTransporte[transp].pres += row.presentes;
    if (!porTransporte[transp].turnos[turno]) porTransporte[transp].turnos[turno] = { total: 0, pres: 0 };
    porTransporte[transp].turnos[turno].total += row.esperados;
    porTransporte[transp].turnos[turno].pres += row.presentes;
  }

  // Totais globais calculados a partir dos agrupamentos por turno
  const totalEsperado = turnoStatsRes.reduce((s, r) => s + r.esperados, 0);
  const totalPresentes = turnoStatsRes.reduce((s, r) => s + r.presentes, 0);

  res.json({
    data,
    dia_semana: diaDaSemana,
    total_ativos_instituicao: ativosRes[0].total,
    total_esperado: totalEsperado,
    total_presentes: totalPresentes,
    total_ausentes: ausentesCountRes[0].total,
    total_justificados: justificadosCountRes[0].total || 0,
    total_ativos_sem_matricula: ativosSemMatriculaRes[0].total || 0,
    total_presencas_registradas: totalPresencasRegistradasRes[0].total,
    lista_presencas_registradas: listaPresencasRegistradasRes,
    presentes_reais_por_turno: presentesReaisPorTurnoRes,
    frequencia_pct: totalEsperado > 0 ? Math.round((totalPresentes / totalEsperado) * 100) : 0,
    por_turno: turnoStatsRes,
    por_transporte: porTransporte,
    justificativas: justificativasRes.map(j => ({
      tipo: j.justificativa,
      quantidade: j.quantidade
    }))
  });
}));

// Consolidado de um período — usado tanto por GET /estatisticas-periodo (seção
// "Estatísticas por Período" do dashboard) quanto por GET /estatisticas-mensais
// (visão mensal, que é o mesmo cálculo com data_inicio/data_fim derivados do mês
// em vez de escolhidos manualmente). Mistura duas unidades de contagem — a
// leitura de cada campo da resposta importa:
//   - "..._alunos"/"total_justificados"/"total_nao_justificados": ALUNOS ÚNICOS
//     (um aluno que faltou 5 dias conta 1 vez).
//   - "..._registros": REGISTROS de presença (uma linha por aluno por dia).
async function calcularEstatisticasPeriodo(inst, data_inicio, data_fim) {
  // Gerar lista de dias letivos no período (excluindo dias_sem_aula)
  const [diasLetivos] = await pool.query(
    `WITH RECURSIVE datas AS (
       SELECT ? as data
       UNION ALL
       SELECT DATE_ADD(data, INTERVAL 1 DAY)
       FROM datas
       WHERE data < ?
     )
     SELECT data FROM datas
     WHERE NOT EXISTS (
       SELECT 1 FROM dias_sem_aula d 
       WHERE d.data = datas.data AND d.id_instituicao = ?
     )`,
    [data_inicio, data_fim, inst]
  );

  // Se não houver dias letivos, retornar zeros
  if (diasLetivos.length === 0) {
    return {
      data_inicio,
      data_fim,
      total_esperados_alunos: 0,
      total_presentes_alunos: 0,
      total_ausentes_alunos: 0,
      total_justificados: 0,
      total_nao_justificados: 0,
      total_esperados_registros: 0,
      total_presentes_registros: 0,
      total_faltas_registros: 0,
      total_justificativas_registros: 0,
      justificativas: [],
      total_dias_letivos: 0,
      media_alunos_dia: 0
    };
  }

  const [
    [presentesRes],
    [presentesTotalRes],
    [esperadosAlunosRes],
    [faltasPorDiaRes],
    [justificativasRes],
    [justificadosAlunosRes]
  ] = await Promise.all([
    // Total de alunos únicos com presença no período (excluindo dias sem aula)
    pool.query(
      `SELECT COUNT(DISTINCT p.aluno_id) as total
       FROM presenca p
       WHERE p.id_instituicao = ? 
         AND p.status = 'presente'
         AND DATE(p.data) BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM dias_sem_aula d 
           WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
         )`,
      [inst, data_inicio, data_fim, inst]
    ),

    // Total de registros de presença no período (cada dia que aluno veio)
    pool.query(
      `SELECT COUNT(*) as total
       FROM presenca p
       WHERE p.id_instituicao = ? 
         AND p.status = 'presente'
         AND DATE(p.data) BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM dias_sem_aula d 
           WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
         )`,
      [inst, data_inicio, data_fim, inst]
    ),

    // Total de alunos esperados no período (matriculados que deveriam ter aula
    // em ALGUM dia letivo do período). Usa QUALQUER matrícula que cobria cada
    // dia (m.data_inicio <= dia <= data_fim, ou ainda ativa se data_fim for
    // NULL) — não só a matrícula ATUAL do aluno. Turma trocada/reorganizada
    // depois não pode apagar retroativamente quem estava matriculado naquele
    // dia (mesmo raciocínio de esperados_por_aluno em GET /estatisticas-mensais).
    pool.query(
      `WITH RECURSIVE datas AS (
         SELECT ? as data
         UNION ALL
         SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
       ),
       dias_letivos AS (
         SELECT data FROM datas
         WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = datas.data AND id_instituicao = ?)
       )
       SELECT COUNT(DISTINCT a.id) as total
       FROM dias_letivos d
       JOIN matricula m ON TRIM(m.dia_semana) = ELT(
           DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
         )
         AND d.data >= m.data_inicio
         AND (m.data_fim IS NULL OR d.data <= m.data_fim)
       JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL`,
      [data_inicio, data_fim, inst, inst]
    ),

    // Total de faltas no período: soma de oportunidades (esperados por dia) menos presenças.
    // NÃO comparar data_inicio com '0000-00-00' ou '' aqui: o servidor roda com
    // sql_mode NO_ZERO_DATE/STRICT_TRANS_TABLES, que rejeita esses literais contra
    // uma coluna DATE com "Incorrect DATE value" — quebra a query inteira, mesmo que
    // nenhuma linha tenha esse valor. Basta checar NULL (data_inicio é DATE, não guarda '').
    pool.query(
      `WITH RECURSIVE datas AS (
        SELECT ? as data
        UNION ALL
        SELECT DATE_ADD(data, INTERVAL 1 DAY)
        FROM datas
        WHERE data < ?
      ),
      dias_letivos AS (
        SELECT data FROM datas
        WHERE NOT EXISTS (
          SELECT 1 FROM dias_sem_aula dsa 
          WHERE dsa.data = datas.data AND dsa.id_instituicao = ?
        )
      ),
      esperados_por_dia AS (
        -- Mesma correção histórica das demais consultas desta função: qualquer
        -- matrícula que cobria aquele dia, não só a atual (ver comentário grande
        -- em esperados_por_aluno, GET /estatisticas-mensais).
        SELECT
          d.data,
          COUNT(DISTINCT a.id) as esperados
        FROM dias_letivos d
        JOIN matricula m ON TRIM(m.dia_semana) = ELT(
            DAYOFWEEK(d.data),
            'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
          )
          AND d.data >= m.data_inicio
          AND (m.data_fim IS NULL OR d.data <= m.data_fim)
        JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
        GROUP BY d.data
      )
      SELECT COALESCE(SUM(esperados), 0) as total
      FROM esperados_por_dia`,
      [data_inicio, data_fim, inst, inst]
    ),

    // Contagem de justificativas por tipo no período — REGISTROS (cada lançamento
    // conta, mesmo repetido pro mesmo aluno). Usado só na lista "justificativas" abaixo.
    pool.query(
      `SELECT
         COALESCE(p.observacao, 'Sem justificativa') AS justificativa,
         COUNT(*) AS quantidade
       FROM presenca p
       WHERE p.id_instituicao = ?
         AND p.status != 'presente'
         AND DATE(p.data) BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM dias_sem_aula d
           WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
         )
       GROUP BY p.observacao`,
      [inst, data_inicio, data_fim, inst]
    ),

    // Alunos ÚNICOS com ao menos uma falta justificada no período — usado no total
    // "por aluno" abaixo. Não pode reaproveitar a soma de registros acima: um aluno
    // justificado em 3 dias diferentes deve contar 1 vez aqui, não 3.
    pool.query(
      `SELECT COUNT(DISTINCT p.aluno_id) as total
       FROM presenca p
       WHERE p.id_instituicao = ?
         AND p.status = 'justificado'
         AND DATE(p.data) BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM dias_sem_aula d
           WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
         )`,
      [inst, data_inicio, data_fim, inst]
    )
  ]);

  // Calcular totais
  const totalPresentesAlunos = presentesRes[0].total || 0;
  const totalPresentesRegistros = presentesTotalRes[0].total || 0;
  const totalEsperadosAlunos = esperadosAlunosRes[0].total || 0;
  // Garantir que ausentes nunca fique negativo
  const totalAusentesAlunos = Math.max(0, totalEsperadosAlunos - totalPresentesAlunos);
  // Total de oportunidades = soma de alunos esperados em cada dia letivo
  const totalOportunidadesRegistros = parseInt(faltasPorDiaRes[0].total || 0, 10);
  // Faltas = oportunidades - presenças
  const totalFaltasRegistros = Math.max(0, totalOportunidadesRegistros - totalPresentesRegistros);
  // Registros de justificativa (cada lançamento, para a lista "justificativas" abaixo)
  const totalJustificativasRegistros = justificativasRes
    .filter(j => j.justificativa !== 'Sem justificativa')
    .reduce((sum, j) => sum + j.quantidade, 0);
  // Alunos únicos justificados (para o total "por aluno")
  const totalJustificados = justificadosAlunosRes[0].total || 0;
  // Não justificados = total de ausentes (por aluno) - justificados (por aluno) — mesma unidade dos dois lados
  const totalNaoJustificados = Math.max(0, totalAusentesAlunos - totalJustificados);
  // Média de alunos esperados por dia letivo
  const mediaAlunosDia = diasLetivos.length > 0 ? Math.round(totalOportunidadesRegistros / diasLetivos.length) : 0;

  return {
    data_inicio,
    data_fim,
    // Por aluno
    total_esperados_alunos: totalEsperadosAlunos,
    total_presentes_alunos: totalPresentesAlunos,
    total_ausentes_alunos: totalAusentesAlunos,
    total_justificados: totalJustificados,
    total_nao_justificados: totalNaoJustificados,
    // Por registro (total de ocorrências — soma de aluno-dia, não alunos distintos)
    total_esperados_registros: totalOportunidadesRegistros,
    total_presentes_registros: totalPresentesRegistros,
    total_faltas_registros: totalFaltasRegistros,
    total_justificativas_registros: totalJustificativasRegistros,
    justificativas: justificativasRes.map(j => ({
      tipo: j.justificativa,
      quantidade: j.quantidade
    })),
    // Info adicional para transparência do cálculo
    total_dias_letivos: diasLetivos.length,
    media_alunos_dia: mediaAlunosDia
  };
}

router.get('/estatisticas-periodo', asyncHandler(async (req, res) => {
  const { data_inicio, data_fim } = req.query;
  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórios' });
  }
  res.json(await calcularEstatisticasPeriodo(req.id_instituicao, data_inicio, data_fim));
}));

// Visão mensal do dashboard (alternador Diário/Mensal): mesmo cálculo de
// /estatisticas-periodo, com data_inicio/data_fim derivados do mês (?mes=YYYY-MM)
// em vez de escolhidos manualmente, mais uma série dia a dia (tendencia_diaria)
// pro gráfico de frequência do mês. Se o mês pedido for o mês corrente, o
// período vai só até hoje — não faz sentido "esperar" presença em dias futuros.
router.get('/estatisticas-mensais', asyncHandler(async (req, res) => {
  const { mes } = req.query; // formato YYYY-MM
  const inst = req.id_instituicao;

  if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
    return res.status(400).json({ error: 'Parâmetro "mes" é obrigatório, no formato YYYY-MM.' });
  }

  const [anoStr, mesStr] = mes.split('-');
  const ano = Number(anoStr);
  const mesNum = Number(mesStr);
  const dataInicio = `${mes}-01`;
  const ultimoDiaDoMes = new Date(ano, mesNum, 0).getDate(); // dia 0 do mês seguinte = último dia deste mês
  const hoje = new Date().toISOString().split('T')[0];
  const dataFimCalendario = `${mes}-${String(ultimoDiaDoMes).padStart(2, '0')}`;
  const dataFim = dataFimCalendario > hoje ? hoje : dataFimCalendario;

  // Mês totalmente no futuro (dataInicio já depois de hoje): não há o que calcular.
  if (dataInicio > hoje) {
    return res.json({
      mes, data_inicio: dataInicio, data_fim: dataInicio,
      total_esperados_alunos: 0, total_presentes_alunos: 0, total_ausentes_alunos: 0,
      total_justificados: 0, total_nao_justificados: 0, total_esperados_registros: 0, total_presentes_registros: 0,
      total_faltas_registros: 0, total_justificativas_registros: 0, justificativas: [],
      total_dias_letivos: 0, media_alunos_dia: 0, tendencia_diaria: [],
      frequencia_por_aluno: [], media_frequencia_individual: 0, total_alunos_com_falta: 0
    });
  }

  const [periodo, [tendenciaDiariaRes], [frequenciaPorAlunoRes], [comFaltaRes]] = await Promise.all([
    calcularEstatisticasPeriodo(inst, dataInicio, dataFim),

    // Série dia a dia (esperados/presentes por dia letivo) — alimenta o
    // gráfico de tendência de frequência do mês.
    pool.query(
      `WITH RECURSIVE datas AS (
         SELECT ? as data
         UNION ALL
         SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
       ),
       dias_letivos AS (
         SELECT data FROM datas
         WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = datas.data AND id_instituicao = ?)
       ),
       esperados_por_dia AS (
         -- Usa QUALQUER matrícula que cobria aquele dia (m.data_inicio <= dia <=
         -- data_fim, ou ainda ativa se data_fim for NULL) — não só a matrícula
         -- ATUAL do aluno. Turma trocada/movida/reorganizada depois não pode
         -- apagar retroativamente quem estava matriculado naquele dia (ver nota
         -- grande abaixo, em esperados_por_aluno).
         SELECT d.data, COUNT(DISTINCT a.id) as esperados
         FROM dias_letivos d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
             DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
           )
           AND d.data >= m.data_inicio
           AND (m.data_fim IS NULL OR d.data <= m.data_fim)
         JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
         GROUP BY d.data
       ),
       presentes_por_dia AS (
         SELECT DATE(p.data) as data, COUNT(DISTINCT p.aluno_id) as presentes
         FROM presenca p
         WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) BETWEEN ? AND ?
         GROUP BY DATE(p.data)
       )
       SELECT dl.data, COALESCE(ep.esperados, 0) as esperados, COALESCE(pp.presentes, 0) as presentes
       FROM dias_letivos dl
       LEFT JOIN esperados_por_dia ep ON ep.data = dl.data
       LEFT JOIN presentes_por_dia pp ON pp.data = dl.data
       ORDER BY dl.data`,
      [dataInicio, dataFim, inst, inst, inst, dataInicio, dataFim]
    ),

    // Frequência REAL por aluno no mês: soma de dias esperados e dias
    // presentes de CADA aluno individualmente (não a conta agregada da
    // instituição) — pedido explícito pra dar dado acionável, não só "quantos
    // vieram pelo menos uma vez" (ver conversa: as médias por período/dia
    // acima escondem quem faltou muito porque outro aluno com frequência alta
    // "compensa" na média agregada).
    pool.query(
      `WITH RECURSIVE datas AS (
         SELECT ? as data
         UNION ALL
         SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
       ),
       dias_letivos AS (
         SELECT data FROM datas
         WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = datas.data AND id_instituicao = ?)
       ),
       esperados_por_aluno AS (
         -- Usa QUALQUER matrícula que cobria aquele dia (m.data_inicio <= dia <=
         -- data_fim, ou ainda ativa se data_fim for NULL), não só a matrícula
         -- ATUAL do aluno. Diferença importante: nesta semana várias matrículas
         -- foram encerradas e recriadas (troca de turma, reorganização de
         -- nomes/áreas) com data_inicio = hoje — se eu olhasse só a matrícula
         -- ativa agora, um aluno trocado de turma dia 30 apareceria como "não
         -- esperado" nos outros 20 dias letivos do mês em que ele SIM estava
         -- matriculado (na turma antiga), inflando a % de frequência acima de
         -- 100% artificialmente. Olhando toda matrícula que já existiu (ativa ou
         -- encerrada) e checando se aquele dia cai dentro do intervalo de
         -- vigência dela, cada dia letivo é creditado à turma certa da época.
         SELECT a.id AS aluno_id, a.nome, COUNT(DISTINCT d.data) AS dias_esperados
         FROM dias_letivos d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
             DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
           )
           AND d.data >= m.data_inicio
           AND (m.data_fim IS NULL OR d.data <= m.data_fim)
         JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
         GROUP BY a.id, a.nome
       ),
       presentes_por_aluno AS (
         SELECT p.aluno_id, COUNT(DISTINCT DATE(p.data)) AS dias_presentes
         FROM presenca p
         WHERE p.id_instituicao = ? AND p.status = 'presente' AND DATE(p.data) BETWEEN ? AND ?
         GROUP BY p.aluno_id
       )
       SELECT ep.aluno_id, ep.nome, ep.dias_esperados, COALESCE(pp.dias_presentes, 0) AS dias_presentes
       FROM esperados_por_aluno ep
       LEFT JOIN presentes_por_aluno pp ON pp.aluno_id = ep.aluno_id
       ORDER BY ep.nome ASC`,
      [dataInicio, dataFim, inst, inst, inst, dataInicio, dataFim]
    ),

    // Alunos ÚNICOS com QUALQUER falta no mês (justificada ou não) — "Faltas
    // no Mês" no card do topo. "Justificados no Mês" (já calculado em
    // calcularEstatisticasPeriodo) é sempre um SUBCONJUNTO deste número, por
    // construção: 'justificado' é um dos dois status somados aqui.
    pool.query(
      `SELECT COUNT(DISTINCT p.aluno_id) as total
       FROM presenca p
       WHERE p.id_instituicao = ?
         AND p.status IN ('ausente', 'justificado')
         AND DATE(p.data) BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM dias_sem_aula d
           WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
         )`,
      [inst, dataInicio, dataFim, inst]
    )
  ]);

  const tendenciaDiaria = tendenciaDiariaRes.map(row => ({
    data: row.data instanceof Date ? row.data.toISOString().split('T')[0] : row.data,
    esperados: row.esperados,
    presentes: row.presentes,
    frequencia_pct: row.esperados > 0 ? Math.round((row.presentes / row.esperados) * 100) : 0
  }));

  const frequenciaPorAluno = frequenciaPorAlunoRes.map(row => ({
    aluno_id: row.aluno_id,
    nome: row.nome,
    dias_esperados: row.dias_esperados,
    dias_presentes: row.dias_presentes,
    dias_falta: Math.max(0, row.dias_esperados - row.dias_presentes),
    frequencia_pct: row.dias_esperados > 0 ? Math.round((row.dias_presentes / row.dias_esperados) * 100) : 0
  }));

  // Média das % INDIVIDUAIS (cada aluno pesa igual) — diferente da conta
  // agregada de frequencia_pct no card do topo, que é dominada por quem tem
  // mais dias esperados. Essa é a "média real" pedida.
  const mediaFrequenciaIndividual = frequenciaPorAluno.length > 0
    ? Math.round(frequenciaPorAluno.reduce((soma, a) => soma + a.frequencia_pct, 0) / frequenciaPorAluno.length)
    : 0;

  const totalComFalta = comFaltaRes[0].total || 0;

  res.json({
    mes, ...periodo,
    tendencia_diaria: tendenciaDiaria,
    frequencia_por_aluno: frequenciaPorAluno,
    media_frequencia_individual: mediaFrequenciaIndividual,
    total_alunos_com_falta: totalComFalta
  });
}));

// Rota leve para histórico geral
// Regra: frequencia = presentes / (soma de alunos_esperados por cada dia letivo)
// Usa DAYOFWEEK do MySQL para cruzar datas com dia_semana sem depender de mapeamento JS
// Exclui dias marcados como dia sem aula (feriados, fins de semana, etc.)
router.get('/historico-geral', asyncHandler(async (req, res) => {
  const inst = req.id_instituicao;

  // 1. Total de presenças confirmadas no período (excluindo dias sem aula)
  const [[totPres]] = await pool.query(
    `SELECT COUNT(*) AS total 
     FROM presenca p
     WHERE p.id_instituicao = ? 
       AND p.status = 'presente'
       AND NOT EXISTS (
         SELECT 1 FROM dias_sem_aula d 
         WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
       )`,
    [inst, inst]
  );

  // 2. Para cada dia letivo (data com pelo menos 1 registro), conta quantos alunos
  //    eram esperados naquele dia da semana — tudo em SQL, sem mapeamento JS.
  //    Exclui dias marcados como dia sem aula.
  //    DAYOFWEEK: 1=Dom, 2=Seg, 3=Ter, 4=Qua, 5=Qui, 6=Sex, 7=Sab
  const [[oportunidadesRes]] = await pool.query(
    `SELECT SUM(esperados_dia) AS total_oportunidades, COUNT(*) AS dias_letivos
     FROM (
       SELECT
         d.dia,
         COUNT(DISTINCT a.id) AS esperados_dia
       FROM (
         SELECT DISTINCT DATE(p.data) AS dia
         FROM presenca p
         WHERE p.id_instituicao = ?
           AND NOT EXISTS (
             SELECT 1 FROM dias_sem_aula ds 
             WHERE ds.data = DATE(p.data) AND ds.id_instituicao = ?
           )
       ) d
       JOIN matricula m ON TRIM(m.dia_semana) = ELT(
         DAYOFWEEK(d.dia),
         'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
       ) AND m.status = 'matriculado'
         AND m.data_fim IS NULL
       JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo'
       GROUP BY d.dia
     ) sub`,
    [inst, inst, inst]
  );

  const totalPresencas = totPres.total || 0;
  const totalOportunidades = oportunidadesRes.total_oportunidades || 0;
  const diasLetivos = oportunidadesRes.dias_letivos || 0;
  const mediaFrequencia = totalOportunidades > 0
    ? Math.round((totalPresencas / totalOportunidades) * 1000) / 10
    : 0;

  res.json({
    total_presencas: totalPresencas,
    total_oportunidades: totalOportunidades,
    dias_letivos: diasLetivos,
    media_frequencia: mediaFrequencia
  });
}));

module.exports = router;