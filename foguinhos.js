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

  // Filtros por professor/dia da semana/turno — SÓ decidem quais ALUNOS
  // aparecem na lista (quem tem uma matrícula batendo com o filtro nesta
  // semana). Não filtram os dias mostrados: cada aluno que aparecer continua
  // mostrando a semana inteira dele (ver diasRes abaixo, que roda sem nenhuma
  // dessas condições de propósito — pedido explícito do usuário).
  const filtroProfessor = String(req.query.professor || '').trim();
  const filtroDiaSemana = String(req.query.dia_semana || '').trim();
  const filtroTurno = String(req.query.turno || '').trim();
  const filtroAtivo = !!(filtroProfessor || filtroDiaSemana || filtroTurno);

  const condicoesFiltro = ['m.data_inicio <= ?', '(m.data_fim IS NULL OR m.data_fim >= ?)'];
  const paramsFiltro = [fim, inicio];
  if (filtroDiaSemana) { condicoesFiltro.push('TRIM(m.dia_semana) = ?'); paramsFiltro.push(filtroDiaSemana); }
  if (filtroTurno) { condicoesFiltro.push('m.turno = ?'); paramsFiltro.push(filtroTurno); }
  if (filtroProfessor) { condicoesFiltro.push('prof.nome = ?'); paramsFiltro.push(filtroProfessor); }

  const [
    [alunosRes],
    [diasRes],
    [idsFiltradosRes]
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
    // esperada (dia_semana com matrícula ativa, fora de dias_sem_aula). Roda
    // SEM os filtros de professor/dia/turno — sempre a semana completa.
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
         WHERE NOT EXISTS (SELECT 1 FROM dias_sem_aula WHERE data = d.data AND id_instituicao = ?)
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
      [inicio, fim, req.id_instituicao, req.id_instituicao]
    ),
    // Query separada e bem mais simples, só pra saber QUEM entra na lista
    // quando algum filtro está ativo — não precisa das datas dia a dia, só
    // se o aluno tem alguma matrícula (válida nesta semana) batendo com
    // professor/dia/turno escolhidos.
    filtroAtivo
      ? pool.query(
          `SELECT DISTINCT a.id AS aluno_id
           FROM matricula m
           JOIN alunos a ON a.id = m.idaluno AND a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL
           LEFT JOIN atividades atv ON atv.idatividades = m.idatividades
           LEFT JOIN professores prof ON prof.id = atv.idprofessor
           WHERE ${condicoesFiltro.join(' AND ')}`,
          [req.id_instituicao, ...paramsFiltro]
        )
      : Promise.resolve([[]])
  ]);

  const diasPorAluno = new Map();
  for (const row of diasRes) {
    const dataStr = row.data instanceof Date ? row.data.toISOString().split('T')[0] : row.data;
    const estado = row.presente ? 'presente' : (dataStr >= hoje ? 'futuro' : 'falta');
    const dia = { data: dataStr, dia_semana_curto: NOMES_DIA_CURTO[new Date(`${dataStr}T00:00:00`).getDay()], estado };
    if (!diasPorAluno.has(row.aluno_id)) diasPorAluno.set(row.aluno_id, []);
    diasPorAluno.get(row.aluno_id).push(dia);
  }

  let alunos = alunosRes.map(a => ({
    id: a.id,
    nome: a.nome,
    turma: a.turma,
    turno: a.turno,
    dias: diasPorAluno.get(a.id) || []
  }));
  if (filtroAtivo) {
    const idsFiltrados = new Set(idsFiltradosRes.map(r => r.aluno_id));
    alunos = alunos.filter(a => idsFiltrados.has(a.id));
  }

  res.json({ inicio_semana: inicio, fim_semana: fim, alunos });
}));

module.exports = router;
