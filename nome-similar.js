// Detecção de nome parecido/digitado errado — extraído de alunos.js (onde
// nasceu, pro import em massa) pra ser reaproveitado também na criação manual
// de professor (professores.js). Mesma lógica, mesmo comportamento.

// Só acento/maiúscula/espaço — sem isso "Joao Silva" e "João Silva" contam
// como pessoas diferentes pro UNIQUE do banco, e cria um cadastro duplicado.
const normalizarTextoComparacao = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().trim().replace(/\s+/g, ' ');

// Distância de Levenshtein (quantas inserções/remoções/trocas de letra
// separam duas strings) — sem biblioteca externa, o volume de nomes por
// import não justifica uma dependência só pra isso.
function distanciaLevenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const linhaAnterior = Array.from({ length: n + 1 }, (_, j) => j);
  let linhaAtual = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    linhaAtual[0] = i;
    for (let j = 1; j <= n; j++) {
      linhaAtual[j] = a[i - 1] === b[j - 1]
        ? linhaAnterior[j - 1]
        : 1 + Math.min(linhaAnterior[j], linhaAtual[j - 1], linhaAnterior[j - 1]);
    }
    for (let j = 0; j <= n; j++) linhaAnterior[j] = linhaAtual[j];
  }
  return linhaAnterior[n];
}

// Compara `nomeEnviado` contra a lista de nomes que já existem no banco
// (aluno, turma ou professor — mesma função pros três). Devolve:
//   { tipo: 'exato' }                       — já bate igual, nada a fazer.
//   { tipo: 'corrigido', nome }              — só difere por acento/maiúscula/
//                                              espaço: mesma pessoa/turma, troca
//                                              pelo nome já cadastrado.
//   { tipo: 'suspeita', nome, distancia }    — mesma quantidade de palavras,
//                                              tamanho bem próximo (≤2
//                                              caracteres de diferença) e só
//                                              1-2 letras diferentes: PODE ser
//                                              erro de digitação, mas não
//                                              corrige sozinho (pode ser gente/
//                                              turma diferente de verdade) —
//                                              só avisa no resumo.
//   { tipo: 'nenhum' }                       — sem relação nenhuma; segue como
//                                              nome novo, sem aviso.
// Um nome tipo "Romário José dos Santos" NUNCA é comparado com "Romário José
// dos" (faltando uma palavra inteira) — quantidade de palavras diferente já
// descarta a comparação antes de calcular distância, porque isso não é erro
// de digitação, é um nome (ou cadastro) genuinamente diferente.
const LIMITE_DIFERENCA_TAMANHO = 2;
const LIMITE_DISTANCIA_SUSPEITA = 2;
function resolverNomeParecido(nomeEnviado, nomesExistentes) {
  const enviadoLimpo = String(nomeEnviado || '').trim();
  if (!enviadoLimpo) return { tipo: 'nenhum' };
  if (nomesExistentes.includes(enviadoLimpo)) return { tipo: 'exato' };

  const normEnviado = normalizarTextoComparacao(enviadoLimpo);
  const palavrasEnviado = normEnviado.split(' ').filter(Boolean);

  let corrigido = null;
  let melhorSuspeita = null;
  for (const existente of nomesExistentes) {
    const normExistente = normalizarTextoComparacao(existente);
    if (normExistente === normEnviado) { corrigido = existente; break; }

    const palavrasExistente = normExistente.split(' ').filter(Boolean);
    if (palavrasExistente.length !== palavrasEnviado.length) continue;
    if (Math.abs(normExistente.length - normEnviado.length) > LIMITE_DIFERENCA_TAMANHO) continue;

    const distancia = distanciaLevenshtein(normEnviado, normExistente);
    if (distancia > 0 && distancia <= LIMITE_DISTANCIA_SUSPEITA) {
      if (!melhorSuspeita || distancia < melhorSuspeita.distancia) {
        melhorSuspeita = { nome: existente, distancia };
      }
    }
  }

  if (corrigido) return { tipo: 'corrigido', nome: corrigido };
  if (melhorSuspeita) return { tipo: 'suspeita', nome: melhorSuspeita.nome, distancia: melhorSuspeita.distancia };
  return { tipo: 'nenhum' };
}

module.exports = { normalizarTextoComparacao, distanciaLevenshtein, resolverNomeParecido };
