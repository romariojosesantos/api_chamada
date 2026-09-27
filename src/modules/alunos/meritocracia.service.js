// Ranking de meritocracia: 1 ponto por dia presente no período, com desconto
// pelas ocorrências de comportamento (leve -25%, grave -50%, gravíssima -100%,
// limitado a 100%).
const model = require('./alunos.model');
const { calcularFrequenciaPorAluno } = require('../relatorios/periodo.service');

function montarRanking(alunos, frequencias, ocorrencias) {
  const alunoPorId = new Map(alunos.map((a) => [a.id, a]));
  const ocorrenciasPorAluno = new Map();
  for (const o of ocorrencias) {
    if (!ocorrenciasPorAluno.has(o.id_aluno)) ocorrenciasPorAluno.set(o.id_aluno, []);
    ocorrenciasPorAluno.get(o.id_aluno).push(o);
  }

  return frequencias
    .filter((f) => alunoPorId.has(f.aluno_id))
    .map((f) => {
      const aluno = alunoPorId.get(f.aluno_id);
      const ocorrenciasDoAluno = ocorrenciasPorAluno.get(f.aluno_id) || [];
      const descontoPct = Math.min(
        100,
        ocorrenciasDoAluno.reduce((soma, o) => soma + o.percentual_aplicado, 0),
      );
      const pontosBase = f.dias_presentes;
      const pontosFinais = Math.round(pontosBase * (1 - descontoPct / 100) * 10) / 10;
      return {
        id: aluno.id,
        nome: aluno.nome,
        turno: aluno.turno,
        nivel: aluno.nivel,
        subnivel: aluno.subnivel,
        dias_esperados: f.dias_esperados,
        dias_presentes: f.dias_presentes,
        pontos_base: pontosBase,
        desconto_pct: descontoPct,
        pontos_finais: pontosFinais,
        ocorrencias: ocorrenciasDoAluno,
      };
    })
    .sort((a, b) => b.pontos_finais - a.pontos_finais || a.nome.localeCompare(b.nome, 'pt-BR'));
}

async function calcular(idInstituicao, inicio, fim) {
  const [alunos, frequencias, ocorrencias] = await Promise.all([
    model.ativosComNivel(idInstituicao),
    calcularFrequenciaPorAluno(idInstituicao, inicio, fim),
    model.ocorrenciasNoPeriodo(idInstituicao, inicio, fim),
  ]);
  return montarRanking(alunos, frequencias, ocorrencias);
}

module.exports = { calcular, montarRanking };
