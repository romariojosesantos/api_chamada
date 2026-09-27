// Escopo de acesso a ponto (turma OU atividade interna), compartilhado entre
// backend/pontos.js (editar/apagar/visão agregada de pontos) e
// backend/tiposPontoInterno.js (CRUD dos tipos de atividade interna) — as
// duas coisas usam exatamente a mesma regra de "quem pode agir em qual área".
//
// null = sem acesso; '' (string vazia) = coordenador GERAL ou master (todas
// as áreas); qualquer outro valor = só aquela área. Diferenciar "geral" de
// "sem acesso" com '' vs null evita confundir "não é coordenador" com "é
// coordenador de todas as áreas".
function escopoDeAcesso(req) {
  if (req.user.perfil === 'master') return '';
  if (req.user.perfil !== 'coordenador') return null;
  return req.user.area_coordenacao || '';
}

module.exports = { escopoDeAcesso };
