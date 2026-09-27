// Dados complementares da planilha: nível, situação anual, saúde e responsável.
// Todas as colunas são opcionais: célula vazia não mexe no que já existe.
const model = require('./importacao.model');
const {
  nomeDaLinha,
  lerNivel,
  lerSituacaoAnual,
  lerObservacoesSaude,
  lerResponsavel,
} = require('./planilha');

// Percorre as linhas cujo aluno foi encontrado no banco.
function* linhasComAluno(alunos, alunoPorNome) {
  for (const linha of alunos) {
    const idAluno = alunoPorNome.get(nomeDaLinha(linha))?.id;
    if (idAluno) yield [linha, idAluno];
  }
}

// Nível tem histórico (data_inicio/data_fim): se mudou, fecha o atual e abre
// outro. Sem subnível na linha, mantém o subnível que já estava salvo.
async function atualizarNiveis(db, alunos, alunoPorNome, hoje, idInstituicao) {
  const lidos = [];
  let foraDeFaixa = 0;
  for (const [linha, idAluno] of linhasComAluno(alunos, alunoPorNome)) {
    const nivel = lerNivel(linha);
    if (!nivel) continue;
    if (nivel.foraDeFaixa) {
      foraDeFaixa++;
      continue;
    }
    lidos.push({ idAluno, ...nivel });
  }
  if (lidos.length === 0) return { afetados: 0, foraDeFaixa };

  const ids = [...new Set(lidos.map((n) => n.idAluno))];
  const abertos = await model.niveisAbertos(db, ids, idInstituicao);
  const atualPorAluno = new Map(abertos.map((n) => [n.id_aluno, n]));

  const aFechar = [];
  const aAbrir = [];
  for (const item of lidos) {
    const atual = atualPorAluno.get(item.idAluno);
    const subnivel = item.subnivel !== null ? item.subnivel : atual ? atual.subnivel : null;
    const mudou =
      !atual || atual.nivel !== item.nivel || (atual.subnivel || null) !== (subnivel || null);
    if (!mudou) continue;
    if (atual) aFechar.push(atual.id);
    aAbrir.push([idInstituicao, item.idAluno, item.nivel, subnivel, hoje]);
  }

  if (aFechar.length > 0) await model.encerrarNiveis(db, aFechar, hoje);
  const afetados = aAbrir.length > 0 ? await model.inserirNiveis(db, aAbrir) : 0;
  return { afetados, foraDeFaixa };
}

// Situação de matrícula/dívida por ano: upsert por (aluno, ano), então cada
// ano novo vira uma linha nova e forma o histórico.
async function salvarSituacoesAnuais(db, alunos, alunoPorNome, ano, idInstituicao) {
  const valores = [];
  for (const [linha, idAluno] of linhasComAluno(alunos, alunoPorNome)) {
    const situacao = lerSituacaoAnual(linha);
    if (!situacao) continue;
    valores.push([
      idInstituicao,
      idAluno,
      ano,
      situacao.situacaoMatricula,
      situacao.situacaoDivida,
    ]);
  }
  return valores.length > 0 ? model.upsertSituacoesAnuais(db, valores) : 0;
}

// Saúde é aditiva: só insere o que o aluno ainda não tem, nunca apaga (dado
// sensível não pode sumir porque a coluna veio vazia numa reimportação).
async function adicionarObservacoesSaude(db, alunos, alunoPorNome, idInstituicao) {
  const lidas = [];
  for (const [linha, idAluno] of linhasComAluno(alunos, alunoPorNome)) {
    const descricoes = lerObservacoesSaude(linha);
    if (descricoes.length > 0) lidas.push({ idAluno, descricoes });
  }
  if (lidas.length === 0) return 0;

  const ids = [...new Set(lidas.map((s) => s.idAluno))];
  const existentes = await model.observacoesSaude(db, ids, idInstituicao);
  const jaTemPorAluno = new Map();
  for (const row of existentes) {
    const descricoes = jaTemPorAluno.get(row.id_aluno) || new Set();
    descricoes.add(row.descricao.trim().toLowerCase());
    jaTemPorAluno.set(row.id_aluno, descricoes);
  }

  const novas = [];
  for (const { idAluno, descricoes } of lidas) {
    const jaTem = jaTemPorAluno.get(idAluno) || new Set();
    for (const descricao of descricoes) {
      if (jaTem.has(descricao.toLowerCase())) continue;
      novas.push([idInstituicao, idAluno, descricao]);
      jaTem.add(descricao.toLowerCase());
    }
  }
  return novas.length > 0 ? model.inserirObservacoesSaude(db, novas) : 0;
}

// Um responsável legal por aluno, sem histórico.
async function salvarResponsaveis(db, alunos, alunoPorNome, idInstituicao) {
  const valores = [];
  for (const [linha, idAluno] of linhasComAluno(alunos, alunoPorNome)) {
    const r = lerResponsavel(linha);
    if (!r) continue;
    valores.push([
      idInstituicao,
      idAluno,
      r.nome,
      r.cpf,
      r.rg,
      r.data_nascimento,
      r.email,
      r.endereco,
      r.bairro,
      r.cep,
      r.telefone,
    ]);
  }
  return valores.length > 0 ? model.upsertResponsaveis(db, valores) : 0;
}

module.exports = {
  atualizarNiveis,
  salvarSituacoesAnuais,
  adicionarObservacoesSaude,
  salvarResponsaveis,
};
