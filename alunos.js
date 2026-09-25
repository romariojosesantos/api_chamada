// CRUD de alunos + as duas rotas mais usadas do sistema no dia a dia:
// /por-dia (monta a lista de chamada de um dia específico) e /upsert-bulk
// (importação em massa a partir da planilha Excel da grade).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { validate } = require('./validation');
const { logAuditEvent } = require('./audit');
const { syncAlunoStatusFromMatriculas, encerrarMatriculasForaDoTurno, encerrarMatriculasSeNaoAtivo } = require('./status-sync');
const { criarNotificacao } = require('./notificacoes-service');
const { hojeBrasil, agoraBrasil } = require('./data-brasil');
const { podeMatricular } = require('./regras-matricula');
const { AREAS_VALIDAS } = require('./areas');
const { resolverNomeParecido } = require('./nome-similar');
const { exigirRecurso } = require('./permissoes-middleware');
const { calcularFrequenciaPorAluno } = require('./relatorios');
const { enviarFoto, removerFoto, configurado: storageConfigurado } = require('./storage');



// Helper para envolver rotas assíncronas e capturar erros
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const exigir = (recurso) => exigirRecurso('/gerenciar-matriculas', recurso);

// Helper para subquery de dias matriculados (evita duplicação de código).
// Retorna, por aluno, a lista de dias da semana em que ele tem matrícula ativa
// (ex.: "Segunda,Quarta"), usada nas telas que mostram o aluno junto com sua grade.
const getDiasMatriculadosSubquery = () => `
  IFNULL((SELECT GROUP_CONCAT(DISTINCT TRIM(m2.dia_semana) SEPARATOR ',')
   FROM matricula m2
   WHERE m2.idaluno = a.id AND m2.status = 'matriculado' AND m2.data_fim IS NULL AND m2.id_instituicao = a.id_instituicao), '') as dias_matriculados
`;

// Helper para subqueries de nível/subnível atual (o registro em `aluno_niveis`
// com data_fim NULL — ver rota /:id/niveis). Duas subqueries separadas (em vez
// de um JOIN) pra não duplicar linhas de `a` caso um dia existisse mais de um
// registro em aberto por engano.
const getNivelAtualSubquery = () => `
  (SELECT an.nivel FROM aluno_niveis an
   WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL
   ORDER BY an.data_inicio DESC LIMIT 1) as nivel,
  (SELECT an.subnivel FROM aluno_niveis an
   WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL
   ORDER BY an.data_inicio DESC LIMIT 1) as subnivel
`;

// Helper para subquery de saúde (todas as observações do aluno, concatenadas
// — ver `aluno_saude`, tabela 1-para-muitos preenchida em CadastrarAluno.js/
// import em massa). Usada só pra exibição em lista (ex.: coluna "Saúde" no
// Ajuste de Grade); editar de verdade continua sendo feito no cadastro do
// aluno, uma entrada por vez.
const getSaudeSubquery = () => `
  IFNULL((SELECT GROUP_CONCAT(descricao SEPARATOR '; ')
   FROM aluno_saude
   WHERE id_aluno = a.id AND id_instituicao = a.id_instituicao), '') as saude
`;

// Helper para validar e normalizar turno (ex.: " manhã " -> "Manhã")
const validarTurno = (turno) => {
  if (!turno) return null;
  const turnoNormalizado = String(turno).trim();
  const turnosValidos = ['Manhã', 'Tarde', 'Noite', 'Integral', 'manhã', 'tarde', 'noite', 'integral'];
  if (!turnoNormalizado) return null;
  // Capitaliza primeira letra se não estiver nos padrões conhecidos
  if (!turnosValidos.includes(turnoNormalizado)) {
    return turnoNormalizado.charAt(0).toUpperCase() + turnoNormalizado.slice(1).toLowerCase();
  }
  return turnoNormalizado;
};

// Helper para parse de data de nascimento (simplificado)
// Converte a data de nascimento vinda da planilha (ou do formulário) pro
// formato YYYY-MM-DD que o banco espera. Aceita três formatos:
//   1. Date de verdade (célula Excel formatada como data, lida com
//      cellDates:true no front — mas se passar por JSON.stringify vira string
//      ISO antes de chegar aqui, então esse branch quase nunca é usado no
//      backend; mantido por segurança).
//   2. Texto no formato brasileiro dd/mm/aaaa ou dd-mm-aaaa — o mais comum em
//      planilha, quando a célula não é um tipo "data" de verdade no Excel, só
//      texto. `new Date(string)` sozinho INTERPRETA ISSO COMO mm/dd (formato
//      americano) e falha silenciosamente pra a maioria das datas — por isso
//      esse formato precisa ser tratado à parte, ANTES de cair no new Date genérico.
//   3. Texto ISO (aaaa-mm-dd, o formato que JSON.stringify produz a partir de
//      um Date) — cai no new Date genérico, que entende esse formato certo.
const parseDataNascimento = (data) => {
  if (data === null || data === undefined || data === '') return null;

  if (data instanceof Date) {
    return isNaN(data.getTime()) ? null : data.toISOString().split('T')[0];
  }

  if (typeof data === 'string' && data.trim()) {
    const texto = data.trim();

    const matchBr = texto.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (matchBr) {
      const [, dia, mes, ano] = matchBr;
      const diaNum = Number(dia), mesNum = Number(mes), anoNum = Number(ano);
      if (mesNum < 1 || mesNum > 12 || diaNum < 1 || diaNum > 31) return null;
      // Confere se a data EXISTE de verdade (ex.: 29/02 em ano não bissexto,
      // 31/04) — sem isso um valor tipo "29/02/2022" gerava uma string de
      // data inválida que o MySQL só rejeitava na hora do INSERT, derrubando
      // o lote inteiro de centenas de alunos por causa de 1 linha ruim.
      const dataChecagem = new Date(anoNum, mesNum - 1, diaNum);
      const ehDataReal = dataChecagem.getFullYear() === anoNum && dataChecagem.getMonth() === mesNum - 1 && dataChecagem.getDate() === diaNum;
      if (!ehDataReal) return null;
      return `${anoNum}-${String(mesNum).padStart(2, '0')}-${String(diaNum).padStart(2, '0')}`;
    }

    const parsedDate = new Date(texto);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.toISOString().split('T')[0];
    }
  }

  // Número serial de data do Excel (dias desde 1899-12-30) — acontece quando a
  // célula é lida sem cellDates:true em algum ponto do fluxo, ou vem de um CSV
  // que o Excel converteu. Só trata números plausíveis (evita interpretar um
  // valor qualquer como data por engano).
  if (typeof data === 'number' && Number.isFinite(data) && data > 0 && data < 100000) {
    const dataBase = new Date(Date.UTC(1899, 11, 30));
    const convertida = new Date(dataBase.getTime() + data * 86400000);
    // Segunda camada de proteção: um valor pequeno na célula (ex.: "2" por
    // engano, ou um erro de fórmula) vira uma data pertinho da época 0 do
    // Excel (1899/1900) em vez de null — e isso já causou nascimento de
    // aluno virando "1900-01-01" silenciosamente. Nenhuma pessoa viva hoje
    // nasceu antes de ~1920 (nem aluno, nem responsável), então trata como
    // implausível em vez de aceitar.
    if (!isNaN(convertida.getTime()) && convertida.getUTCFullYear() >= 1920) {
      return convertida.toISOString().split('T')[0];
    }
  }

  return null;
};

// Trunca um valor de texto pro tamanho máximo da coluna antes de mandar pro
// banco. Dado real de planilha às vezes vem maior do que o campo permite (ex.:
// dois telefones colados na mesma célula) — sem isso, uma única célula grande
// demais derruba o INSERT em lote inteiro (centenas de alunos de uma vez) com
// "Data too long for column" em vez de só cortar o excesso daquela célula.
const truncar = (valor, tamanhoMax) => {
  if (valor === null || valor === undefined || valor === '') return null;
  return String(valor).slice(0, tamanhoMax);
};

// Nível e subnível só aceitam número inteiro — nada de vírgula ou ponto (isso
// é exatamente o tipo de célula que o Excel autocorrige pra data sozinho, ver
// o bloco de reconstrução de data no Passo 5b abaixo). `parseInt` já ignora
// tudo a partir do primeiro caractere que não é dígito, então "3,5" ou "3.5"
// somem e sobra só o "3" — sem misturar vírgula/ponto no valor final.
const parseInteiro = (valor) => {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const n = parseInt(String(valor).trim(), 10);
  return isNaN(n) ? null : n;
};

// --- Detecção de nome parecido (aluno, turma/atividade, professor) na
// importação em massa — evita criar um cadastro duplicado só porque a
// planilha escreveu o nome com um acento/maiúscula diferente, ou avisar
// quando pode ser um erro de digitação (sem corrigir sozinho, porque duas
// pessoas/turmas diferentes podem ter nomes parecidos de verdade).

// Casos em que a letra final do nome NÃO é só sufixo de turma (que o corte
// abaixo remove) e sim parte do nome real de uma turma distinta — ex.: "CUL -
// Teclado 1 R" é uma turma diferente de "CUL - Teclado 1" (professor e
// horário iguais, alunos diferentes). Mapeia pro nome exato já usado em
// `atividades` pra essa turma, pulando o corte genérico.
const EXCECOES_NOME_ATIVIDADE = {
  'teclado 1 r': 'Teclado 1 (R)',
};

// Remove o prefixo "CUL - " e a letra solta no final (ex.: "CUL - Cello 1 A"
// -> "Cello 1") de nomes de atividade vindos da planilha, para que continuem
// batendo com os nomes já renomeados no banco (ver migração que limpou esse
// prefixo em `atividades`). Só mexe em nomes que realmente têm o prefixo —
// não corta letra final de nomes que nunca tiveram "CUL -".
const normalizarNomeAtividade = (nome) => {
  const texto = String(nome).trim();
  if (!/^cul\s*-\s*/i.test(texto)) return texto;
  const semPrefixo = texto.replace(/^cul\s*-\s*/i, '').trim();
  const excecao = EXCECOES_NOME_ATIVIDADE[semPrefixo.toLowerCase()];
  if (excecao) return excecao;
  return semPrefixo.replace(/\s+(-\s+)?[A-Z]$/, '').trim();
};

// Normaliza a área declarada na aba "Atividades" da planilha (ex.: "Cultural",
// "cultural", "Tecnológico" sem acento) pro valor exato esperado em
// AREAS_VALIDAS — mesmo cuidado de accent-stripping já usado no import de
// alunos pra distinguir "Responsável" de "responsavel". Retorna null se vazio
// ou se não bater com nenhuma área conhecida (turma fica sem área — ver
// resumo.turmas_sem_area no upsert-bulk, que avisa em vez de adivinhar).
const normalizarArea = (texto) => {
  const semAcento = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return AREAS_VALIDAS.includes(semAcento) ? semAcento : null;
};

// A planilha não tem coluna "Área" — a área de cada turma é indicada pelo
// PREFIXO do próprio nome (convenção já usada nos dados reais, confirmada
// pelos nomes existentes: "CAP - ...", "E.P" / "E.P. - ...", "ESP - ...",
// "TEC - ..."; sem nenhum desses prefixos, é Cultural — mesma regra do
// backfill original que classificou as turmas das instituições reais, ver
// comentário antigo em atividades.js). `\b` depois do prefixo evita que um
// nome comece parecido por coincidência (ex.: não bate em "Espanhol").
const PREFIXOS_AREA = [
  { regex: /^cap\b/i, area: 'capelania' },
  { regex: /^e\.?p\b/i, area: 'educacional' },
  { regex: /^esp\b/i, area: 'esportivo' },
  { regex: /^tec\b/i, area: 'tecnologico' },
  { regex: /^cul\b/i, area: 'cultural' },
];
// Se nenhum prefixo bater, cai em 'cultural' (mesma convenção de sempre) —
// mas isso conta como palpite, não como classificação confiável (ver
// resumo.turmas_sem_area no upsert-bulk).
const detectarAreaPorNome = (nome) => {
  const texto = String(nome || '').trim();
  const encontrado = PREFIXOS_AREA.find(p => p.regex.test(texto));
  return { area: encontrado ? encontrado.area : 'cultural', confiavel: !!encontrado };
};

// Listar Alunos com filtros dinâmicos.
// Regra especial: se `nome` for informado, os demais filtros (status/turno/transporte)
// são ignorados — a busca por nome funciona como uma busca "global" independente
// do status atual do aluno (útil para achar alunos inativos, por exemplo).
router.get('/', asyncHandler(async (req, res) => {
  const { nome, turno, transporte, status } = req.query;

  let sql = `
    SELECT a.id, a.nome, a.data_nascimento, a.data_cadastro, a.criado_em, a.sexo, a.telefone,
           a.turma, a.turno, a.transporte, a.status, a.inativado_em, a.Inf,
           a.acompanhamento, a.ponto, a.informacoes_gerais, a.escola_atual, a.foto_url,
           ${getDiasMatriculadosSubquery()},
           ${getNivelAtualSubquery()},
           ${getSaudeSubquery()}
    FROM alunos a
    WHERE a.id_instituicao = ? AND a.excluido_em IS NULL
  `;
  const params = [req.id_instituicao];

  if (nome && nome.trim() !== '') {
    sql += " AND a.nome LIKE ?";
    params.push(`%${nome.trim()}%`);
  } else {
    if (status === 'todos') { /* sem filtro de status */ }
    else if (status) { sql += " AND a.status = ?"; params.push(status); }
    else { sql += " AND a.status = 'ativo'"; }

    if (turno && turno !== 'Todos') { sql += " AND TRIM(a.turno) = ?"; params.push(turno); }
    if (transporte && transporte !== 'Todos') { sql += " AND TRIM(a.transporte) = ?"; params.push(transporte); }
  }

  sql += " ORDER BY a.nome ASC";
  const [results] = await pool.query(sql, params);
  res.json(results);
}));

// Telefones (aluno + responsável) só para os IDs pedidos — usado pela
// exportação "nome/número" de Ajuste Grade (ver AjusteGrade.js): a listagem
// principal acima já é chamada o tempo todo por várias telas, então o join
// com responsavel_legal fica só aqui, sob demanda, e só para os alunos
// realmente visíveis no momento da exportação (respeitando o filtro aplicado).
router.get('/telefones', asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return res.json([]);

  const [rows] = await pool.query(
    `SELECT a.id, a.telefone AS telefone_aluno, rl.telefone AS telefone_responsavel
     FROM alunos a
     LEFT JOIN responsavel_legal rl ON rl.id_aluno = a.id
     WHERE a.id IN (?) AND a.id_instituicao = ?`,
    [ids, req.id_instituicao]
  );
  res.json(rows);
}));

// Rota para buscar alunos que possuem aula em um dia específico — base da tela de Chamada.
//
// Se a data cair num dia marcado como "sem aula" (feriado/recesso — ver
// dias-sem-aula.js), devolve uma lista vazia com `isDiaSemAula: true` em vez de
// tentar montar a chamada — não faz sentido pedir presença num dia sem aula.
//
// Dois modos, controlados por `ignoreFilters`:
//  - "Chamada" (padrão): só os alunos matriculados no dia da semana correspondente à `data`.
//  - "Relatório" (ignoreFilters=true): todos os alunos ativos matriculados, sem
//    filtrar por dia — usado quando a tela precisa mostrar o status de presença
//    de todo mundo, mesmo de quem não tinha aula prevista naquele dia.
// Em ambos os modos, `professor` (opcional) restringe aos alunos matriculados em
// atividades daquele professor.
router.get('/por-dia', asyncHandler(async (req, res) => {
  const { data, ignoreFilters, professor, turno } = req.query; // Espera formato YYYY-MM-DD
  if (!data) return res.status(400).json({ error: 'Data é obrigatória.' });

  const dateObj = new Date(`${data}T00:00:00`);
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[dateObj.getDay()];

  // Verificar se é dia sem aula
  const [diaSemAula] = await pool.query(
    `SELECT id, motivo FROM dias_sem_aula WHERE data = ? AND id_instituicao = ?`,
    [data, req.id_instituicao]
  );

  if (diaSemAula.length > 0) {
    return res.json({
      isDiaSemAula: true,
      motivo: diaSemAula[0].motivo || 'Dia sem aula',
      alunos: []
    });
  }

  let sql, params;

  // Período correspondente ao `turno` pedido (ver migrate-add-periodo-
  // presenca.js) — usado nos DOIS modos abaixo (Relatório e Chamada) pra
  // juntar só a presença DAQUELE período, nunca a de outro turno. Sem isso,
  // um aluno com matrícula em mais de um turno no mesmo dia (turma comum +
  // ensaio à noite, algo que o sistema permite de propósito) pode ter duas
  // linhas de presença nesse dia — uma por período — e um LEFT JOIN direto
  // traria as duas ao mesmo tempo: `SELECT DISTINCT` não deduplica porque
  // `presenca_status` diverge entre elas, e quem "ganha" no front vira sorte
  // de ordenação das linhas. Era exatamente o bug relatado na tela de Grade
  // (professor): presença de manhã/tarde aparecendo refletida na turma da
  // noite, porque a rota usada por ela (Modo Relatório) juntava a presença
  // sem filtrar por período — a de Chamada já fazia esse filtro corretamente.
  const periodo = turno
    ? (String(turno).toLowerCase().includes('manh') ? 'manha'
      : String(turno).toLowerCase().includes('tard') ? 'tarde'
      : String(turno).toLowerCase().includes('noit') ? 'noite'
      : null)
    : null;
  // Um registro sem período (legado, de antes dessa coluna existir) só conta
  // como fallback pro turno do DIA (manhã/tarde) — nunca pra noite, já que a
  // chamada da noite nem existia como opção separada antes disso (qualquer
  // registro antigo só pode ter vindo de manhã/tarde).
  const condicaoPeriodo = !turno ? '' : (periodo === 'noite' ? 'AND periodo = ?' : 'AND (periodo IS NULL OR periodo = ?)');
  // Junta com uma SUBQUERY (não direto na tabela) que resolve pra NO MÁXIMO
  // uma linha de presença por aluno — nunca mais de uma, mesmo se o aluno
  // tiver tanto um registro ANTIGO sem período quanto um registro NOVO já
  // com o período certo: o `ORDER BY (periodo IS NOT NULL) DESC` prioriza o
  // registro com período definido (o mais preciso), só caindo pro
  // sem-período se não existir nenhum com período batendo.
  // Separador '\x1F' (caractere de controle "unit separator", nunca digitado
  // por um humano) em vez de string vazia: SUBSTRING_INDEX(str, '', n) é
  // degenerado no MySQL e sempre devolve '' — com separador vazio, isso
  // travava esse "pegar só o primeiro valor" silenciosamente (bug latente,
  // nunca notado porque até agora só a Chamada usava esse subquery, e ela
  // nunca leu esse campo — pegava presença por outro caminho).
  const subqueryPresenca = `
    (SELECT aluno_id,
       SUBSTRING_INDEX(GROUP_CONCAT(status ORDER BY (periodo IS NOT NULL) DESC SEPARATOR '\x1F'), '\x1F', 1) AS status,
       SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(observacao, '') ORDER BY (periodo IS NOT NULL) DESC SEPARATOR '\x1F'), '\x1F', 1) AS observacao
     FROM presenca
     WHERE DATE(data) = ? AND id_instituicao = ? ${condicaoPeriodo}
     GROUP BY aluno_id)
  `;
  const paramsPresenca = [data, req.id_instituicao, ...(turno ? [periodo] : [])];

  // `m.data_fim IS NULL` em todo lugar abaixo: uma matrícula com data_fim
  // preenchida está encerrada (soft-delete), independente de qual data seja —
  // não é um intervalo de vigência, é um "isso não vale mais" (mesmo padrão
  // usado em matriculas.js, presenca.js e relatorios.js).
  if (ignoreFilters === 'true') {
    // Modo Relatório: retorna TODOS os alunos ativos com status de presença
    // para a data. Quando `turno` vem preenchido (ver Grade.js, que manda o
    // turno da turma aberta), junta a presença já filtrada por período, igual
    // ao Modo Chamada abaixo. Sem `turno` (ex.: DailyReport.jsx, que quer o
    // status de todo mundo independente de qual turno cada um é), continua
    // com o LEFT JOIN direto de sempre, sem filtro de período — comportamento
    // inalterado pra quem não manda turno.
    const juncaoPresenca = turno
      ? `LEFT JOIN ${subqueryPresenca} p ON p.aluno_id = a.id`
      : `LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao`;
    const paramsJuncao = turno ? paramsPresenca : [data];

    if (professor) {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto, a.foto_url,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        JOIN atividades atv ON m.idatividades = atv.idatividades
        JOIN professores prof ON atv.idprofessor = prof.id
        ${juncaoPresenca}
        WHERE a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        AND TRIM(prof.nome) = ?
        AND a.id_instituicao = ?
        ORDER BY a.nome ASC
      `;
      params = [...paramsJuncao, professor, req.id_instituicao];
    } else {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto, a.foto_url,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        ${juncaoPresenca}
        WHERE a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        AND a.id_instituicao = ?
        ORDER BY a.nome ASC
      `;
      params = [...paramsJuncao, req.id_instituicao];
    }
  } else {
    // Modo Chamada: filtra apenas os alunos matriculados no dia da semana
    // informado. `m.turno` (não `a.turno`) quando `turno` vem preenchido —
    // um aluno pode ter o turno cadastrado como "Manhã" mas também ter uma
    // matrícula de ensaio à noite; filtrar pelo turno DA MATRÍCULA (em vez do
    // atributo fixo do aluno) é o que faz esse aluno aparecer certinho tanto
    // na chamada da manhã quanto na da noite, cada uma com sua própria lista.
    const filtroTurno = turno ? 'AND LOWER(m.turno) = LOWER(?)' : '';
    if (professor) {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto, a.foto_url,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        JOIN atividades atv ON m.idatividades = atv.idatividades
        JOIN professores prof ON atv.idprofessor = prof.id
        LEFT JOIN ${subqueryPresenca} p ON p.aluno_id = a.id
        WHERE TRIM(m.dia_semana) = ?
        AND a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        -- data_inicio <= data da chamada: sem isso, matricular um aluno HOJE
        -- numa turma fazia ele aparecer na chamada de dias PASSADOS também,
        -- antes de ele sequer existir naquela turma.
        AND m.data_inicio <= ?
        AND TRIM(prof.nome) = ?
        AND a.id_instituicao = ?
        ${filtroTurno}
        ORDER BY a.nome ASC
      `;
      params = [...paramsPresenca, diaDaSemana, data, professor, req.id_instituicao, ...(turno ? [turno] : [])];
    } else {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto, a.foto_url,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        LEFT JOIN ${subqueryPresenca} p ON p.aluno_id = a.id
        WHERE TRIM(m.dia_semana) = ?
        AND a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        AND m.data_inicio <= ?
        AND a.id_instituicao = ?
        ${filtroTurno}
        ORDER BY a.nome ASC
      `;
      params = [...paramsPresenca, diaDaSemana, data, req.id_instituicao, ...(turno ? [turno] : [])];
    }
  }

  try {
    const [results] = await pool.query(sql, params);
    res.json(results);
  } catch (error) {
    console.error('Erro na rota /por-dia:', error.message);
    res.status(500).json({ error: 'Erro interno ao buscar alunos por dia' });
  }
}));


// Ranking de Meritocracia: pontos de cada aluno num período = 1 ponto por dia
// presente, descontado o percentual de ocorrências de comportamento
// registradas no mesmo período (ver backend/ocorrencias.js — leve -25%,
// grave -50%, gravíssima -100%, somando até no máximo 100% de desconto).
// Substituiu a antiga /frequencia-plena, que só somava presenças brutas sem
// saber quantos dias eram esperados (por isso não dava pra calcular % nem
// pontuação de verdade) — dias_esperados/dias_presentes agora vêm da mesma
// função já usada e testada em notas.js/estatisticas-comparativas.js, não
// duplicada aqui.
router.get('/meritocracia', asyncHandler(async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ error: 'Datas início/fim obrigatórias.' });

  const [alunosBase, frequencias, ocorrencias] = await Promise.all([
    pool.query(
      `SELECT a.id, a.nome, a.turno, ${getNivelAtualSubquery()}
       FROM alunos a WHERE a.id_instituicao = ? AND a.status = 'ativo' AND a.excluido_em IS NULL`,
      [req.id_instituicao]
    ).then(([rows]) => rows),
    calcularFrequenciaPorAluno(req.id_instituicao, inicio, fim),
    pool.query(
      `SELECT id_aluno, gravidade, percentual_aplicado, descricao, data_ocorrencia
       FROM aluno_ocorrencias
       WHERE id_instituicao = ? AND excluido_em IS NULL AND data_ocorrencia BETWEEN ? AND ?`,
      [req.id_instituicao, inicio, fim]
    ).then(([rows]) => rows)
  ]);

  const alunoPorId = new Map(alunosBase.map(a => [a.id, a]));
  const ocorrenciasPorAluno = new Map();
  for (const o of ocorrencias) {
    if (!ocorrenciasPorAluno.has(o.id_aluno)) ocorrenciasPorAluno.set(o.id_aluno, []);
    ocorrenciasPorAluno.get(o.id_aluno).push(o);
  }

  const resultado = frequencias
    .filter(f => alunoPorId.has(f.aluno_id))
    .map(f => {
      const aluno = alunoPorId.get(f.aluno_id);
      const ocorrenciasDoAluno = ocorrenciasPorAluno.get(f.aluno_id) || [];
      const descontoPct = Math.min(100, ocorrenciasDoAluno.reduce((soma, o) => soma + o.percentual_aplicado, 0));
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
        ocorrencias: ocorrenciasDoAluno
      };
    })
    .sort((a, b) => b.pontos_finais - a.pontos_finais || a.nome.localeCompare(b.nome, 'pt-BR'));

  res.json(resultado);
}));

// Importação em massa a partir do Excel da grade (aba de alunos + aba opcional de
// atividades). Todo o processamento roda numa única transação: se qualquer etapa
// falhar, nada é gravado. Passos:
//   0. Corrige nome de aluno/turma/professor que só difere por acento, maiúscula
//      ou espaço de um já cadastrado (mesma pessoa/turma, grafia diferente —
//      ver resolverNomeParecido), e reporta no resumo (`nomes_corrigidos`)
//      qualquer nome parecido mas não idêntico o bastante pra corrigir sozinho
//      (`possiveis_duplicados` — fica como a planilha escreveu, só avisa).
//   1. Upsert dos alunos (por nome, já corrigido acima) — cria quem não existe,
//      atualiza quem já existe.
//   2. Recarrega os alunos pelo nome para obter os IDs reais (insertId não serve
//      para lote com upsert, por isso o SELECT extra).
//   3. Varre cada aluno procurando colunas de matrícula no formato "SEG HR 1" etc.
//      e monta a lista de matrículas a criar, coletando os nomes de atividade únicos.
//   4. Garante que professores e atividades citados existam (cria os que faltam;
//      atualiza o professor de atividades já existentes se a planilha trouxer outro).
//   5. Compara com as matrículas atuais de cada aluno: se o horário já tinha uma
//      matrícula pra mesma atividade, não faz nada; se a atividade mudou nesse
//      horário, encerra (soft-delete) a antiga e cria uma nova — preserva o
//      histórico em vez de sobrescrever.
//
// Quem NÃO veio nesta planilha simplesmente não é tocado (nem status, nem
// matrícula) — a planilha só atualiza/cria quem ela menciona; não existe mais
// um "Passo 6" tratando a ausência como desistência (isso já causou
// inativação em massa por engano quando a planilha vinha incompleta).
router.post('/upsert-bulk', exigir('criar'), asyncHandler(async (req, res) => {
  let alunos = [];
  let atividadesExcel = [];

  if (Array.isArray(req.body)) {
    alunos = req.body;
  } else if (req.body && req.body.alunos) {
    alunos = req.body.alunos;
    atividadesExcel = req.body.atividades || [];
  } else {
    alunos = [req.body];
  }

  if (alunos.length === 0) return res.status(400).json({ error: 'Nenhum dado enviado.' });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const today = hojeBrasil();

    // Passo 0: corrige nome de aluno/professor que só difere por
    // acento/maiúscula/espaço de um já cadastrado, e separa quem só ficou
    // "parecido" (possível erro de digitação, mas não corrige sozinho — ver
    // resolverNomeParecido). Mexe direto em `alunoRaw.nome` de cada linha,
    // ANTES de qualquer outro passo, pra que toda referência mais abaixo
    // (que sempre lê `alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno`) já
    // use o nome corrigido sem precisar mudar em 6 lugares diferentes.
    // Nome de turma NÃO passa por essa comparação — nomes de turma variam
    // de propósito (mesma atividade, dia/horário diferente) e a comparação
    // gerava falsos positivos.
    const [alunosExistentesNomes, professoresExistentesNomes] = await Promise.all([
      connection.query('SELECT nome FROM alunos WHERE id_instituicao = ? AND excluido_em IS NULL', [req.id_instituicao]).then(([r]) => r.map(x => x.nome)),
      connection.query('SELECT nome FROM professores WHERE id_instituicao = ?', [req.id_instituicao]).then(([r]) => r.map(x => x.nome)),
    ]);

    const nomesCorrigidos = { alunos: [], professores: [] };
    const possiveisDuplicados = { alunos: [], professores: [] };
    const jaReportado = new Set(); // evita reportar o mesmo nome mais de uma vez (professor repete entre linhas)

    // Resolve um nome contra a lista de existentes da categoria (aluno/
    // professor): corrige em silêncio se for só grafia (acento/maiúscula/
    // espaço), registra como suspeita se for só parecido, e devolve o nome
    // final a usar (corrigido, ou o original se não achou nada relacionado).
    const resolverEAplicar = (categoria, destino, nomeOriginal, nomesExistentes) => {
      const resultado = resolverNomeParecido(nomeOriginal, nomesExistentes);
      if (resultado.tipo === 'corrigido') {
        if (!jaReportado.has(`${categoria}:${nomeOriginal}`)) {
          jaReportado.add(`${categoria}:${nomeOriginal}`);
          destino.corrigidos.push({ enviado: nomeOriginal, corrigido_para: resultado.nome });
        }
        return resultado.nome;
      }
      if (resultado.tipo === 'suspeita' && !jaReportado.has(`${categoria}:${nomeOriginal}`)) {
        jaReportado.add(`${categoria}:${nomeOriginal}`);
        destino.suspeitos.push({ enviado: nomeOriginal, parecido_com: resultado.nome });
      }
      return nomeOriginal;
    };

    for (const alunoRaw of alunos) {
      const nomeOriginal = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno || '').trim();
      alunoRaw.nome = resolverEAplicar('aluno', { corrigidos: nomesCorrigidos.alunos, suspeitos: possiveisDuplicados.alunos }, nomeOriginal, alunosExistentesNomes);
    }

    // Turno de cada aluno ANTES do upsert (Passo 1) — precisa pra decidir, no
    // Passo 5f mais abaixo, se o turno mudou de verdade e vale a pena revisitar
    // as matrículas dele. Depois do upsert essa informação já teria sido
    // sobrescrita, por isso é buscada aqui, antes de tudo.
    const nomesParaTurnoAntigo = alunos.map(a => String(a.nome || a.ALUNO || a.Aluno).trim());
    let turnoAntigoPorNome = new Map();
    if (nomesParaTurnoAntigo.length > 0) {
      const [alunosAntes] = await connection.query(
        `SELECT nome, turno FROM alunos WHERE nome IN (?) AND id_instituicao = ? AND excluido_em IS NULL`,
        [nomesParaTurnoAntigo, req.id_instituicao]
      );
      turnoAntigoPorNome = new Map(alunosAntes.map(a => [a.nome, a.turno]));
    }

    // Passo 1: upsert dos alunos. Aceita nome vindo de diferentes cabeçalhos de
    // planilha (nome/ALUNO/Aluno) porque a planilha já mudou de formato antes.
    const values = alunos.map(a => [
      truncar(String(a.nome || a.ALUNO || a.Aluno).trim(), 255),
      parseDataNascimento(a.data_nascimento),
      parseDataNascimento(a.data_cadastro) || today,
      truncar(a.sexo, 1),
      truncar(a.telefone, 20),
      truncar(String(a.turma || '').trim(), 10) || null,
      truncar(a.turno, 50),
      truncar(a.transporte, 100),
      // O front sempre baixa o cabeçalho da planilha pra minúsculo antes de
      // enviar (ver processImportedData em GerenciarMatriculas.js) — `a.Inf`
      // com I maiúsculo nunca batia com nada e a coluna nunca era importada.
      truncar(a.inf, 60),
      truncar(a.acompanhamento, 50),
      truncar(a.ponto, 150),
      truncar(a.informacoes_gerais, 255),
      truncar(a.escola_atual, 150),
      'ativo',
      req.id_instituicao,
      agoraBrasil()
    ]);

    // `data_cadastro` e `criado_em` ficam de fora do ON DUPLICATE KEY UPDATE de
    // propósito: são a data/hora do PRIMEIRO cadastro do aluno na instituição —
    // uma vez gravadas, uma reimportação da planilha nunca deve sobrescrever
    // esses valores históricos. `informacoes_gerais` e `escola_atual` são o
    // oposto por pedido explícito: sobrescritos a cada reimportação, sem
    // guardar histórico (se o aluno mudar de escola, só troca o valor).
    const sql = `
      INSERT INTO alunos (nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, acompanhamento, ponto, informacoes_gerais, escola_atual, status, id_instituicao, criado_em)
      VALUES ?
      ON DUPLICATE KEY UPDATE
        data_nascimento = VALUES(data_nascimento),
        sexo = VALUES(sexo),
        telefone = VALUES(telefone),
        turma = VALUES(turma),
        turno = VALUES(turno),
        transporte = VALUES(transporte),
        Inf = VALUES(Inf),
        acompanhamento = VALUES(acompanhamento),
        ponto = VALUES(ponto),
        informacoes_gerais = VALUES(informacoes_gerais),
        escola_atual = VALUES(escola_atual)
    `;

    const [alunosUpsertResult] = await connection.query(sql, [values]);

    // Passo 2: result.insertId não é confiável em upsert de lote (não retorna o id
    // de cada linha), então recarregamos os alunos processados pelo nome.
    const studentNames = alunos.map(a => String(a.nome || a.ALUNO || a.Aluno).trim());
    // excluido_em IS NULL: um aluno excluído (soft-delete) não deve ser
    // "reaproveitado" silenciosamente por reimportar uma planilha com o mesmo
    // nome — se o nome bater com um registro excluído, o upsert acima ainda
    // atualiza a linha antiga (é a mesma restrição UNIQUE do banco), mas aqui
    // a gente simplesmente não processa matrícula pra ela.
    const [existingStudents] = await connection.query(
      `SELECT id, nome, turno, status FROM alunos WHERE nome IN (?) AND id_instituicao = ? AND excluido_em IS NULL`,
      [studentNames, req.id_instituicao]
    );
    const studentIdMap = new Map(existingStudents.map(s => [s.nome, { id: s.id, turno: s.turno, status: s.status }]));
    const idalunoParaNome = new Map(existingStudents.map(s => [s.id, s.nome]));

    // Passo 2b: status explícito da planilha (ex.: "espera" — aluno na fila
    // sem matrícula ainda, aguardando vaga). Feito como um UPDATE à parte, em
    // vez de entrar no upsert principal do Passo 1: assim um aluno NOVO sem
    // a coluna preenchida continua caindo no padrão 'ativo' da tabela, e um
    // aluno EXISTENTE sem a coluna preenchida não tem o status mexido —
    // sem isso não dá pra ter os dois comportamentos com um valor só no VALUES().
    // Rodado ANTES do syncAlunoStatusFromMatriculas lá embaixo, que já sabe
    // preservar 'espera' quando não há matrícula (ver status-sync.js).
    const statusExplicitos = [];
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno || !alunoRaw.status) continue;
      const statusLimpo = truncar(String(alunoRaw.status).trim().toLowerCase(), 20);
      if (!statusLimpo) continue;
      statusExplicitos.push([idaluno, statusLimpo]);
    }
    if (statusExplicitos.length > 0) {
      const caseWhen = statusExplicitos.map(([id]) => `WHEN ${id} THEN ?`).join(' ');
      const ids = statusExplicitos.map(([id]) => id);
      await connection.query(
        `UPDATE alunos SET status = CASE id ${caseWhen} END WHERE id IN (${ids.map(() => '?').join(',')}) AND id_instituicao = ?`,
        [...statusExplicitos.map(([, s]) => s), ...ids, req.id_instituicao]
      );
    }

    // Diferente de uma versão anterior desta rota: matrícula da planilha NÃO
    // é mais bloqueada quando o status explícito diz "inativo"/"espera" —
    // matrícula é o dado que manda. Se a planilha contradiz a si mesma (diz
    // "inativo" na coluna de status MAS também dá turma pra ele), a matrícula
    // é criada normalmente aqui, e o `syncAlunoStatusFromMatriculas` lá embaixo
    // (que agora roda pra TODO mundo, sem exceção pra quem tem status
    // explícito — ver esse ponto mais abaixo) corrige o status pra "ativo"
    // depois, porque é isso que reflete a realidade. Só fica "inativo"/"espera"
    // de verdade quem realmente não tem turma nenhuma na planilha. Foi assim
    // que um aluno ficou preso 8 meses como "inativo com matrícula aberta": a
    // planilha de origem continuava marcando "inativo" a cada reimportação, o
    // que também tirava ele da sincronização automática — matrícula era criada,
    // status nunca se corrigia sozinho.

    // Passo 3: varre as colunas de cada linha do Excel procurando o padrão de
    // matrícula (dia + horário, ex.: "SEG HR 1", "Segunda-HR2") e monta a lista de
    // matrículas a upsertar, junto com o conjunto de atividades/professores citados.
    // Desde a migração que separou `atividades` por horário (ver
    // migrate-split-atividades-por-horario.js), uma "turma" real é o par
    // nome+dia_semana+horario+turno — o mesmo nome pode ter várias linhas em
    // `atividades`, uma por horário. `slotsToFindOrCreate` guarda essa chave
    // completa; `atividadeNomes` guarda só os nomes (usado para achar as
    // linhas já existentes e sincronizar o professor declarado na planilha).
    let matriculasToUpsert = [];
    const atividadeNomes = new Set();
    const slotsToFindOrCreate = new Map(); // slotKey "nome|dia|horario|turno" -> { nome, dia_semana, horario, turno }
    const excelActivityProfMap = new Map(); // Mapa de atividade -> professor
    const excelActivityAreaMap = new Map(); // Mapa de atividade -> área (educacional/esportivo/cultural/tecnologico/capelania)

    // Processa a aba de atividades enviada do Excel (só declara o professor e
    // a área de cada nome de atividade — não cria linha em `atividades`
    // sozinha, porque sem dia/horário/turno não há uma turma específica pra
    // criar).
    for (const atv of atividadesExcel) {
      const atvNomeBruto = String(atv.atividade || atv.nome || atv.atividades || '').trim();
      const atvNome = atvNomeBruto ? normalizarNomeAtividade(atvNomeBruto) : '';
      const profNomeBruto = String(atv.professor || atv.professores || atv.prof || '').trim();
      const profNome = profNomeBruto
        ? resolverEAplicar('professor', { corrigidos: nomesCorrigidos.professores, suspeitos: possiveisDuplicados.professores }, profNomeBruto, professoresExistentesNomes)
        : '';
      const areaNormalizada = normalizarArea(atv.área ?? atv.area ?? atv.categoria);
      if (atvNome) {
        atividadeNomes.add(atvNome);
        if (profNome) {
          excelActivityProfMap.set(atvNome, profNome);
        }
        if (areaNormalizada) {
          excelActivityAreaMap.set(atvNome, areaNormalizada);
        }
      }
    }

    // Regex para identificar colunas de matrícula como "SEG HR 1", "TER HR 2", "Segunda HR 1", "SEG-HR1", etc.
    const matriculaColRegex = /^(seg|ter|qua|qui|sex|segunda|terca|quarta|quinta|sexta)[\s\-_]*(hr|horario|h)[\s\-_]*(\d+)$/i;
    const diaSemanaMap = {
      'seg': 'Segunda', 'segunda': 'Segunda',
      'ter': 'Terça', 'terca': 'Terça',
      'qua': 'Quarta', 'quarta': 'Quarta',
      'qui': 'Quinta', 'quinta': 'Quinta',
      'sex': 'Sexta', 'sexta': 'Sexta'
    };

    // Conflito de horário: mesmo aluno + mesmo dia + mesmo horário não pode
    // apontar pra turmas diferentes dentro do MESMO upload (normalmente sinal
    // de linha duplicada do aluno na planilha, com turmas diferentes
    // preenchidas por engano). Não bloqueia trocar de turma entre uploads
    // diferentes — isso já é o mecanismo normal de "encerra e recria".
    const ocupacaoAlunoSlot = new Map(); // "idaluno|dia|horario" -> nome_atividade já visto neste upload
    const conflitosHorario = [];
    const conflitosTurno = [];
    const turmasSemArea = new Set(); // nomes de turma cuja área foi um palpite (nenhum prefixo reconhecido, classificada como Cultural por padrão)

    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const studentInfo = studentIdMap.get(alunoNome);
      const idaluno = studentInfo?.id;
      const alunoTurno = validarTurno(studentInfo?.turno || alunoRaw.turno); // Prioriza turno do DB, senão do Excel

      if (!idaluno) {
        console.warn(`Aluno ${alunoNome} não encontrado após upsert. Pulando matrículas.`);
        continue;
      }

      for (const key in alunoRaw) {
        const match = key.match(matriculaColRegex);
        if (match && alunoRaw[key]) { // Se é uma coluna de matrícula e tem um valor (nome da atividade)
          const diaAbreviado = match[1].toLowerCase();
          const horarioNum = match[3]; // Grupo de captura do número do horário
          const horario = `HR ${horarioNum}`; // Formata como "HR 1", "HR 2", etc.
          const dia_semana = diaSemanaMap[diaAbreviado];
          const nome_atividade = normalizarNomeAtividade(alunoRaw[key]);

          if (dia_semana && nome_atividade && alunoTurno) { // Garante que todas as partes são válidas
            const slotAlunoKey = `${idaluno}|${dia_semana}|${horario}`;
            const ocupacaoAtual = ocupacaoAlunoSlot.get(slotAlunoKey);
            if (ocupacaoAtual && ocupacaoAtual !== nome_atividade) {
              conflitosHorario.push({ aluno: alunoNome, dia_semana, horario, turma_1: ocupacaoAtual, turma_2: nome_atividade });
              continue; // não adiciona a segunda matrícula conflitante
            }
            ocupacaoAlunoSlot.set(slotAlunoKey, nome_atividade);

            atividadeNomes.add(nome_atividade);
            const slotKey = `${nome_atividade}|${dia_semana}|${horario}|${alunoTurno}`;
            if (!slotsToFindOrCreate.has(slotKey)) {
              slotsToFindOrCreate.set(slotKey, { nome: nome_atividade, dia_semana, horario, turno: alunoTurno });
            }
            matriculasToUpsert.push({
              idaluno,
              nome_atividade, // Armazena temporariamente o nome (+ turno/horario/dia_semana abaixo), será resolvido pro idatividades certo no Passo 4
              turno: alunoTurno,
              horario,
              dia_semana,
              id_instituicao: req.id_instituicao
            });
          }
        }
      }
    }

    // Passo 4: garante que toda TURMA (nome + dia + horário + turno) citada na
    // planilha exista no banco — cada combinação é uma linha própria em
    // `atividades` desde a separação por horário (ver
    // migrate-split-atividades-por-horario.js); o nome sozinho não identifica
    // mais qual turma é.
    const activityIdMap = new Map(); // slotKey "nome|dia|horario|turno" -> idatividades
    if (atividadeNomes.size > 0) {
      // 4.1 Professores: sempre garante 'Professor Padrão' (usado quando a planilha
      // não especifica professor para uma atividade).
      const profsToFindOrCreate = new Set(['Professor Padrão']);
      for (const profNome of excelActivityProfMap.values()) {
        profsToFindOrCreate.add(profNome);
      }

      const profIdMap = new Map();
      const profsArray = Array.from(profsToFindOrCreate);
      const [existingProfs] = await connection.query(
        `SELECT id, nome FROM professores WHERE nome IN (?) AND id_instituicao = ?`,
        [profsArray, req.id_instituicao]
      );
      existingProfs.forEach(p => profIdMap.set(p.nome, p.id));

      const profsToCreate = profsArray.filter(name => !profIdMap.has(name));
      if (profsToCreate.length > 0) {
        const newProfsValues = profsToCreate.map(name => [name, req.id_instituicao]);
        await connection.query(
          `INSERT INTO professores (nome, id_instituicao) VALUES ?`,
          [newProfsValues]
        );
        const [newlyCreatedProfs] = await connection.query(
          `SELECT id, nome FROM professores WHERE nome IN (?) AND id_instituicao = ?`,
          [profsToCreate, req.id_instituicao]
        );
        newlyCreatedProfs.forEach(p => profIdMap.set(p.nome, p.id));
      }

      const defaultProfessorId = profIdMap.get('Professor Padrão');

      // 4.2 Turmas: busca todas as linhas já existentes com algum dos nomes
      // citados (pode haver várias por nome, uma por horário — ver comentário
      // acima) e monta o mapa pelo slot exato (nome+dia+horário+turno).
      const [existingActivities] = await connection.query(
        `SELECT idatividades, nome, idprofessor, area, dia_semana, horario, turno FROM atividades WHERE nome IN (?) AND id_instituicao = ?`,
        [Array.from(atividadeNomes), req.id_instituicao]
      );
      existingActivities.forEach(act => {
        if (act.dia_semana && act.horario && act.turno) {
          activityIdMap.set(`${act.nome}|${act.dia_semana}|${act.horario}|${act.turno}`, act.idatividades);
        }
      });

      // Conflito de turno: essa turma (mesmo nome+dia+horário) já existe de
      // verdade num turno diferente do turno do aluno — sem essa checagem,
      // isso criaria uma segunda turma duplicada só pra "encaixar" o turno
      // errado, e um aluno da tarde acabaria numa atividade da manhã.
      // EXCEÇÃO: se é o próprio aluno mudando de turno nesta importação (ver
      // turnoAntigoPorNome), não é conflito — é exatamente o caso de "encerra
      // a matrícula antiga e cria/usa a turma do turno novo" (mesmo nome,
      // outra linha em `atividades`), então deixa passar.
      const turnosPorNomeDiaHorario = new Map(); // "nome|dia|horario" -> Set de turnos já cadastrados
      existingActivities.forEach(act => {
        if (!act.dia_semana || !act.horario || !act.turno) return;
        const key = `${act.nome}|${act.dia_semana}|${act.horario}`;
        const set = turnosPorNomeDiaHorario.get(key) || new Set();
        set.add(act.turno);
        turnosPorNomeDiaHorario.set(key, set);
      });

      const matriculasValidas = [];
      for (const m of matriculasToUpsert) {
        const key = `${m.nome_atividade}|${m.dia_semana}|${m.horario}`;
        const turnosExistentes = turnosPorNomeDiaHorario.get(key);
        // podeMatricular (não só === ) pra não travar ensaio: uma turma de
        // turno "Noite" é sempre compatível com qualquer turno de aluno.
        const incompativel = turnosExistentes && turnosExistentes.size > 0 && ![...turnosExistentes].some(t => podeMatricular(m.turno, t));
        const nomeDoAluno = idalunoParaNome.get(m.idaluno);
        const turnoAntigoDoAluno = turnoAntigoPorNome.get(nomeDoAluno);
        const alunoMudouDeTurnoNestaImportacao = turnoAntigoDoAluno !== undefined && (turnoAntigoDoAluno || null) !== (m.turno || null);
        if (incompativel && !alunoMudouDeTurnoNestaImportacao) {
          conflitosTurno.push({
            aluno: nomeDoAluno || `aluno #${m.idaluno}`,
            turma: m.nome_atividade,
            dia_semana: m.dia_semana,
            horario: m.horario,
            turno_aluno: m.turno,
            turno_turma: [...turnosExistentes].join('/')
          });
          continue;
        }
        matriculasValidas.push(m);
      }
      matriculasToUpsert = matriculasValidas;

      // Remove da lista de "criar turma" qualquer slot que só existia por
      // causa de uma matrícula que acabou de ser rejeitada por conflito.
      const slotKeysAindaUsados = new Set(matriculasToUpsert.map(m => `${m.nome_atividade}|${m.dia_semana}|${m.horario}|${m.turno}`));
      for (const slotKey of [...slotsToFindOrCreate.keys()]) {
        if (!slotKeysAindaUsados.has(slotKey)) slotsToFindOrCreate.delete(slotKey);
      }

      // Cria as turmas (slots) que a planilha pede e que ainda não existem,
      // vinculando ao professor da planilha (ou ao Professor Padrão, se não
      // informado) e à área — a planilha não tem coluna "Área" própria, então
      // a área vem do PREFIXO do nome da turma (ver detectarAreaPorNome);
      // uma coluna "Área" explícita na aba Atividades, se existir, tem
      // prioridade sobre o prefixo.
      const slotsToCreate = Array.from(slotsToFindOrCreate.entries()).filter(
        ([slotKey]) => !activityIdMap.has(slotKey)
      );

      if (slotsToCreate.length > 0) {
        const newActivitiesValues = slotsToCreate.map(([, slot]) => {
          const profNome = excelActivityProfMap.get(slot.nome);
          const idprof = profNome ? profIdMap.get(profNome) : defaultProfessorId;
          const areaDoExcel = excelActivityAreaMap.get(slot.nome);
          const { area, confiavel } = areaDoExcel ? { area: areaDoExcel, confiavel: true } : detectarAreaPorNome(slot.nome);
          if (!confiavel) turmasSemArea.add(slot.nome);
          return [slot.nome, idprof, area, req.id_instituicao, slot.dia_semana, slot.horario, slot.turno];
        });
        const [insertResult] = await connection.query(
          `INSERT INTO atividades (nome, idprofessor, area, id_instituicao, dia_semana, horario, turno) VALUES ?`,
          [newActivitiesValues]
        );
        // Insert em lote numa única conexão: o MySQL garante ids contíguos a
        // partir de insertId, na mesma ordem dos VALUES — evita reconsultar.
        const primeiroId = insertResult.insertId;
        slotsToCreate.forEach(([slotKey], idx) => {
          activityIdMap.set(slotKey, primeiroId + idx);
        });
      }

      // 4.3 Se uma turma já existia mas a planilha trouxe um professor e/ou
      // área diferente do cadastrado, atualiza em todas as linhas daquele
      // nome (bulk update via CASE WHEN em vez de um UPDATE por linha, para
      // não fazer N idas ao banco) — dois updates independentes, um por
      // campo, pra não complicar o CASE WHEN combinando os dois.
      const activitiesToUpdate = [];
      const activitiesToUpdateArea = [];
      for (const existingAct of existingActivities) {
        const profNomeFromExcel = excelActivityProfMap.get(existingAct.nome);
        if (profNomeFromExcel) {
          const mappedProfId = profIdMap.get(profNomeFromExcel);
          if (mappedProfId && existingAct.idprofessor !== mappedProfId) {
            activitiesToUpdate.push([mappedProfId, existingAct.idatividades, req.id_instituicao]);
          }
        }
        // Uma coluna "Área" explícita na planilha pode corrigir a área de uma
        // turma que já tem uma (o coordenador decidiu mudar de propósito). Sem
        // coluna explícita, só preenche quando a turma ainda está sem área —
        // nunca sobrescreve por adivinhação uma área já definida (manualmente
        // em Turmas.js, ou por uma importação anterior).
        const areaFromExcel = excelActivityAreaMap.get(existingAct.nome);
        if (areaFromExcel) {
          if (existingAct.area !== areaFromExcel) {
            activitiesToUpdateArea.push([areaFromExcel, existingAct.idatividades]);
          }
        } else if (!existingAct.area) {
          const { area, confiavel } = detectarAreaPorNome(existingAct.nome);
          activitiesToUpdateArea.push([area, existingAct.idatividades]);
          if (!confiavel) turmasSemArea.add(existingAct.nome);
        }
      }
      if (activitiesToUpdate.length > 0) {
        const caseWhenParts = activitiesToUpdate.map(([profId, actId]) =>
          `WHEN ${actId} THEN ${profId}`
        ).join(' ');
        const actIds = activitiesToUpdate.map(([, actId]) => actId).join(',');

        await connection.query(
          `UPDATE atividades SET idprofessor = CASE idatividades ${caseWhenParts} END WHERE idatividades IN (${actIds}) AND id_instituicao = ?`,
          [req.id_instituicao]
        );
      }
      if (activitiesToUpdateArea.length > 0) {
        const caseWhenParts = activitiesToUpdateArea.map(([area, actId]) =>
          `WHEN ${actId} THEN ${pool.escape(area)}`
        ).join(' ');
        const actIds = activitiesToUpdateArea.map(([, actId]) => actId).join(',');

        await connection.query(
          `UPDATE atividades SET area = CASE idatividades ${caseWhenParts} END WHERE idatividades IN (${actIds}) AND id_instituicao = ?`,
          [req.id_instituicao]
        );
      }
    }

    // Passo 5: compara com as matrículas atuais (por aluno+turno+horario+dia_semana,
    // a "posição" na grade) para decidir upsert vs. encerrar-e-recriar.
    // Escopo é TODO aluno tocado pela planilha (existingStudents), não só quem
    // tem coluna de matrícula preenchida nesta linha — a autocorreção de
    // duplicidade logo abaixo precisa ver as matrículas de qualquer aluno do
    // upload, mesmo numa linha que só atualiza cadastro/nível sem mexer em turma.
    const studentIdsTocados = existingStudents.map(s => s.id);
    // `idaluno IN ()` é SQL inválido — acontece quando a planilha não bateu
    // com nenhum aluno já cadastrado (studentIdMap vazio).
    let [currentMatriculas] = studentIdsTocados.length > 0
      ? await connection.query(
          `SELECT idmatricula, idaluno, idatividades, turno, horario, dia_semana
           FROM matricula
           WHERE idaluno IN (?) AND id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL`,
          [studentIdsTocados, req.id_instituicao]
        )
      : [[]];

    // Mesma autocorreção já aplicada em matriculas.js (POST '/', ver comentário
    // lá) — se por algum motivo já existirem DUAS matrículas ativas na mesma
    // posição (aluno+turno+horario+dia_semana), o Map abaixo só consegue guardar
    // uma; sem isso a outra ficava órfã pra sempre, sem nenhum código nunca mais
    // enxergar ela. Fica com a MAIS RECENTE (maior idmatricula) e encerra as
    // outras automaticamente, nesta mesma transação.
    const porPosicao = new Map(); // "idaluno_turno_horario_dia" -> [idmatricula, ...]
    currentMatriculas.forEach(m => {
      const chave = `${m.idaluno}_${m.turno}_${m.horario}_${m.dia_semana}`;
      if (!porPosicao.has(chave)) porPosicao.set(chave, []);
      porPosicao.get(chave).push(m.idmatricula);
    });
    const duplicatasParaEncerrar = [];
    porPosicao.forEach(ids => {
      if (ids.length <= 1) return;
      const maisRecente = Math.max(...ids);
      ids.filter(id => id !== maisRecente).forEach(id => duplicatasParaEncerrar.push(id));
    });
    if (duplicatasParaEncerrar.length > 0) {
      await connection.query(
        `UPDATE matricula SET data_fim = ?, status = 'cancelada' WHERE idmatricula IN (?)`,
        [today, duplicatasParaEncerrar]
      );
      await logAuditEvent(
        'MATRICULA_DUPLICIDADE_AUTOCORRIGIDA',
        `Import em massa: ${duplicatasParaEncerrar.length} matrícula(s) duplicada(s) (mesma posição, já existiam antes deste import) encerrada(s) automaticamente: ${duplicatasParaEncerrar.join(', ')}`,
        req.id_instituicao,
        connection
      );
      // Remove as encerradas de `currentMatriculas` antes de montar o Map abaixo,
      // pra não reabrir a mesma confusão ali.
      currentMatriculas = currentMatriculas.filter(m => !duplicatasParaEncerrar.includes(m.idmatricula));
    }

    // Mapa de matrículas atuais por aluno + posição na grade (turno, horario, dia_semana)
    const currentMatriculaMap = new Map();
    for (const mat of currentMatriculas) {
      const key = `${mat.idaluno}_${mat.turno}_${mat.horario}_${mat.dia_semana}`;
      currentMatriculaMap.set(key, mat);
    }

    // Resolve idatividades real de cada matrícula pendente, pelo slot exato
    // (nome+dia+horário+turno) — não basta mais o nome sozinho.
    const finalMatriculasValues = matriculasToUpsert.map(m => [
      m.idaluno,
      activityIdMap.get(`${m.nome_atividade}|${m.dia_semana}|${m.horario}|${m.turno}`),
      m.turno,
      m.horario,
      m.dia_semana,
      m.id_instituicao
    ]);

    // Decide, posição por posição da grade, se mantém (nada a fazer), encerra a
    // antiga e cria uma nova (atividade mudou), ou cria do zero (posição nova).
    let matriculasAffected = 0;
    const matriculasToInsert = [];
    const matriculasToClose = [];

    for (const matricula of finalMatriculasValues) {
      const [idaluno, idatividades, turno, horario, dia_semana, id_instituicao] = matricula;
      const key = `${idaluno}_${turno}_${horario}_${dia_semana}`;
      const existingMatricula = currentMatriculaMap.get(key);

      if (existingMatricula) {
        if (existingMatricula.idatividades === idatividades) {
          // Matrícula idêntica já existe - não fazer nada
          continue;
        } else {
          // Atividade mudou para o mesmo horário - encerrar antiga e criar nova
          matriculasToClose.push(existingMatricula.idmatricula);
          matriculasToInsert.push([...matricula, today, 'matriculado']);
        }
      } else {
        // Matrícula não existe - criar nova
        matriculasToInsert.push([...matricula, today, 'matriculado']);
      }
    }

    // Encerrar matrículas antigas (atividade mudou)
    if (matriculasToClose.length > 0) {
      await connection.query(
        `UPDATE matricula SET data_fim = ?, status = 'cancelada' WHERE idmatricula IN (?)`,
        [today, matriculasToClose]
      );
    }

    // Inserir novas matrículas
    if (matriculasToInsert.length > 0) {
      const matriculaSql = `
        INSERT INTO matricula (idaluno, idatividades, turno, horario, dia_semana, id_instituicao, data_inicio, status)
        VALUES ?
      `;
      const [matriculaResult] = await connection.query(matriculaSql, [matriculasToInsert]);
      matriculasAffected = matriculaResult.affectedRows;
    }

    // Passo 5b: nível/subnível — mesmo padrão de "encerra e recria" das
    // matrículas acima (ver tabela aluno_niveis: histórico com data_inicio/
    // data_fim, igual à `matricula`). Colunas opcionais na planilha; aluno sem
    // `nivel` preenchido simplesmente não mexe no nível dele.
    const niveisFromExcel = [];
    let niveisForaDeFaixa = 0;
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno) continue;

      const nivelRaw = alunoRaw.nivel;
      // Célula em branco = aluno ainda sem nível definido, não é erro — só não
      // mexe no nível dele (mesma regra de "coluna opcional" de sempre).
      if (nivelRaw === undefined || nivelRaw === null || String(nivelRaw).trim() === '') continue;

      let nivel, subnivel;

      // O Excel AUTOCORRIGE célula tipo "4.1" (nível.subnível) pra DATA — "4.1"
      // é lido como "dia 4, mês 1" e vira um número de série de data (ex.:
      // 46026) ou, em alguns casos, um objeto Date de verdade (quando a lib de
      // leitura da planilha reconhece o formato de data da célula). Descoberto
      // analisando os valores "fora de faixa" reportados pelo usuário: todos
      // batiam exatamente com datas do ano da importação. Como dia/mês
      // carregam exatamente nível/subnível originais, dá pra reconstruir em
      // vez de simplesmente descartar a linha.
      if (nivelRaw instanceof Date) {
        nivel = nivelRaw.getUTCDate();
        subnivel = truncar(String(nivelRaw.getUTCMonth() + 1), 10);
      } else if (typeof nivelRaw === 'number' && Number.isInteger(nivelRaw) && nivelRaw > 99) {
        const dataReconstruida = new Date(Date.UTC(1899, 11, 30) + nivelRaw * 86400000);
        const ano = dataReconstruida.getUTCFullYear();
        if (ano >= 2015 && ano <= 2035) {
          nivel = dataReconstruida.getUTCDate();
          subnivel = truncar(String(dataReconstruida.getUTCMonth() + 1), 10);
        }
      }

      // Não era (nem foi reconstruído como) uma data — trata como nível "puro"
      // ou "nível.subnível" digitado direto (ex.: "3", "3.2"). Aceita ',' como
      // variante de separador decimal (o Excel em pt-BR às vezes formata assim)
      // só pra achar onde nível termina e subnível começa — o valor final de
      // cada um sai sempre como número inteiro puro, sem vírgula nem ponto.
      if (nivel === undefined) {
        const nivelStr = String(nivelRaw).trim().replace(',', '.');
        const [parteNivel, parteSubnivel] = nivelStr.split('.');
        nivel = parseInt(parteNivel, 10);
        if (isNaN(nivel)) continue;
        const subnivelNum = parteSubnivel ? parseInteiro(parteSubnivel) : parseInteiro(alunoRaw.subnivel);
        subnivel = subnivelNum === null ? null : truncar(String(subnivelNum), 10);
      }

      // A coluna `nivel` da tabela é TINYINT (guarda 1-4 na prática) — um
      // valor fora dessa faixa (e que não deu pra reconstruir como data acima)
      // não é nível nenhum, é outro dado que foi parar na célula errada.
      // Ignora a linha (sem travar o lote inteiro) e conta pra avisar no
      // resumo, porque provavelmente é erro de planilha.
      if (nivel < 1 || nivel > 99) { niveisForaDeFaixa++; continue; }

      niveisFromExcel.push({ idaluno, nivel, subnivel });
    }

    let niveisAfetados = 0;
    if (niveisFromExcel.length > 0) {
      const alunoIdsComNivel = [...new Set(niveisFromExcel.map(n => n.idaluno))];
      const [niveisAtuais] = await connection.query(
        `SELECT id, id_aluno, nivel, subnivel FROM aluno_niveis WHERE id_aluno IN (?) AND id_instituicao = ? AND data_fim IS NULL`,
        [alunoIdsComNivel, req.id_instituicao]
      );
      const nivelAtualPorAluno = new Map(niveisAtuais.map(n => [n.id_aluno, n]));

      const idsParaFechar = [];
      const novosNiveis = [];
      for (const item of niveisFromExcel) {
        const atual = nivelAtualPorAluno.get(item.idaluno);
        // Se a planilha não trouxe subnível nessa linha, mantém o subnível
        // atual em vez de tratar como "limpar o campo" — evita que uma
        // reimportação só com `nivel` preenchido apague um subnível já salvo.
        const subnivelEfetivo = item.subnivel !== null ? item.subnivel : (atual ? atual.subnivel : null);
        const mudou = !atual || atual.nivel !== item.nivel || (atual.subnivel || null) !== (subnivelEfetivo || null);
        if (!mudou) continue;
        if (atual) idsParaFechar.push(atual.id);
        novosNiveis.push([req.id_instituicao, item.idaluno, item.nivel, subnivelEfetivo, today]);
      }

      if (idsParaFechar.length > 0) {
        await connection.query(`UPDATE aluno_niveis SET data_fim = ? WHERE id IN (?)`, [today, idsParaFechar]);
      }
      if (novosNiveis.length > 0) {
        const [nivelResult] = await connection.query(
          `INSERT INTO aluno_niveis (id_instituicao, id_aluno, nivel, subnivel, data_inicio) VALUES ?`,
          [novosNiveis]
        );
        niveisAfetados = nivelResult.affectedRows;
      }
    }

    // Passo 5c: situação anual (matrícula/dívida) — diferente do nível, aqui a
    // chave natural já é o ANO (não uma janela contínua), então não precisa de
    // "encerrar e recriar": é um upsert simples por (aluno, ano). Cada virada
    // de ano cria uma linha nova sozinha, formando o histórico ano a ano.
    const anoAtual = Number(hojeBrasil().slice(0, 4));
    const situacoesFromExcel = [];
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno) continue;

      const situacaoMatricula = truncar(alunoRaw.situacao_matricula_ano, 50);
      const situacaoDivida = truncar(alunoRaw.situacao_divida_ano, 50);
      if (!situacaoMatricula && !situacaoDivida) continue;

      situacoesFromExcel.push([req.id_instituicao, idaluno, anoAtual, situacaoMatricula, situacaoDivida]);
    }

    let situacoesAfetadas = 0;
    if (situacoesFromExcel.length > 0) {
      const [situacaoResult] = await connection.query(
        `INSERT INTO aluno_situacao_anual (id_instituicao, id_aluno, ano, situacao_matricula, situacao_divida)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           situacao_matricula = COALESCE(VALUES(situacao_matricula), situacao_matricula),
           situacao_divida = COALESCE(VALUES(situacao_divida), situacao_divida)`,
        [situacoesFromExcel]
      );
      situacoesAfetadas = situacaoResult.affectedRows;
    }

    // Passo 5d: observações de saúde — o aluno pode ter mais de uma (comorbidade,
    // doença, laudo...), então não cabe numa coluna simples: vai numa tabela
    // 1-para-muitos (mesmo padrão de contatos_emergencia). A coluna na
    // planilha aceita uma lista separada por ";"; o import é ADITIVO — só
    // insere o que ainda não existe pra aquele aluno, nunca apaga nada
    // automaticamente (dado sensível, não é seguro sumir de uma reimportação
    // com a coluna em branco).
    const saudeFromExcel = []; // { idaluno, descricoes: [...] }
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno || !alunoRaw.observacoes_saude) continue;

      const descricoes = String(alunoRaw.observacoes_saude)
        .split(';')
        .map(s => truncar(s.trim(), 255))
        .filter(Boolean);
      if (descricoes.length > 0) saudeFromExcel.push({ idaluno, descricoes });
    }

    let saudeAfetada = 0;
    if (saudeFromExcel.length > 0) {
      const alunoIdsComSaude = [...new Set(saudeFromExcel.map(s => s.idaluno))];
      const [saudeExistente] = await connection.query(
        `SELECT id_aluno, descricao FROM aluno_saude WHERE id_aluno IN (?) AND id_instituicao = ?`,
        [alunoIdsComSaude, req.id_instituicao]
      );
      const existentesPorAluno = new Map();
      for (const row of saudeExistente) {
        const set = existentesPorAluno.get(row.id_aluno) || new Set();
        set.add(row.descricao.trim().toLowerCase());
        existentesPorAluno.set(row.id_aluno, set);
      }

      const novasEntradas = [];
      for (const item of saudeFromExcel) {
        const jaTem = existentesPorAluno.get(item.idaluno) || new Set();
        for (const descricao of item.descricoes) {
          if (jaTem.has(descricao.toLowerCase())) continue;
          novasEntradas.push([req.id_instituicao, item.idaluno, descricao]);
          jaTem.add(descricao.toLowerCase());
        }
      }

      if (novasEntradas.length > 0) {
        const [saudeResult] = await connection.query(
          `INSERT INTO aluno_saude (id_instituicao, id_aluno, descricao) VALUES ?`,
          [novasEntradas]
        );
        saudeAfetada = saudeResult.affectedRows;
      }
    }

    // Passo 5e: responsável legal — diferente de contatos_emergencia (lista
    // livre de "quem ligar"), aqui é UMA pessoa só por aluno, com documento,
    // que assinou a matrícula. Upsert simples por aluno (1 registro cada),
    // sobrescrito a cada reimportação — sem histórico, mesmo padrão de
    // informacoes_gerais/escola_atual.
    const responsaveisFromExcel = [];
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno) continue;

      const campos = {
        nome: truncar(alunoRaw.responsavel_nome, 255),
        cpf: truncar(alunoRaw.responsavel_cpf, 20),
        rg: truncar(alunoRaw.responsavel_rg, 20),
        data_nascimento: parseDataNascimento(alunoRaw.responsavel_data_nascimento),
        email: truncar(alunoRaw.responsavel_email, 255),
        endereco: truncar(alunoRaw.responsavel_endereco, 255),
        bairro: truncar(alunoRaw.responsavel_bairro, 100),
        cep: truncar(alunoRaw.responsavel_cep, 10),
        telefone: truncar(alunoRaw.responsavel_telefone, 20)
      };
      const temAlgumCampo = Object.values(campos).some(v => v !== null);
      if (!temAlgumCampo) continue;

      responsaveisFromExcel.push([
        req.id_instituicao, idaluno, campos.nome, campos.cpf, campos.rg,
        campos.data_nascimento, campos.email, campos.endereco, campos.bairro,
        campos.cep, campos.telefone
      ]);
    }

    let responsaveisAfetados = 0;
    if (responsaveisFromExcel.length > 0) {
      // COALESCE(VALUES(x), x): só sobrescreve o campo que veio preenchido
      // nessa linha da planilha — uma reimportação parcial (ex.: só corrigindo
      // o telefone) não pode apagar CPF/RG/endereço já cadastrados antes.
      const [responsavelResult] = await connection.query(
        `INSERT INTO responsavel_legal
           (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           nome = COALESCE(VALUES(nome), nome),
           cpf = COALESCE(VALUES(cpf), cpf),
           rg = COALESCE(VALUES(rg), rg),
           data_nascimento = COALESCE(VALUES(data_nascimento), data_nascimento),
           email = COALESCE(VALUES(email), email),
           endereco = COALESCE(VALUES(endereco), endereco),
           bairro = COALESCE(VALUES(bairro), bairro),
           cep = COALESCE(VALUES(cep), cep),
           telefone = COALESCE(VALUES(telefone), telefone)`,
        [responsaveisFromExcel]
      );
      responsaveisAfetados = responsavelResult.affectedRows;
    }

    // Passo 5f: turno mudou na planilha — encerra as matrículas do aluno que
    // ficaram incompatíveis com o turno novo (mesma lógica do PUT/PATCH de
    // aluno, ver encerrarMatriculasForaDoTurno em status-sync.js). O Passo 5
    // acima já cuida de quando a ATIVIDADE muda numa posição específica da
    // grade; isso aqui cobre o caso de uma matrícula antiga que a planilha
    // simplesmente não menciona mais (porque o aluno mudou de turno todo, não
    // só de uma turma) — sem isso, ela ficava aberta pra sempre.
    let matriculasEncerradasTrocaTurno = 0;
    const turmasEncerradasTrocaTurno = [];
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno) continue;

      const turnoAntigo = turnoAntigoPorNome.get(alunoNome);
      if (turnoAntigo === undefined) continue; // aluno novo nesta importação — não tem matrícula antiga pra revisitar
      const turnoNovo = truncar(alunoRaw.turno, 50) || null;
      if (turnoNovo === (turnoAntigo || null)) continue;

      const resultadoTurno = await encerrarMatriculasForaDoTurno(connection, idaluno, turnoNovo, req.id_instituicao);
      matriculasEncerradasTrocaTurno += resultadoTurno.encerradas;
      turmasEncerradasTrocaTurno.push(...resultadoTurno.turmas);
    }
    if (matriculasEncerradasTrocaTurno > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_TROCA_TURNO',
        `Import em massa: ${matriculasEncerradasTrocaTurno} matrícula(s) encerrada(s) por troca de turno: ${turmasEncerradasTrocaTurno.join(', ')}`,
        req.id_instituicao,
        connection
      );
    }

    // Status explícito da planilha diferente de "ativo" (ex.: "espera") — só
    // vale ter matrícula se o aluno estiver ativo, então encerra tudo que
    // ficou aberto (mesma regra da troca de turno, ver encerrarMatriculasSeNaoAtivo
    // em status-sync.js). Roda depois do Passo 5/5f pra pegar até matrículas
    // criadas nesta mesma importação.
    let matriculasEncerradasStatus = 0;
    const turmasEncerradasStatus = [];
    for (const [idaluno, statusLimpo] of statusExplicitos) {
      const resultadoStatus = await encerrarMatriculasSeNaoAtivo(connection, idaluno, statusLimpo, req.id_instituicao);
      matriculasEncerradasStatus += resultadoStatus.encerradas;
      turmasEncerradasStatus.push(...resultadoStatus.turmas);
    }
    if (matriculasEncerradasStatus > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_STATUS',
        `Import em massa: ${matriculasEncerradasStatus} matrícula(s) encerrada(s) por status diferente de ativo: ${turmasEncerradasStatus.join(', ')}`,
        req.id_instituicao,
        connection
      );
    }

    // Garante que alunos.status reflita a matrícula real de todo mundo que foi
    // tocado nesta importação — quem NÃO veio na planilha não é sincronizado
    // aqui (nem em nenhum outro lugar deste endpoint): a ausência não é mais
    // tratada como desistência (ver comentário no topo da rota). Roda pra
    // TODO MUNDO tocado, inclusive quem tem status explícito na planilha —
    // matrícula é a fonte da verdade (ver comentário no Passo 2b): se a
    // planilha disse "inativo"/"espera" mas também deu turma, o status
    // explícito gravado acima é sobrescrito pra "ativo" aqui, porque é isso
    // que reflete a realidade. Só continua "inativo"/"espera" quem realmente
    // não tem nenhuma matrícula aberta (a proteção de "espera" contra virar
    // "inativo" sozinho por falta de matrícula continua em
    // syncAlunoStatusFromMatriculas, sem mudança).
    const idsParaSincronizar = existingStudents.map(s => s.id);
    await syncAlunoStatusFromMatriculas(connection, idsParaSincronizar, req.id_instituicao);

    await connection.commit();

    res.json({
      message: 'Processamento concluído',
      resumo: {
        total_recebido: alunos.length,
        alunos_afetados: alunosUpsertResult.affectedRows,
        matriculas_afetadas: matriculasAffected,
        status_explicitos_aplicados: statusExplicitos.length,
        niveis_afetados: niveisAfetados,
        niveis_fora_de_faixa_ignorados: niveisForaDeFaixa,
        situacoes_anuais_afetadas: situacoesAfetadas,
        observacoes_saude_adicionadas: saudeAfetada,
        responsaveis_afetados: responsaveisAfetados,
        matriculas_encerradas_troca_turno: matriculasEncerradasTrocaTurno,
        turmas_encerradas_troca_turno: turmasEncerradasTrocaTurno,
        matriculas_encerradas_status: matriculasEncerradasStatus,
        turmas_encerradas_status: turmasEncerradasStatus,
        nomes_corrigidos: nomesCorrigidos,
        possiveis_duplicados: possiveisDuplicados,
        conflitos_horario: conflitosHorario,
        conflitos_turno: conflitosTurno,
        turmas_sem_area: [...turmasSemArea]
      }
    });
  } catch (err) {
    console.error('Erro no upsert-bulk:', err);
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

// Criar Aluno com Validação — além dos campos diretos da tabela `alunos`,
// aceita opcionalmente nível/subnível, situação anual, uma observação de
// saúde e o responsável legal (mesmos dados que o import em massa preenche
// via planilha, ver Passo 5b-5e do upsert-bulk acima), pra dar pra cadastrar
// um aluno completo manualmente sem precisar passar por Excel.
router.post('/', exigir('criar'), validate('aluno'), asyncHandler(async (req, res) => {
  const {
    nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, status, acompanhamento, ponto, informacoes_gerais, escola_atual,
    nivel, subnivel, situacao_matricula, situacao_divida, observacao_saude,
    responsavel_nome, responsavel_cpf, responsavel_rg, responsavel_data_nascimento, responsavel_email, responsavel_endereco, responsavel_bairro, responsavel_cep, responsavel_telefone
  } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT INTO alunos (nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, acompanhamento, ponto, informacoes_gerais, escola_atual, status, id_instituicao, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nome, data_nascimento || null, data_cadastro || hojeBrasil(), sexo || null, telefone || null,
        turma || null, turno || null, transporte || null, Inf || null,
        acompanhamento || null, ponto || null, informacoes_gerais || null, escola_atual || null,
        status || 'ativo', req.id_instituicao, agoraBrasil()
      ]
    );
    const idaluno = result.insertId;

    const nivelNum = parseInt(nivel, 10);
    if (!isNaN(nivelNum) && nivelNum >= 1 && nivelNum <= 99) {
      const subnivelNum = parseInteiro(subnivel);
      await connection.query(
        `INSERT INTO aluno_niveis (id_instituicao, id_aluno, nivel, subnivel, data_inicio) VALUES (?, ?, ?, ?, CURDATE())`,
        [req.id_instituicao, idaluno, nivelNum, subnivelNum === null ? null : truncar(String(subnivelNum), 10)]
      );
    }

    if (situacao_matricula || situacao_divida) {
      await connection.query(
        `INSERT INTO aluno_situacao_anual (id_instituicao, id_aluno, ano, situacao_matricula, situacao_divida) VALUES (?, ?, YEAR(CURDATE()), ?, ?)`,
        [req.id_instituicao, idaluno, truncar(situacao_matricula, 50), truncar(situacao_divida, 50)]
      );
    }

    if (observacao_saude && String(observacao_saude).trim()) {
      await connection.query(
        `INSERT INTO aluno_saude (id_instituicao, id_aluno, descricao) VALUES (?, ?, ?)`,
        [req.id_instituicao, idaluno, truncar(observacao_saude, 255)]
      );
    }

    if (responsavel_nome && String(responsavel_nome).trim()) {
      await connection.query(
        `INSERT INTO responsavel_legal (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.id_instituicao, idaluno, truncar(responsavel_nome, 255), truncar(responsavel_cpf, 20), truncar(responsavel_rg, 20),
          responsavel_data_nascimento || null, truncar(responsavel_email, 255), truncar(responsavel_endereco, 255),
          truncar(responsavel_bairro, 100), truncar(responsavel_cep, 10), truncar(responsavel_telefone, 20)
        ]
      );
    }

    await logAuditEvent('CRIAR_ALUNO', `Aluno ID: ${idaluno}, Nome: ${nome}`, req.id_instituicao, connection);
    await connection.commit();
    res.status(201).json({ id: idaluno, message: 'Aluno criado com sucesso!' });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

// Edição completa de um aluno já existente — irmã do POST '/' (mesmos campos:
// dados diretos + nível/subnível + situação anual do ano corrente + responsável
// legal), mas para ATUALIZAR em vez de criar. Diferente do PATCH '/:id' logo
// abaixo (que só troca um campo simples de cada vez): esta rota espera o
// formulário inteiro da tela de edição e escreve tudo numa transação só.
//
// Nível: se mudou de verdade (nível ou subnível diferentes do atual), encerra
// o registro de histórico aberto e abre um novo — mesmo padrão de
// data_inicio/data_fim do upsert-bulk. Se o campo nível veio vazio e havia um
// nível aberto, só encerra (aluno fica sem nível registrado).
//
// Situação anual e responsável legal são upsert "substitui tudo" (o que está
// no formulário é o que fica salvo, inclusive limpando um campo que o usuário
// apagou) — diferente do import em massa, que preserva o que não veio
// preenchido; aqui a tela sempre carrega os valores atuais antes de editar,
// então um campo vazio é uma decisão explícita de apagar, não "não informado".
//
// Observação de saúde continua só ADITIVA (mesmo padrão do resto do sistema:
// "o import em massa só adiciona, nunca apaga") — o texto do formulário vira
// uma nova entrada na lista, as entradas antigas continuam intactas (removíveis
// à parte via DELETE '/:alunoId/saude/:saudeId').
router.put('/:id', exigir('editar'), validate('aluno'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const {
    nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, status, acompanhamento, ponto, informacoes_gerais, escola_atual,
    nivel, subnivel, situacao_matricula, situacao_divida, observacao_saude,
    responsavel_nome, responsavel_cpf, responsavel_rg, responsavel_data_nascimento, responsavel_email, responsavel_endereco, responsavel_bairro, responsavel_cep, responsavel_telefone
  } = req.body;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Turno ANTES da troca — precisa saber se mudou de verdade pra decidir se
    // vale a pena revisitar as matrículas dele (ver encerrarMatriculasForaDoTurno).
    const [[alunoAntes]] = await connection.query(
      'SELECT turno, status FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
      [id, req.id_instituicao]
    );
    const turnoAntigo = alunoAntes?.turno || null;

    const [result] = await connection.query(
      `UPDATE alunos SET nome=?, data_nascimento=?, data_cadastro=?, sexo=?, telefone=?, turma=?, turno=?, transporte=?, Inf=?,
         acompanhamento=?, ponto=?, informacoes_gerais=?, escola_atual=?, status=?
       WHERE id=? AND id_instituicao=? AND excluido_em IS NULL`,
      [
        nome, data_nascimento || null, data_cadastro || null, sexo || null, telefone || null,
        turma || null, turno || null, transporte || null, Inf || null,
        acompanhamento || null, ponto || null, informacoes_gerais || null, escola_atual || null,
        status || 'ativo', id, req.id_instituicao
      ]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Aluno não encontrado.' });
    }

    // Turno mudou de verdade? Encerra as matrículas que ficaram incompatíveis
    // com o turno novo (ensaios/turno "Noite" nunca são afetados — ver comentário
    // em encerrarMatriculasForaDoTurno).
    let resultadoTurno = { encerradas: 0, turmas: [] };
    if ((turno || null) !== turnoAntigo) {
      resultadoTurno = await encerrarMatriculasForaDoTurno(connection, id, turno, req.id_instituicao);
    }

    // Nível: compara com o que está aberto hoje antes de mexer, mesma lógica
    // de "mudou" do upsert-bulk.
    const [nivelAtualRows] = await connection.query(
      'SELECT id, nivel, subnivel FROM aluno_niveis WHERE id_aluno = ? AND id_instituicao = ? AND data_fim IS NULL',
      [id, req.id_instituicao]
    );
    const nivelAtual = nivelAtualRows[0] || null;
    const nivelNum = parseInt(nivel, 10);
    const subnivelNum = parseInteiro(subnivel);
    const nivelNovo = !isNaN(nivelNum) && nivelNum >= 1 && nivelNum <= 99 ? nivelNum : null;
    const subnivelNovo = nivelNovo === null ? null : (subnivelNum === null ? null : truncar(String(subnivelNum), 10));
    const nivelMudou = (nivelAtual?.nivel ?? null) !== nivelNovo || (nivelAtual?.subnivel ?? null) !== subnivelNovo;
    if (nivelMudou) {
      if (nivelAtual) {
        await connection.query('UPDATE aluno_niveis SET data_fim = CURDATE() WHERE id = ?', [nivelAtual.id]);
      }
      if (nivelNovo !== null) {
        await connection.query(
          `INSERT INTO aluno_niveis (id_instituicao, id_aluno, nivel, subnivel, data_inicio) VALUES (?, ?, ?, ?, CURDATE())`,
          [req.id_instituicao, id, nivelNovo, subnivelNovo]
        );
      }
    }

    // Situação anual do ano corrente: só mexe se já existia uma linha (edição
    // de verdade) ou se algum dos dois campos foi preenchido (linha nova).
    const [situacaoExistente] = await connection.query(
      'SELECT id FROM aluno_situacao_anual WHERE id_aluno = ? AND id_instituicao = ? AND ano = YEAR(CURDATE())',
      [id, req.id_instituicao]
    );
    if (situacaoExistente.length > 0 || situacao_matricula || situacao_divida) {
      await connection.query(
        `INSERT INTO aluno_situacao_anual (id_instituicao, id_aluno, ano, situacao_matricula, situacao_divida)
         VALUES (?, ?, YEAR(CURDATE()), ?, ?)
         ON DUPLICATE KEY UPDATE situacao_matricula = VALUES(situacao_matricula), situacao_divida = VALUES(situacao_divida)`,
        [req.id_instituicao, id, truncar(situacao_matricula, 50), truncar(situacao_divida, 50)]
      );
    }

    if (observacao_saude && String(observacao_saude).trim()) {
      await connection.query(
        `INSERT INTO aluno_saude (id_instituicao, id_aluno, descricao) VALUES (?, ?, ?)`,
        [req.id_instituicao, id, truncar(observacao_saude, 255)]
      );
    }

    if (responsavel_nome && String(responsavel_nome).trim()) {
      await connection.query(
        `INSERT INTO responsavel_legal (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE nome=VALUES(nome), cpf=VALUES(cpf), rg=VALUES(rg), data_nascimento=VALUES(data_nascimento),
           email=VALUES(email), endereco=VALUES(endereco), bairro=VALUES(bairro), cep=VALUES(cep), telefone=VALUES(telefone)`,
        [
          req.id_instituicao, id, truncar(responsavel_nome, 255), truncar(responsavel_cpf, 20), truncar(responsavel_rg, 20),
          responsavel_data_nascimento || null, truncar(responsavel_email, 255), truncar(responsavel_endereco, 255),
          truncar(responsavel_bairro, 100), truncar(responsavel_cep, 10), truncar(responsavel_telefone, 20)
        ]
      );
    }

    if (resultadoTurno.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_TROCA_TURNO',
        `Aluno ID: ${id}, turno ${turnoAntigo || '(vazio)'} -> ${turno || '(vazio)'}, ${resultadoTurno.encerradas} matrícula(s) encerrada(s): ${resultadoTurno.turmas.join(', ')}`,
        req.id_instituicao,
        connection
      );
    }

    // Status virou algo diferente de "ativo" (ex.: "espera")? Matrícula só
    // vale pra aluno ativo — encerra tudo que ficou aberto (mesma regra da
    // troca de turno, ver encerrarMatriculasSeNaoAtivo em status-sync.js).
    let resultadoStatus = { encerradas: 0, turmas: [] };
    if ((status || 'ativo') !== (alunoAntes?.status || 'ativo')) {
      resultadoStatus = await encerrarMatriculasSeNaoAtivo(connection, id, status, req.id_instituicao);
    }
    if (resultadoStatus.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_STATUS',
        `Aluno ID: ${id}, status -> ${status}, ${resultadoStatus.encerradas} matrícula(s) encerrada(s): ${resultadoStatus.turmas.join(', ')}`,
        req.id_instituicao,
        connection
      );
    }

    await logAuditEvent('ATUALIZAR_ALUNO', `Aluno ID: ${id}, edição completa por usuário #${req.user.id}`, req.id_instituicao, connection);
    await connection.commit();
    res.json({
      message: 'Aluno atualizado com sucesso!',
      matriculas_encerradas: resultadoTurno.encerradas + resultadoStatus.encerradas,
      turmas_encerradas: [...resultadoTurno.turmas, ...resultadoStatus.turmas]
    });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

// Atualização parcial via PATCH: só permite alterar um campo por vez, e apenas os
// campos na whitelist (evita que o cliente altere colunas sensíveis como id_instituicao).
router.patch('/:id', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { campo, valor } = req.body;
  const colunasPermitidas = ['data_nascimento', 'data_cadastro', 'sexo', 'telefone', 'turma', 'turno', 'transporte', 'Inf', 'acompanhamento', 'ponto', 'informacoes_gerais', 'escola_atual', 'status', 'inativado_em'];

  if (!colunasPermitidas.includes(campo)) {
    return res.status(400).json({ error: 'Campo não permitido para atualização.' });
  }

  // `inativado_em` normalmente é preenchido sozinho (ver bloco logo abaixo do
  // UPDATE principal), mas a tela de Gerenciar Matrículas também deixa
  // corrigir manualmente por aqui, caso a data automática esteja errada.
  if (campo === 'inativado_em' && valor && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    return res.status(400).json({ error: 'Data inválida. Use o formato AAAA-MM-DD.' });
  }

  // Pra "desistência" (ver notificação abaixo), precisa saber o status ANTES
  // de trocar — só é um evento novo se ele não já estava inativo. Pra troca de
  // turno, precisa do turno ANTES pra decidir se mudou de verdade (ver
  // encerrarMatriculasForaDoTurno abaixo).
  let statusAnterior = null;
  let nomeAluno = null;
  let turnoAnterior = null;
  if (campo === 'status') {
    const [[atual]] = await pool.query('SELECT status, nome FROM alunos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
    statusAnterior = atual?.status;
    nomeAluno = atual?.nome;
  }
  if (campo === 'turno') {
    const [[atual]] = await pool.query('SELECT turno FROM alunos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
    turnoAnterior = atual?.turno || null;
  }

  // Coluna DATE não aceita string vazia sob sql_mode estrito (NO_ZERO_DATE) —
  // precisa virar NULL de verdade pra "limpar" a data.
  const valorParaGravar = campo === 'inativado_em' && !valor ? null : valor;

  const sql = 'UPDATE alunos SET ?? = ? WHERE id = ? AND id_instituicao = ?';
  const [result] = await pool.query(sql, [campo, valorParaGravar, id, req.id_instituicao]);

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

  await logAuditEvent('ATUALIZAR_ALUNO', `Aluno ID: ${id}, Campo: ${campo}`, req.id_instituicao);

  if (campo === 'status' && valor === 'inativo' && statusAnterior && statusAnterior !== 'inativo') {
    await criarNotificacao({
      tipo: 'desistencia',
      titulo: 'Aluno marcado como desistente',
      mensagem: `${nomeAluno || 'Um aluno'} foi marcado(a) como inativo(a).`,
      id_instituicao: req.id_instituicao,
      id_aluno: Number(id),
      detalhes: [{
        aluno_id: Number(id),
        aluno_nome: nomeAluno || null,
        de: { status: statusAnterior },
        para: { status: 'inativo' }
      }]
    });
  }

  // Marca (ou limpa) a data de inativação junto da troca de status — feito à
  // parte do UPDATE principal porque esse só grava UM campo por vez. Só entra
  // aqui numa mudança de status de verdade (valor !== statusAnterior), pra não
  // resetar a data toda vez que a tela reenvia o mesmo status sem mudar nada.
  if (campo === 'status' && valor !== statusAnterior) {
    if (valor === 'inativo') {
      await pool.query('UPDATE alunos SET inativado_em = CURDATE() WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
    } else if (statusAnterior === 'inativo') {
      await pool.query('UPDATE alunos SET inativado_em = NULL WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
    }
  }

  let resultadoTurno = { encerradas: 0, turmas: [] };
  if (campo === 'turno' && (valor || null) !== turnoAnterior) {
    resultadoTurno = await encerrarMatriculasForaDoTurno(pool, id, valor, req.id_instituicao);
    if (resultadoTurno.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_TROCA_TURNO',
        `Aluno ID: ${id}, turno ${turnoAnterior || '(vazio)'} -> ${valor || '(vazio)'}, ${resultadoTurno.encerradas} matrícula(s) encerrada(s): ${resultadoTurno.turmas.join(', ')}`,
        req.id_instituicao
      );
    }
  }

  // Status virou algo diferente de "ativo" (ex.: "espera")? Matrícula só vale
  // pra aluno ativo — encerra tudo que ficou aberto (mesma regra da troca de
  // turno, ver encerrarMatriculasSeNaoAtivo em status-sync.js).
  let resultadoStatus = { encerradas: 0, turmas: [] };
  if (campo === 'status' && valor !== statusAnterior) {
    resultadoStatus = await encerrarMatriculasSeNaoAtivo(pool, id, valor, req.id_instituicao);
    if (resultadoStatus.encerradas > 0) {
      await logAuditEvent(
        'MATRICULAS_ENCERRADAS_STATUS',
        `Aluno ID: ${id}, status ${statusAnterior || '(vazio)'} -> ${valor}, ${resultadoStatus.encerradas} matrícula(s) encerrada(s): ${resultadoStatus.turmas.join(', ')}`,
        req.id_instituicao
      );
    }
  }

  res.json({
    message: 'Campo atualizado com sucesso.',
    matriculas_encerradas: resultadoTurno.encerradas + resultadoStatus.encerradas,
    turmas_encerradas: [...resultadoTurno.turmas, ...resultadoStatus.turmas]
  });
}));

// Excluir Aluno — soft-delete: marca excluido_em/excluido_por em vez de
// apagar a linha, e encerra (soft-delete também, mesmo padrão de
// status='cancelada'+data_fim usado no resto do sistema) as matrículas ATIVAS
// dele. Matrículas já encerradas antes da exclusão não são tocadas — já
// representam corretamente "isso não vale mais" e continuam no histórico.
// Um aluno excluído nunca mais aparece em nenhuma lista/busca (ver
// `AND excluido_em IS NULL` nas consultas de listagem) até ser restaurado —
// ver GET '/excluidos' e POST '/:id/restaurar' logo abaixo.
router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      'UPDATE alunos SET excluido_em = NOW(), excluido_por = ? WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
      [req.user.id, id, req.id_instituicao]
    );

    if (result.affectedRows === 0) throw new Error('Aluno não encontrado');

    await connection.query(
      `UPDATE matricula SET data_fim = CURDATE(), status = 'cancelada' WHERE idaluno = ? AND id_instituicao = ? AND data_fim IS NULL`,
      [id, req.id_instituicao]
    );

    await logAuditEvent('EXCLUIR_ALUNO', `Aluno ID: ${id} excluído (soft-delete) por usuário #${req.user.id}, matrículas ativas encerradas`, req.id_instituicao, connection);
    await connection.commit();
    res.json({ message: 'Aluno excluído com sucesso!' });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}));

// Excluir Aluno DE VEZ (hard delete) — diferente do soft-delete acima, essa
// realmente apaga a linha de `alunos`. As FKs com ON DELETE CASCADE (aluno_niveis,
// aluno_saude, aluno_situacao_anual, matricula, notificacoes, responsavel_legal,
// atos_carater, contatos_emergencia, presenca — e o que estiver embaixo delas,
// como matricula_dias e notificacoes_lidas) cuidam de apagar tudo relacionado
// automaticamente, sem precisar de nenhum outro DELETE manual aqui.
// Só permite apagar quem já está na lixeira (excluido_em IS NOT NULL) — força
// passar pelo soft-delete primeiro, pra nunca ser possível apagar pra sempre um
// aluno ainda ativo com um clique só.
router.delete('/:id/permanente', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [alunos] = await pool.query(
    'SELECT nome FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NOT NULL',
    [id, req.id_instituicao]
  );
  if (alunos.length === 0) {
    return res.status(404).json({ error: 'Aluno não encontrado na lixeira. Só é possível excluir definitivamente um aluno que já foi excluído antes.' });
  }
  const nomeAluno = alunos[0].nome;

  await pool.query('DELETE FROM alunos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);

  await logAuditEvent('ALUNO_EXCLUIDO_PERMANENTEMENTE', `Aluno ID: ${id}, Nome: ${nomeAluno}, excluído para sempre (com tudo relacionado) por usuário #${req.user.id}`, req.id_instituicao);

  res.json({ message: 'Aluno excluído permanentemente.' });
}));

// Lista alunos excluídos (soft-delete) da instituição — usado pela tela de
// Gerenciar Matrículas pra achar quem restaurar (esses alunos não aparecem em
// nenhuma outra busca/listagem do sistema, ver `excluido_em IS NULL` em GET
// '/' e no resto do backend).
router.get('/excluidos', asyncHandler(async (req, res) => {
  const [results] = await pool.query(
    `SELECT a.id, a.nome, a.excluido_em, u.nome AS excluido_por_nome,
            ${getNivelAtualSubquery()}
     FROM alunos a
     LEFT JOIN usuarios u ON u.id = a.excluido_por
     WHERE a.id_instituicao = ? AND a.excluido_em IS NOT NULL
     ORDER BY a.excluido_em DESC`,
    [req.id_instituicao]
  );
  res.json(results);
}));

// Restaura um aluno excluído: limpa excluido_em/excluido_por, volta a
// aparecer em todas as listas/buscas. NÃO recria as matrículas antigas (elas
// continuam encerradas no histórico) — o aluno precisa ser matriculado de
// novo nas turmas que for o caso, é uma decisão deliberada de quem restaura,
// não algo automático (a turma antiga pode nem existir mais, ter mudado de
// horário, etc.).
router.post('/:id/restaurar', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [result] = await pool.query(
    'UPDATE alunos SET excluido_em = NULL, excluido_por = NULL WHERE id = ? AND id_instituicao = ? AND excluido_em IS NOT NULL',
    [id, req.id_instituicao]
  );

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Aluno excluído não encontrado.' });

  await logAuditEvent('ALUNO_RESTAURADO', `Aluno ID: ${id} restaurado por usuário #${req.user.id}`, req.id_instituicao);

  res.json({ message: 'Aluno restaurado com sucesso!' });
}));

// Gera (ou regenera) o código de acesso de 6 dígitos do aluno — é o que ele
// usa pra entrar na tela dele (ver POST /api/auth/aluno-login). Gerar de novo
// invalida o código antigo na hora (é a mesma coluna sendo sobrescrita) — útil
// se o aluno esquecer ou perder o código anterior.
router.post('/:id/gerar-codigo', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [alunos] = await pool.query('SELECT id FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL', [id, req.id_instituicao]);
  if (alunos.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

  // Tenta gerar um código único (6 dígitos, com zero à esquerda) — a chance de
  // colisão é baixíssima (1 em 1 milhão), mas a coluna tem UNIQUE KEY como
  // garantia final; algumas tentativas cobrem o caso raro de bater com um já
  // existente.
  let codigo, salvou = false;
  for (let tentativa = 0; tentativa < 10 && !salvou; tentativa++) {
    codigo = String(Math.floor(100000 + Math.random() * 900000));
    try {
      const [result] = await pool.query('UPDATE alunos SET codigo_acesso = ? WHERE id = ?', [codigo, id]);
      salvou = result.affectedRows > 0;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  if (!salvou) return res.status(500).json({ error: 'Não foi possível gerar um código único. Tente novamente.' });

  await logAuditEvent('ALUNO_CODIGO_ACESSO_GERADO', `Aluno ID: ${id}, código gerado por usuário #${req.user.id}`, req.id_instituicao);

  res.json({ codigo_acesso: codigo });
}));

// Tipos de imagem aceitos pra foto de aluno — restrito de propósito (nunca
// aceita svg, por exemplo, que pode carregar script).
const TIPOS_FOTO_ACEITOS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TAMANHO_MAX_FOTO_BYTES = 3 * 1024 * 1024; // 3MB — a foto já chega comprimida do navegador (canvas), isso é só um teto de segurança.

// Foto do aluno (tirada pela câmera ou escolhida no dispositivo, já
// redimensionada/comprimida no navegador antes de chegar aqui — ver
// CadastrarAluno.js). Recebe como data URL (mesmo formato de
// canvas.toDataURL()) dentro de um JSON comum, sem multipart/form-data, pra
// seguir o mesmo padrão do resto da API. Guarda no bucket R2 (ver
// backend/storage.js) — nunca no MySQL — e salva só a URL pública em
// alunos.foto_url.
router.post('/:id/foto', exigir('editar'), asyncHandler(async (req, res) => {
  if (!storageConfigurado) {
    return res.status(503).json({ error: 'Armazenamento de fotos não configurado neste ambiente ainda.' });
  }

  const { id } = req.params;
  const [[aluno]] = await pool.query(
    'SELECT id, foto_url FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, req.id_instituicao]
  );
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });

  const dataUrl = String(req.body.imagem_base64 || '');
  const match = dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Envie a foto como data URL (data:image/...;base64,...).' });

  const [, contentType, base64] = match;
  const extensao = TIPOS_FOTO_ACEITOS[contentType];
  if (!extensao) return res.status(400).json({ error: 'Formato de imagem não aceito. Use JPEG, PNG ou WEBP.' });

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > TAMANHO_MAX_FOTO_BYTES) {
    return res.status(400).json({ error: 'Foto muito grande (máximo 3MB).' });
  }

  const key = `alunos/${req.id_instituicao}/${id}/${Date.now()}.${extensao}`;
  const url = await enviarFoto(key, buffer, contentType);

  await pool.query('UPDATE alunos SET foto_url = ? WHERE id = ?', [url, id]);
  if (aluno.foto_url) await removerFoto(aluno.foto_url);

  await logAuditEvent('ALUNO_FOTO_ATUALIZADA', `Aluno ID: ${id}`, req.id_instituicao);

  res.json({ foto_url: url });
}));

// Remove a foto (volta a mostrar o avatar padrão nas telas).
router.delete('/:id/foto', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[aluno]] = await pool.query(
    'SELECT id, foto_url FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, req.id_instituicao]
  );
  if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado.' });
  if (!aluno.foto_url) return res.json({ success: true });

  await pool.query('UPDATE alunos SET foto_url = NULL WHERE id = ?', [id]);
  await removerFoto(aluno.foto_url);

  await logAuditEvent('ALUNO_FOTO_REMOVIDA', `Aluno ID: ${id}`, req.id_instituicao);

  res.json({ success: true });
}));

// Busca um único aluno pelos campos diretos da tabela (mesma seleção de
// colunas do GET '/' acima) — usado pela tela de edição pra pré-preencher o
// formulário. Registrada depois de '/por-dia', '/meritocracia' e
// '/excluidos' de propósito: são rotas literais que '/:id' engoliria se
// viesse antes (Express casa por ordem de registro).
router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [results] = await pool.query(
    `SELECT id, nome, data_nascimento, data_cadastro, criado_em, sexo, telefone, turma, turno, transporte, status, Inf,
            acompanhamento, ponto, informacoes_gerais, escola_atual, foto_url
     FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL`,
    [id, req.id_instituicao]
  );
  if (results.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });
  res.json(results[0]);
}));

// Histórico de nível/subnível do aluno (ver Passo 5b do upsert-bulk, que é
// quem popula essa tabela hoje) — mais recente primeiro; o registro com
// data_fim NULL é o nível atual.
router.get('/:id/niveis', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query(
    'SELECT id, nivel, subnivel, data_inicio, data_fim FROM aluno_niveis WHERE id_aluno = ? AND id_instituicao = ? ORDER BY data_inicio DESC',
    [id, req.id_instituicao]
  );
  res.json(rows);
}));

// Histórico ano a ano de situação de matrícula/dívida (ver Passo 5c do
// upsert-bulk) — mais recente primeiro.
router.get('/:id/situacao-anual', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query(
    'SELECT id, ano, situacao_matricula, situacao_divida FROM aluno_situacao_anual WHERE id_aluno = ? AND id_instituicao = ? ORDER BY ano DESC',
    [id, req.id_instituicao]
  );
  res.json(rows);
}));

// Lista de observações de saúde do aluno (comorbidades, doenças, laudos —
// pode ter mais de uma, ver Passo 5d do upsert-bulk).
router.get('/:id/saude', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query(
    'SELECT id, descricao, created_at FROM aluno_saude WHERE id_aluno = ? AND id_instituicao = ? ORDER BY created_at DESC',
    [id, req.id_instituicao]
  );
  res.json(rows);
}));

// Remove uma observação de saúde específica (correção de um lançamento errado
// — o import em massa só adiciona, nunca apaga, então isso é o único jeito de
// tirar uma entrada indevida).
router.delete('/:alunoId/saude/:saudeId', exigir('editar'), asyncHandler(async (req, res) => {
  const { alunoId, saudeId } = req.params;
  const [result] = await pool.query(
    'DELETE FROM aluno_saude WHERE id = ? AND id_aluno = ? AND id_instituicao = ?',
    [saudeId, alunoId, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Observação de saúde não encontrada.' });
  await logAuditEvent('OBSERVACAO_SAUDE_REMOVIDA', `Aluno ID: ${alunoId}, observação #${saudeId} removida`, req.id_instituicao);
  res.json({ message: 'Observação removida com sucesso.' });
}));

// Responsável legal do aluno (ver Passo 5e do upsert-bulk) — um registro só
// por aluno; devolve null se ainda não foi preenchido.
router.get('/:id/responsavel', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query(
    'SELECT id, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone FROM responsavel_legal WHERE id_aluno = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  res.json(rows[0] || null);
}));

// Cria ou atualiza o responsável legal do aluno (edição manual — o import em
// massa faz a mesma coisa, ver Passo 5e). Upsert por id_aluno.
router.put('/:id/responsavel', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone } = req.body;

  const [alunoRows] = await pool.query('SELECT id FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL', [id, req.id_instituicao]);
  if (alunoRows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

  await pool.query(
    `INSERT INTO responsavel_legal (id_instituicao, id_aluno, nome, cpf, rg, data_nascimento, email, endereco, bairro, cep, telefone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       nome = VALUES(nome), cpf = VALUES(cpf), rg = VALUES(rg),
       data_nascimento = VALUES(data_nascimento), email = VALUES(email),
       endereco = VALUES(endereco), bairro = VALUES(bairro), cep = VALUES(cep),
       telefone = VALUES(telefone)`,
    [req.id_instituicao, id, nome || null, cpf || null, rg || null, data_nascimento || null, email || null, endereco || null, bairro || null, cep || null, telefone || null]
  );

  await logAuditEvent('RESPONSAVEL_LEGAL_ATUALIZADO', `Aluno ID: ${id}`, req.id_instituicao);
  res.json({ message: 'Responsável legal salvo com sucesso.' });
}));

module.exports = router;
