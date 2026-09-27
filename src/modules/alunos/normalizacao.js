// Funções puras de limpeza/conversão de dados de aluno (formulário e planilha).
const { AREAS_VALIDAS } = require('../../constants/areas');

const TURNOS_CONHECIDOS = [
  'Manhã',
  'Tarde',
  'Noite',
  'Integral',
  'manhã',
  'tarde',
  'noite',
  'integral',
];

// " manhã " -> "manhã"; valor fora do padrão ganha só a primeira letra maiúscula.
function validarTurno(turno) {
  if (!turno) return null;
  const texto = String(turno).trim();
  if (!texto) return null;
  if (!TURNOS_CONHECIDOS.includes(texto)) {
    return texto.charAt(0).toUpperCase() + texto.slice(1).toLowerCase();
  }
  return texto;
}

// Converte a data vinda da planilha/formulário para AAAA-MM-DD.
// Aceita Date, "dd/mm/aaaa" (tratado antes do new Date, que leria como mm/dd),
// texto ISO e número serial do Excel. Qualquer coisa inválida vira null.
function parseDataNascimento(data) {
  if (data === null || data === undefined || data === '') return null;

  if (data instanceof Date) {
    return isNaN(data.getTime()) ? null : data.toISOString().split('T')[0];
  }

  if (typeof data === 'string' && data.trim()) {
    const texto = data.trim();

    const matchBr = texto.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (matchBr) {
      const [dia, mes, ano] = matchBr.slice(1).map(Number);
      if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
      // Rejeita datas que não existem (29/02 em ano comum, 31/04): o MySQL
      // recusaria no INSERT e derrubaria o lote inteiro.
      const checagem = new Date(ano, mes - 1, dia);
      const existe =
        checagem.getFullYear() === ano &&
        checagem.getMonth() === mes - 1 &&
        checagem.getDate() === dia;
      if (!existe) return null;
      return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }

    const convertida = new Date(texto);
    if (!isNaN(convertida.getTime())) return convertida.toISOString().split('T')[0];
  }

  // Serial do Excel (dias desde 1899-12-30). Antes de 1920 é quase certamente
  // lixo na célula (ex.: "2"), não uma data de nascimento.
  if (typeof data === 'number' && Number.isFinite(data) && data > 0 && data < 100000) {
    const convertida = new Date(Date.UTC(1899, 11, 30) + data * 86400000);
    if (!isNaN(convertida.getTime()) && convertida.getUTCFullYear() >= 1920) {
      return convertida.toISOString().split('T')[0];
    }
  }

  return null;
}

// Corta o texto no tamanho da coluna: uma célula grande demais não pode
// derrubar o INSERT do lote inteiro.
function truncar(valor, tamanhoMax) {
  if (valor === null || valor === undefined || valor === '') return null;
  return String(valor).slice(0, tamanhoMax);
}

// "3,5" / "3.5" -> 3 (parseInt para no primeiro caractere não numérico).
function parseInteiro(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const n = parseInt(String(valor).trim(), 10);
  return isNaN(n) ? null : n;
}

// Letras finais que fazem parte do nome real da turma (e não são sufixo).
const EXCECOES_NOME_ATIVIDADE = {
  'teclado 1 r': 'Teclado 1 (R)',
};

// "CUL - Cello 1 A" -> "Cello 1": tira o prefixo "CUL - " e a letra solta do
// final, para bater com os nomes já limpos no banco. Sem o prefixo, não mexe.
function normalizarNomeAtividade(nome) {
  const texto = String(nome).trim();
  if (!/^cul\s*-\s*/i.test(texto)) return texto;
  const semPrefixo = texto.replace(/^cul\s*-\s*/i, '').trim();
  const excecao = EXCECOES_NOME_ATIVIDADE[semPrefixo.toLowerCase()];
  if (excecao) return excecao;
  return semPrefixo.replace(/\s+(-\s+)?[A-Z]$/, '').trim();
}

// "Tecnológico" -> "tecnologico"; área desconhecida vira null.
function normalizarArea(texto) {
  const semAcento = String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
  return AREAS_VALIDAS.includes(semAcento) ? semAcento : null;
}

// A planilha indica a área pelo prefixo do nome da turma ("ESP - ...").
// Sem prefixo conhecido, assume Cultural, mas marca como palpite.
const PREFIXOS_AREA = [
  { regex: /^cap\b/i, area: 'capelania' },
  { regex: /^e\.?p\b/i, area: 'educacional' },
  { regex: /^esp\b/i, area: 'esportivo' },
  { regex: /^tec\b/i, area: 'tecnologico' },
  { regex: /^cul\b/i, area: 'cultural' },
];

function detectarAreaPorNome(nome) {
  const texto = String(nome || '').trim();
  const encontrado = PREFIXOS_AREA.find((p) => p.regex.test(texto));
  return { area: encontrado ? encontrado.area : 'cultural', confiavel: !!encontrado };
}

// Turno da tela ("Manhã", "tarde"...) -> período gravado na presença.
function periodoDoTurno(turno) {
  if (!turno) return null;
  const texto = String(turno).toLowerCase();
  if (texto.includes('manh')) return 'manha';
  if (texto.includes('tard')) return 'tarde';
  if (texto.includes('noit')) return 'noite';
  return null;
}

const DIAS_DA_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// "2026-09-24" -> "Quinta"
function diaDaSemana(data) {
  return DIAS_DA_SEMANA[new Date(`${data}T00:00:00`).getDay()];
}

module.exports = {
  validarTurno,
  parseDataNascimento,
  truncar,
  parseInteiro,
  normalizarNomeAtividade,
  normalizarArea,
  detectarAreaPorNome,
  periodoDoTurno,
  diaDaSemana,
};
