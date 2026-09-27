// Lado "de" ou "para" de uma movimentação, no formato salvo em
// notificacoes.detalhes (a tela de notificações mostra de qual turma para qual).
function descreverTurma({ nome, nome_professor, dia_semana, horario, turno }) {
  return { turma: nome, professor: nome_professor || null, dia_semana, horario, turno };
}

module.exports = { descreverTurma };
