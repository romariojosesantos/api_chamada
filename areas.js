// Áreas de atuação de uma turma (ver coluna `area` em `atividades`) — lista
// única compartilhada entre a validação de criação/edição manual
// (atividades.js) e o import em massa por planilha (alunos.js), pra não
// divergir. Mesmos valores da lista AREAS do frontend (utils/areas.js).
const AREAS_VALIDAS = ['educacional', 'esportivo', 'cultural', 'tecnologico', 'capelania'];

module.exports = { AREAS_VALIDAS };
