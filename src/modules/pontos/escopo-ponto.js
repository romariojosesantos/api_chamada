// Escopo de acesso a ponto (turma OU atividade interna), compartilhado entre
// pontos.service.js (editar/apagar/visão agregada de pontos) e
// tipos-interno.routes.js (CRUD dos tipos de atividade interna) — as
// duas coisas usam exatamente a mesma regra de "quem pode agir em qual área".
//
// null = sem acesso; '' (string vazia) = coordenador GERAL ou master (todas
// as áreas); qualquer outro valor = só aquela área. Diferenciar "geral" de
// "sem acesso" com '' vs null evita confundir "não é coordenador" com "é
// coordenador de todas as áreas".
function escopoDeAcesso(usuario) {
  if (usuario.perfil === 'master') return '';
  if (usuario.perfil !== 'coordenador') return null;
  return usuario.area_coordenacao || '';
}

module.exports = { escopoDeAcesso };
