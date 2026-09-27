// Compara os nomes da planilha com os já cadastrados (ver resolverNomeParecido):
//  - só acento/maiúscula/espaço diferente -> usa o nome cadastrado e reporta em `corrigidos`;
//  - parecido, mas não o bastante -> mantém o da planilha e avisa em `suspeitos`.
// Nome de turma não passa por aqui: varia de propósito entre turmas.
const { resolverNomeParecido } = require('../../../utils/nome-similar');

function criarResolvedorDeNomes() {
  const corrigidos = { alunos: [], professores: [] };
  const suspeitos = { alunos: [], professores: [] };
  const jaReportado = new Set(); // o mesmo professor aparece em várias linhas

  function resolver(categoria, nomeOriginal, nomesExistentes) {
    const chave = `${categoria}:${nomeOriginal}`;
    const lista = categoria === 'aluno' ? 'alunos' : 'professores';
    const resultado = resolverNomeParecido(nomeOriginal, nomesExistentes);

    if (resultado.tipo === 'corrigido') {
      if (!jaReportado.has(chave)) {
        jaReportado.add(chave);
        corrigidos[lista].push({ enviado: nomeOriginal, corrigido_para: resultado.nome });
      }
      return resultado.nome;
    }
    if (resultado.tipo === 'suspeita' && !jaReportado.has(chave)) {
      jaReportado.add(chave);
      suspeitos[lista].push({ enviado: nomeOriginal, parecido_com: resultado.nome });
    }
    return nomeOriginal;
  }

  return { resolver, corrigidos, suspeitos };
}

module.exports = { criarResolvedorDeNomes };
