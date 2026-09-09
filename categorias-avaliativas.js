// Categorias pedagógicas de avaliação (lançamento de notas — ver notas.js) —
// diferente de `area` (backend/areas.js): área tem 5 valores (educacional/
// esportivo/cultural/tecnologico/capelania) e serve pros filtros/relatórios
// gerais; categoria avaliativa tem também 5, mas separa "cultural" em três
// (a área cultural mistura teoria, instrumento e dança, que pra fins de nota
// são avaliados separadamente) e não inclui tecnologico/capelania (não
// fazem parte dessa avaliação, por decisão do usuário).
const CATEGORIAS_VALIDAS = ['educacional', 'esportivo', 'cul_teoria', 'cul_pratica', 'danca'];

const CATEGORIA_LABEL = {
  educacional: 'Educacional',
  esportivo: 'Esporte',
  cul_teoria: 'Cultura/Teoria',
  cul_pratica: 'Cultura/Prática',
  danca: 'Dança'
};

// Deriva a categoria avaliativa de uma turma a partir da área (já populada
// em `atividades.area`, ver backend/areas.js e o import em massa que a
// preenche) + prefixo do nome, só pra separar o que "cultural" mistura.
// Retorna null pra área tecnologico/capelania/sem área — essas não entram
// nessa avaliação.
function categoriaDaTurma({ area, nome }) {
  if (area === 'educacional') return 'educacional';
  if (area === 'esportivo') return 'esportivo';
  if (area === 'cultural') {
    const n = String(nome || '').trim();
    if (/^teoria\b/i.test(n)) return 'cul_teoria';
    if (/^dan[çc]a\b/i.test(n)) return 'danca';
    return 'cul_pratica';
  }
  return null;
}

module.exports = { CATEGORIAS_VALIDAS, CATEGORIA_LABEL, categoriaDaTurma };
