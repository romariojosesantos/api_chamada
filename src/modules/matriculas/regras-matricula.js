// Regra única de compatibilidade de turno entre aluno e turma — usada por toda
// rota que grava uma linha em `matricula` (matriculas.js: /matricular, /mover,
// POST / da grade em lote; alunos.js: upsert-bulk). Antes cada rota reimplementava
// essa checagem por conta própria, e por isso ficava fácil esquecer numa rota
// nova — ver PR que introduziu este arquivo.
//
// "Noite" é sempre permitido pra qualquer turno de aluno porque, hoje, só os
// ensaios usam turno "Noite" (nenhum aluno tem "Noite" como turno principal) —
// é a única exceção real à regra de "só matricula no próprio turno". Se um dia
// surgir uma atividade noturna que NÃO seja ensaio e devesse respeitar o turno
// do aluno normalmente, essa exceção implícita precisa virar uma coluna
// explícita em `atividades` (ex.: categoria/flag) em vez de depender do texto
// "Noite".
function podeMatricular(turnoAluno, turnoTurma) {
  if (!turnoAluno || !turnoTurma) return true; // dado incompleto — deixa passar, mesmo comportamento de antes
  if (String(turnoTurma).trim().toLowerCase() === 'noite') return true; // ensaio — exceção
  return String(turnoAluno).trim().toLowerCase() === String(turnoTurma).trim().toLowerCase();
}

module.exports = { podeMatricular };
