// Tela "Foguinhos" — versão pra equipe (staff) do que o aluno já vê sozinho
// no próprio perfil (ver GET /api/aluno/gamificacao em aluno-gamificacao.js,
// campo `semana_atual`): a fileira de chamas por dia da semana, só que aqui
// pra TODOS os alunos da instituição de uma vez, com navegação entre semanas.
//
// Não existe tabela de "foguinho" — é o mesmo cálculo 100% derivado de
// presença real (matricula + presenca + dias_sem_aula), só que generalizado
// pra vários alunos ao mesmo tempo (mesmo espírito de
// calcularFrequenciaPorAluno em relatorios.js, adaptado pra devolver o
// detalhe dia a dia em vez de só o agregado).
//
// Rota staff normal (montada depois de authMiddleware + x-institution-id em
// _server.js) — não tem nada a ver com o token de aluno usado em
// aluno-gamificacao.js, que só serve pro próprio aluno ver os dados dele.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { hojeBrasil } = require('./data-brasil');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const NOMES_DIA_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Domingo a Sábado da semana que CONTÉM `dataRef` — mesma definição de semana
// já usada em aluno-gamificacao.js, só que parametrizada por uma data de
// referência (em vez de sempre "hoje"), pra dar pra navegar entre semanas.
function limitesSemana(dataRef) {
  const refObj = new Date(`${dataRef}T00:00:00`);
  const inicioObj = new Date(refObj);
  inicioObj.setDate(refObj.getDate() - refObj.getDay());
  const fimObj = new Date(inicioObj);
  fimObj.setDate(inicioObj.getDate() + 6);
  return {
    inicio: inicioObj.toISOString().split('T')[0],
    fim: fimObj.toISOString().split('T')[0]
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const hoje = hojeBrasil();
  const dataRef = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data) ? req.query.data : hoje;
  const { inicio, fim } = limitesSemana(dataRef);

  // Filtros por professor/dia da semana/turno — mesmo conceito de
  // AjusteGrade.js, aplicados na própria junção de matrícula: como o dia da
  // semana da matrícula já precisa bater com o dia da data gerada (ver
  // ELT(DAYOFWEEK...) abaixo), filtrar por dia_semana aqui restringe cada
  // aluno a aparecer só naquele dia específico da semana em vez dos 7.
  const filtroProfessor = String(req.query.professor || '').trim();
  const filtroDiaSemana = String(req.query.dia_semana || '').trim();
  const filtroTurno = String(req.query.turno || '').trim();
  const filtroAtivo = !!(filtroProfessor || filtroDiaSemana || filtroTurno);

  const condicoes = [];
  const paramsCondicoes = [];
  if (filtroDiaSemana) { condicoes.push('TRIM(m.dia_semana) = ?'); paramsCondicoes.push(filtroDiaSemana); }
  if (filtroTurno) { condicoes.push('m.turno = ?'); paramsCondicoes.push(filtroTurno); }
  if (filtroProfessor) { condicoes.push('prof.nome = ?'); paramsCondicoes.push(filtroProfessor); }
  const sqlCondicoesExtra = condicoes.length > 0 ? `AND ${condicoes.join(' AND ')}` : '';

  const [
    [alunosRes],
    [diasRes]
  ] = await Promise.all([
    pool.query(
      `SELECT id, nome, turma, turno FROM alunos
       WHERE id_instituicao = ? AND status = 'ativo' AND excluido_em IS NULL
       ORDER BY nome ASC`,
      [req.id_instituicao]
    ),
    // Mesma CTE de aluno-gamificacao.js (dias_esperados da semana), só que
    // aqui junta com TODOS os alunos da instituição de uma vez em vez de um
    // idaluno fixo — cada aluno só aparece nos dias em que tinha aula
    // esperada (dia_semana com matrícula ativa, fora de dias_sem_aula).
    // LEFT JOIN em atividades/professores só entra de verdade na filtragem
    // quando o filtro de professor está ativo (sqlCondicoesExtra) — nos
    // outros casos não muda o resultado, só participa da query.
    pool.query(
      `WITH RECURSIVE datas AS (
         SELECT ? as data
         UNION ALL
         SELECT DATE_ADD(data, INTERVAL 1 DAY) FROM datas WHERE data < ?
       ),
       esperados AS (
         SELECT DISTINCT a.id AS aluno_id, d.data
         FROM datas d
         JOIN matricula m ON TRIM(m.dia_semana) = ELT(
             DAYOFWEEK(d.data), 'Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'
           )
           AND d.data >= m.data_inicio
           AND (m.data_fim IS NULL OR d.data <= m.data_fim)
         JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
         LEFT JOIN atividades atv ON atv.idatividades = m.idatividades
         LEFT JOIN professores prof ON prof.id = atv.idprofessor
         WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = d.data AND id_instituicao = ?)
         ${sqlCondicoesExtra}
       )
       SELECT e.aluno_id, e.data,
         -- MAX+GROUP BY em vez de só LEFT JOIN: se por algum motivo existir
         -- mais de uma linha de presença pro mesmo aluno no mesmo dia (ex.:
         -- correção manual duplicada), o JOIN cru multiplicaria essa (aluno,
         -- data) em mais de uma linha de saída — quebrando a key do React no
         -- front (cada dia deveria aparecer só uma vez por aluno).
         MAX(CASE WHEN p.status = 'presente' THEN 1 ELSE 0 END) AS presente
       FROM esperados e
       LEFT JOIN presenca p ON p.aluno_id = e.aluno_id AND DATE(p.data) = e.data
       GROUP BY e.aluno_id, e.data
       ORDER BY e.aluno_id, e.data ASC`,
      [inicio, fim, req.id_instituicao, req.id_instituicao, ...paramsCondicoes]
    )
  ]);

  const diasPorAluno = new Map();
  for (const row of diasRes) {
    const dataStr = row.data instanceof Date ? row.data.toISOString().split('T')[0] : row.data;
    const estado = row.presente ? 'presente' : (dataStr >= hoje ? 'futuro' : 'falta');
    const dia = { data: dataStr, dia_semana_curto: NOMES_DIA_CURTO[new Date(`${dataStr}T00:00:00`).getDay()], estado };
    if (!diasPorAluno.has(row.aluno_id)) diasPorAluno.set(row.aluno_id, []);
    diasPorAluno.get(row.aluno_id).push(dia);
  }

  // Com filtro ativo, só mostra quem realmente bateu com ele (senão a tela
  // ficaria cheia de alunos "sem aula esperada" de outros professores/turnos
  // — sem filtro, mantém a lista cheia de sempre, cada um com seus próprios dias).
  let alunos = alunosRes.map(a => ({
    id: a.id,
    nome: a.nome,
    turma: a.turma,
    turno: a.turno,
    dias: diasPorAluno.get(a.id) || []
  }));
  if (filtroAtivo) alunos = alunos.filter(a => a.dias.length > 0);

  res.json({ inicio_semana: inicio, fim_semana: fim, alunos });
}));

module.exports = router;
