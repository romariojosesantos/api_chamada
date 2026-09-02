// Dados da tela de perfil/gamificação do aluno (ver GET /api/aluno/gamificacao)
// — tudo calculado a partir de presença real, sem sistema de pontos inventado:
//   - Sequência (streak): dias letivos ESPERADOS consecutivos com presença
//     confirmada, contando pra trás a partir de hoje. Qualquer dia esperado
//     sem presença (falta, justificada, ou sem registro nenhum) quebra a
//     sequência.
//   - Frequência do mês: mesmo cálculo "real" (dias presentes ÷ dias
//     esperados) já usado no dashboard de relatórios do time — ver
//     relatorios.js, esperados_por_aluno/presentes_por_aluno.
//   - Medalhas de sequência: 2 critérios objetivos derivados do streak, sem
//     nada subjetivo.
//   - Meses Perfeitos: mural com um card por mês FECHADO em que o aluno
//     bateu 100% de frequência (ver JANELA_MURAL_MESES) — cresce com o
//     tempo, substituiu a antiga medalha única "Mês Perfeito".
const express = require('express');
const router = express.Router();
const pool = require('./db');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const JANELA_STREAK_DIAS = 90; // olha só os últimos 90 dias pra trás — suficiente pra qualquer streak realista de uma instituição, sem escanear o histórico inteiro
const JANELA_MURAL_MESES = 24; // mural de "Meses Perfeitos" olha só os últimos 24 meses fechados pra trás
const NOMES_MES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

router.get('/gamificacao', asyncHandler(async (req, res) => {
  if (req.user.perfil !== 'aluno') {
    return res.status(403).json({ error: 'Rota exclusiva para alunos.' });
  }
  const alunoId = req.user.aluno_id;
  const idInstituicao = req.user.id_instituicao;
  const hoje = new Date().toISOString().split('T')[0];
  const inicioMesAtual = `${hoje.slice(0, 7)}-01`;

  // Semana atual (Domingo a Sábado) pra desenhar a fileira de chamas no
  // perfil: só os dias em que o aluno tem aula esperada nessa semana.
  const hojeObj = new Date(`${hoje}T00:00:00`);
  const inicioSemanaObj = new Date(hojeObj);
  inicioSemanaObj.setDate(hojeObj.getDate() - hojeObj.getDay());
  const fimSemanaObj = new Date(inicioSemanaObj);
  fimSemanaObj.setDate(inicioSemanaObj.getDate() + 6);
  const inicioSemana = inicioSemanaObj.toISOString().split('T')[0];
  const fimSemana = fimSemanaObj.toISOString().split('T')[0];

  // Mural de "Meses Perfeitos": um card por mês FECHADO (não o corrente, que
  // ainda está em andamento — ver comentário na medalha antiga que isso
  // substituiu) em que o aluno bateu 100% de frequência. Olha só os últimos
  // JANELA_MURAL_MESES meses pra trás — histórico relevante sem escanear a
  // matrícula inteira do aluno.
  const fimMuralObj = new Date(`${inicioMesAtual}T00:00:00`);
  fimMuralObj.setDate(0); // último dia do mês anterior ao corrente
  const fimMural = fimMuralObj.toISOString().split('T')[0];
  const inicioMuralObj = new Date(fimMuralObj.getFullYear(), fimMuralObj.getMonth() - (JANELA_MURAL_MESES - 1), 1);
  const inicioMural = inicioMuralObj.toISOString().split('T')[0];

  const [
    [diasEsperadosRes],
    [statsMesRes],
    [atividadeRecenteRes],
    [semanaAtualRes],
    [diasPorSemanaRes],
    [mesesPerfeitosRes]
  ] = await Promise.all([
    // Dias esperados (com o status de presença daquele dia, se houver) nos
    // últimos 90 dias, do mais recente pro mais antigo — a JS varre essa
    // lista contando a sequência.
    pool.query(
      `WITH RECURSIVE datas AS (
         SELECT DATE_SUB(?, INTERVAL ${JANELA_STREAK_DIAS} DAY) as data
         UNION ALL
         SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
       ),
       dias_letivos AS (
         SELECT data FROM datas
         WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = datas.data AND id_instituicao = ?)
       ),
       dias_esperados AS (
         SELECT DISTINCT d.data
         FROM dias_letivos d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
             DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
           )
           AND d.data >= m.data_inicio
           AND (m.data_fim IS NULL OR d.data <= m.data_fim)
         WHERE m.idaluno = ?
       )
       SELECT de.data, p.status
       FROM dias_esperados de
       LEFT JOIN presenca p ON p.aluno_id = ? AND DATE(p.data) = de.data
       ORDER BY de.data DESC`,
      [hoje, hoje, idInstituicao, alunoId, alunoId]
    ),

    // Frequência do mês corrente (mesma lógica "real" do dashboard, aqui pra
    // um único aluno): dias esperados x dias presentes desde o dia 1.
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
       dias_esperados AS (
         SELECT DISTINCT d.data
         FROM dias_letivos d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
             DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
           )
           AND d.data >= m.data_inicio
           AND (m.data_fim IS NULL OR d.data <= m.data_fim)
         WHERE m.idaluno = ?
       )
       SELECT
         (SELECT COUNT(*) FROM dias_esperados) AS dias_esperados,
         -- Conta só presença em dias que ESTÃO em dias_esperados (não um
         -- range de datas cru) — garante presentes <= esperados por
         -- construção, mesmo se um dia for marcado "sem aula" DEPOIS da
         -- presença já ter sido lançada nele (dias_esperados já exclui esse
         -- dia; contar direto de presenca sem passar por ali não excluiria).
         (SELECT COUNT(*) FROM dias_esperados de
          WHERE EXISTS (
            SELECT 1 FROM presenca p
            WHERE p.aluno_id = ? AND p.status = 'presente' AND DATE(p.data) = de.data
          )
         ) AS dias_presentes`,
      [inicioMesAtual, hoje, idInstituicao, alunoId, alunoId]
    ),

    // Últimos registros de presença, pro feed "Atividade" — presenca não
    // guarda qual turma foi (ver comentário no topo do arquivo), então mostra
    // só data + status, sem inventar uma turma que pode nem ser a certa
    // (o aluno pode ter mais de uma turma no mesmo dia).
    pool.query(
      `SELECT data, status, observacao
       FROM presenca
       WHERE aluno_id = ? AND id_instituicao = ?
       ORDER BY data DESC
       LIMIT 10`,
      [alunoId, idInstituicao]
    ),

    // Dias esperados dessa semana (Dom-Sáb), com o status de presença de cada
    // um — a UI classifica em aceso/apagado/riscado a partir disso.
    pool.query(
      `WITH RECURSIVE datas AS (
         SELECT ? as data
         UNION ALL
         SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
       ),
       dias_esperados AS (
         SELECT DISTINCT d.data
         FROM datas d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
             DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
           )
           AND d.data >= m.data_inicio
           AND (m.data_fim IS NULL OR d.data <= m.data_fim)
         WHERE m.idaluno = ?
           AND NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = d.data AND id_instituicao = ?)
       )
       SELECT de.data, p.status
       FROM dias_esperados de
       LEFT JOIN presenca p ON p.aluno_id = ? AND DATE(p.data) = de.data
       ORDER BY de.data ASC`,
      [inicioSemana, fimSemana, alunoId, idInstituicao, alunoId]
    ),

    // Quantos dias por semana esse aluno tem aula hoje em dia (independe de
    // feriado pontual) — usado como meta da medalha "Uma Semana Firme" em vez
    // de um "7 dias" fixo, já que cada aluno tem uma grade diferente.
    pool.query(
      `SELECT COUNT(DISTINCT dia_semana) AS total
       FROM matricula
       WHERE idaluno = ? AND ? >= data_inicio AND (data_fim IS NULL OR ? <= data_fim)`,
      [alunoId, hoje, hoje]
    ),

    // Dias esperados x presentes de cada mês fechado dentro da janela do
    // mural, já agrupados por mês (uma única varredura diária do intervalo
    // inteiro, sem repetir a CTE recursiva mês a mês).
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
       dias_esperados AS (
         SELECT DISTINCT d.data
         FROM dias_letivos d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
             DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
           )
           AND d.data >= m.data_inicio
           AND (m.data_fim IS NULL OR d.data <= m.data_fim)
         WHERE m.idaluno = ?
       )
       SELECT
         DATE_FORMAT(de.data, '%Y-%m') AS mes,
         COUNT(*) AS dias_esperados,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM presenca p
           WHERE p.aluno_id = ? AND p.status = 'presente' AND DATE(p.data) = de.data
         ) THEN 1 ELSE 0 END) AS dias_presentes
       FROM dias_esperados de
       GROUP BY DATE_FORMAT(de.data, '%Y-%m')
       ORDER BY mes ASC`,
      [inicioMural, fimMural, idInstituicao, alunoId, alunoId]
    )
  ]);

  // Sequência atual: varre do mais recente pro mais antigo, para no primeiro
  // dia esperado sem presença confirmada.
  let streakAtual = 0;
  for (const dia of diasEsperadosRes) {
    if (dia.status === 'presente') streakAtual++;
    else break;
  }

  // Estado de cada dia esperado da semana: 'presente' (chama acesa), 'falta'
  // (dia já passado sem presença confirmada — chama riscada) ou 'futuro'
  // (hoje sem registro ainda, ou dia que ainda vai chegar — chama apagada).
  const NOMES_DIA_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const semanaAtual = semanaAtualRes.map(row => {
    const dataStr = row.data instanceof Date ? row.data.toISOString().split('T')[0] : row.data;
    const estado = row.status === 'presente' ? 'presente' : (dataStr >= hoje ? 'futuro' : 'falta');
    return {
      data: dataStr,
      dia_semana_curto: NOMES_DIA_CURTO[new Date(`${dataStr}T00:00:00`).getDay()],
      estado
    };
  });

  const diasEsperadosMes = statsMesRes[0].dias_esperados || 0;
  const diasPresentesMes = statsMesRes[0].dias_presentes || 0;
  const frequenciaMesPct = diasEsperadosMes > 0 ? Math.round((diasPresentesMes / diasEsperadosMes) * 100) : 0;
  const diasPorSemana = diasPorSemanaRes[0].total || 0;
  // Meta de "um mês" derivada da mesma cadência semanal (4,345 semanas por
  // mês em média) em vez do total de dias esperados NO MÊS CORRENTE — esse
  // total cresce 1 a 1 conforme o mês avança, o que faria a medalha
  // desbloquear quase de graça logo no início de cada mês.
  const diasPorMes = Math.round(diasPorSemana * 4.345);

  // Só entram no mural os meses com dia esperado (aluno matriculado) E 100%
  // de presença neles — cresce com o tempo, sem expor os meses que não deram certo.
  const mesesPerfeitos = mesesPerfeitosRes
    .filter(r => r.dias_esperados > 0 && r.dias_presentes === r.dias_esperados)
    .map(r => {
      const [ano, mesNum] = r.mes.split('-').map(Number);
      return { mes: r.mes, label: `${NOMES_MES_ABREV[mesNum - 1]}/${String(ano).slice(2)}` };
    });

  const medalhas = [
    {
      id: 'streak_7',
      titulo: 'Uma Semana Firme',
      descricao: `${diasPorSemana} dia${diasPorSemana === 1 ? '' : 's'} seguido${diasPorSemana === 1 ? '' : 's'} de presença`,
      desbloqueada: diasPorSemana > 0 && streakAtual >= diasPorSemana,
      progresso: Math.min(streakAtual, diasPorSemana),
      meta: diasPorSemana
    },
    {
      id: 'streak_30',
      titulo: 'Um Mês de Dedicação',
      descricao: `${diasPorMes} dia${diasPorMes === 1 ? '' : 's'} seguido${diasPorMes === 1 ? '' : 's'} de presença`,
      desbloqueada: diasPorMes > 0 && streakAtual >= diasPorMes,
      progresso: Math.min(streakAtual, diasPorMes),
      meta: diasPorMes
    }
  ];

  res.json({
    streak_atual: streakAtual,
    semana_atual: semanaAtual,
    frequencia_mes_pct: frequenciaMesPct,
    dias_esperados_mes: diasEsperadosMes,
    dias_presentes_mes: diasPresentesMes,
    medalhas,
    medalhas_desbloqueadas: medalhas.filter(m => m.desbloqueada).length,
    meses_perfeitos: mesesPerfeitos,
    atividade_recente: atividadeRecenteRes.map(a => ({
      data: a.data instanceof Date ? a.data.toISOString().split('T')[0] : a.data,
      status: a.status,
      observacao: a.observacao
    }))
  });
}));

module.exports = router;
