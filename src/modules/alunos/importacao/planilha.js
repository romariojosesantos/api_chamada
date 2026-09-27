// Leitura das linhas da planilha de importação (funções puras, sem banco).
// O front manda os cabeçalhos em minúsculo (ver GerenciarMatriculas.js).
const AppError = require('../../../utils/AppError');
const {
  parseDataNascimento,
  truncar,
  parseInteiro,
  normalizarNomeAtividade,
  normalizarArea,
} = require('../normalizacao');

// Aceita a lista pura, { alunos, atividades } ou um único aluno.
function lerCorpo(body) {
  let alunos;
  let atividades = [];
  if (Array.isArray(body)) {
    alunos = body;
  } else if (body && body.alunos) {
    alunos = body.alunos;
    atividades = body.atividades || [];
  } else {
    alunos = [body];
  }
  if (alunos.length === 0) throw new AppError('Nenhum dado enviado.', 400);

  // Linha sem nome não identifica ninguém (antes virava um aluno "undefined").
  const comNome = alunos.filter((linha) => nomeOriginalDaLinha(linha) !== '');
  if (comNome.length === 0) {
    throw new AppError('Nenhuma linha da planilha tem o nome do aluno.', 400);
  }
  return {
    alunos: comNome,
    atividades,
    recebidas: alunos.length,
    semNome: alunos.length - comNome.length,
  };
}

// A planilha já usou os cabeçalhos "nome", "ALUNO" e "Aluno".
const nomeDaLinha = (linha) => String(linha.nome || linha.ALUNO || linha.Aluno).trim();
const nomeOriginalDaLinha = (linha) =>
  String(linha.nome || linha.ALUNO || linha.Aluno || '').trim();

// Valores do INSERT de `alunos`, na ordem das colunas de importacao.model.upsertAlunos.
function valoresDoAluno(linha, hoje, agora, idInstituicao) {
  return [
    truncar(nomeDaLinha(linha), 255),
    parseDataNascimento(linha.data_nascimento),
    parseDataNascimento(linha.data_cadastro) || hoje,
    truncar(linha.sexo, 1),
    truncar(linha.telefone, 20),
    truncar(String(linha.turma || '').trim(), 10) || null,
    truncar(linha.turno, 50),
    truncar(linha.transporte, 100),
    truncar(linha.inf, 60),
    truncar(linha.acompanhamento, 50),
    truncar(linha.ponto, 150),
    truncar(linha.informacoes_gerais, 255),
    truncar(linha.escola_atual, 150),
    'ativo',
    idInstituicao,
    agora,
  ];
}

function lerStatus(linha) {
  if (!linha.status) return null;
  return truncar(String(linha.status).trim().toLowerCase(), 20);
}

// Colunas de matrícula: "SEG HR 1", "Segunda-HR2", "ter_h_3"...
const COLUNA_MATRICULA =
  /^(seg|ter|qua|qui|sex|segunda|terca|quarta|quinta|sexta)[\s\-_]*(hr|horario|h)[\s\-_]*(\d+)$/i;
const DIA_POR_ABREVIACAO = {
  seg: 'Segunda',
  segunda: 'Segunda',
  ter: 'Terça',
  terca: 'Terça',
  qua: 'Quarta',
  quarta: 'Quarta',
  qui: 'Quinta',
  quinta: 'Quinta',
  sex: 'Sexta',
  sexta: 'Sexta',
};

// Turmas preenchidas na linha, na ordem das colunas: [{ dia_semana, horario, nome_atividade }].
function lerMatriculas(linha) {
  const matriculas = [];
  for (const coluna in linha) {
    const match = coluna.match(COLUNA_MATRICULA);
    if (!match || !linha[coluna]) continue;
    matriculas.push({
      dia_semana: DIA_POR_ABREVIACAO[match[1].toLowerCase()],
      horario: `HR ${match[3]}`,
      nome_atividade: normalizarNomeAtividade(linha[coluna]),
    });
  }
  return matriculas;
}

// Aba "Atividades": só declara professor e área de cada nome de turma.
function lerLinhaDeAtividade(atv) {
  const nomeBruto = String(atv.atividade || atv.nome || atv.atividades || '').trim();
  return {
    nome: nomeBruto ? normalizarNomeAtividade(nomeBruto) : '',
    professor: String(atv.professor || atv.professores || atv.prof || '').trim(),
    area: normalizarArea(atv.área ?? atv.area ?? atv.categoria),
  };
}

// O Excel converte "4.1" (nível.subnível) em data: vira um Date ou um serial.
// Dia e mês carregam o nível e o subnível originais, então dá para reconstruir.
function nivelDeData(valor) {
  if (valor instanceof Date) {
    return { nivel: valor.getUTCDate(), subnivel: truncar(String(valor.getUTCMonth() + 1), 10) };
  }
  if (typeof valor === 'number' && Number.isInteger(valor) && valor > 99) {
    const data = new Date(Date.UTC(1899, 11, 30) + valor * 86400000);
    const ano = data.getUTCFullYear();
    if (ano >= 2015 && ano <= 2035) {
      return { nivel: data.getUTCDate(), subnivel: truncar(String(data.getUTCMonth() + 1), 10) };
    }
  }
  return null;
}

// Nível da linha:
//   null                   -> célula vazia ou ilegível (não mexe no nível)
//   { foraDeFaixa: true }  -> número que não é nível (provável erro na planilha)
//   { nivel, subnivel }
function lerNivel(linha) {
  const valor = linha.nivel;
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;

  let resultado = nivelDeData(valor);
  if (!resultado) {
    // "3", "3.2" ou "3,2" (vírgula decimal do Excel em pt-BR)
    const [parteNivel, parteSubnivel] = String(valor).trim().replace(',', '.').split('.');
    const nivel = parseInt(parteNivel, 10);
    if (isNaN(nivel)) return null;
    const subnivel = parteSubnivel ? parseInteiro(parteSubnivel) : parseInteiro(linha.subnivel);
    resultado = { nivel, subnivel: subnivel === null ? null : truncar(String(subnivel), 10) };
  }

  if (resultado.nivel < 1 || resultado.nivel > 99) return { foraDeFaixa: true };
  return resultado;
}

function lerSituacaoAnual(linha) {
  const situacaoMatricula = truncar(linha.situacao_matricula_ano, 50);
  const situacaoDivida = truncar(linha.situacao_divida_ano, 50);
  if (!situacaoMatricula && !situacaoDivida) return null;
  return { situacaoMatricula, situacaoDivida };
}

// Várias observações na mesma célula, separadas por ";".
function lerObservacoesSaude(linha) {
  if (!linha.observacoes_saude) return [];
  return String(linha.observacoes_saude)
    .split(';')
    .map((s) => truncar(s.trim(), 255))
    .filter(Boolean);
}

function lerResponsavel(linha) {
  const campos = {
    nome: truncar(linha.responsavel_nome, 255),
    cpf: truncar(linha.responsavel_cpf, 20),
    rg: truncar(linha.responsavel_rg, 20),
    data_nascimento: parseDataNascimento(linha.responsavel_data_nascimento),
    email: truncar(linha.responsavel_email, 255),
    endereco: truncar(linha.responsavel_endereco, 255),
    bairro: truncar(linha.responsavel_bairro, 100),
    cep: truncar(linha.responsavel_cep, 10),
    telefone: truncar(linha.responsavel_telefone, 20),
  };
  return Object.values(campos).some((v) => v !== null) ? campos : null;
}

module.exports = {
  lerCorpo,
  nomeDaLinha,
  nomeOriginalDaLinha,
  valoresDoAluno,
  lerStatus,
  lerMatriculas,
  lerLinhaDeAtividade,
  lerNivel,
  lerSituacaoAnual,
  lerObservacoesSaude,
  lerResponsavel,
};
