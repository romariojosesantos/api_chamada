const express = require('express');
const router = express.Router();
const pool = require('./db');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
    [listaPresencasRegistradasRes]
  ] = await Promise.all([
    // 1. Total de alunos ativos
    pool.query(
      "SELECT COUNT(*) as total FROM alunos WHERE id_instituicao = ? AND status = 'ativo'",
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
    total_presencas_registradas: totalPresencasRegistradasRes[0].total,
    lista_presencas_registradas: listaPresencasRegistradasRes,
    frequencia_pct: totalEsperado > 0 ? Math.round((totalPresentes / totalEsperado) * 100) : 0,
    por_turno: turnoStatsRes,
    por_transporte: porTransporte,
    justificativas: justificativasRes.map(j => ({
      tipo: j.justificativa,
      quantidade: j.quantidade
    }))
  });
}));

// Estatísticas por período com justificativas
router.get('/estatisticas-periodo', asyncHandler(async (req, res) => {
  const { data_inicio, data_fim } = req.query;
  const inst = req.id_instituicao;
  
  if (!data_inicio || !data_fim) {
    return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórios' });
  }

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
    return res.json({
      data_inicio,
      data_fim,
      total_esperados_alunos: 0,
      total_presentes_alunos: 0,
      total_ausentes_alunos: 0,
      total_justificados: 0,
      total_nao_justificados: 0,
      total_presentes_registros: 0,
      total_faltas_registros: 0,
      total_justificativas_registros: 0,
      justificativas: []
    });
  }

  const [
    [presentesRes],
    [presentesTotalRes],
    [esperadosAlunosRes],
    [faltasPorDiaRes],
    [justificativasRes]
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

    // Total de alunos esperados no período (matriculados que deveriam ter aula)
    pool.query(
      `SELECT COUNT(DISTINCT a.id) as total
       FROM alunos a
       JOIN matricula m ON a.id = m.idaluno AND m.status = 'matriculado' AND m.data_fim IS NULL
       LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) BETWEEN ? AND ? 
         AND p.id_instituicao = a.id_instituicao
         AND NOT EXISTS (
           SELECT 1 FROM dias_sem_aula d 
           WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
         )
       WHERE a.id_instituicao = ? AND a.status = 'ativo'`,
      [data_inicio, data_fim, inst, inst]
    ),

    // Total de faltas no período: soma de oportunidades (esperados por dia) menos presenças
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
        SELECT 
          d.data,
          COUNT(DISTINCT a.id) as esperados
        FROM dias_letivos d
        JOIN matricula m ON TRIM(m.dia_semana) = ELT(
            DAYOFWEEK(d.data),
            'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
          ) 
          AND m.status = 'matriculado' 
          AND m.data_fim IS NULL
          AND (
            m.data_inicio IS NULL 
            OR m.data_inicio = '0000-00-00'
            OR m.data_inicio = ''
            OR m.data_inicio <= d.data
          )
        JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo'
        GROUP BY d.data
      )
      SELECT COALESCE(SUM(esperados), 0) as total
      FROM esperados_por_dia`,
      [data_inicio, data_fim, inst, inst]
    ),

    // Contagem de justificativas por tipo no período (apenas de alunos que têm registro de presença não presente)
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
  const totalJustificados = justificativasRes
    .filter(j => j.justificativa !== 'Sem justificativa')
    .reduce((sum, j) => sum + j.quantidade, 0);
  // Não justificados = total de ausentes (por aluno) - justificados
  const totalNaoJustificados = Math.max(0, totalAusentesAlunos - totalJustificados);
  // Média de alunos esperados por dia letivo
  const mediaAlunosDia = diasLetivos.length > 0 ? Math.round(totalOportunidadesRegistros / diasLetivos.length) : 0;

  res.json({
    data_inicio,
    data_fim,
    // Por aluno
    total_esperados_alunos: totalEsperadosAlunos,
    total_presentes_alunos: totalPresentesAlunos,
    total_ausentes_alunos: totalAusentesAlunos,
    total_justificados: totalJustificados,
    total_nao_justificados: totalNaoJustificados,
    // Por registro (total de ocorrências)
    total_presentes_registros: totalPresentesRegistros,
    total_faltas_registros: totalFaltasRegistros,
    total_justificativas_registros: totalJustificados,
    justificativas: justificativasRes.map(j => ({
      tipo: j.justificativa,
      quantidade: j.quantidade
    })),
    // Info adicional para transparência do cálculo
    total_dias_letivos: diasLetivos.length,
    media_alunos_dia: mediaAlunosDia
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