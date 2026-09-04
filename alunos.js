// CRUD de alunos + as duas rotas mais usadas do sistema no dia a dia:
// /por-dia (monta a lista de chamada de um dia específico) e /upsert-bulk
// (importação em massa a partir da planilha Excel da grade).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { validate } = require('./validation');
const { logAuditEvent } = require('./audit');
const { syncAlunoStatusFromMatriculas } = require('./status-sync');
const { criarNotificacao } = require('./notificacoes-service');

// Helper para envolver rotas assíncronas e capturar erros
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Helper para subquery de dias matriculados (evita duplicação de código).
// Retorna, por aluno, a lista de dias da semana em que ele tem matrícula ativa
// (ex.: "Segunda,Quarta"), usada nas telas que mostram o aluno junto com sua grade.
const getDiasMatriculadosSubquery = () => `
  IFNULL((SELECT GROUP_CONCAT(DISTINCT TRIM(m2.dia_semana) SEPARATOR ',')
   FROM matricula m2
   WHERE m2.idaluno = a.id AND m2.status = 'matriculado' AND m2.id_instituicao = a.id_instituicao), '') as dias_matriculados
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
    if (!isNaN(convertida.getTime())) {
      return convertida.toISOString().split('T')[0];
    }
  }

  return null;
};

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

// Listar Alunos com filtros dinâmicos.
// Regra especial: se `nome` for informado, os demais filtros (status/turno/transporte)
// são ignorados — a busca por nome funciona como uma busca "global" independente
// do status atual do aluno (útil para achar alunos inativos, por exemplo).
router.get('/', asyncHandler(async (req, res) => {
  const { nome, turno, transporte, status } = req.query;

  let sql = `
    SELECT a.id, a.nome, a.data_nascimento, a.data_cadastro, a.sexo, a.telefone,
           a.turma, a.turno, a.transporte, a.status, a.Inf,
           a.acompanhamento, a.ponto, a.informacoes_gerais, a.escola_atual,
           ${getDiasMatriculadosSubquery()}
    FROM alunos a
    WHERE a.id_instituicao = ? AND a.excluido_em IS NULL
  `;
  const params = [req.id_instituicao];

  if (nome && nome.trim() !== '') {
    sql += " AND a.nome LIKE ?";
    params.push(`%${nome.trim()}%`);
  } else {
    if (status) { sql += " AND a.status = ?"; params.push(status); }
    else { sql += " AND a.status = 'ativo'"; }

    if (turno && turno !== 'Todos') { sql += " AND TRIM(a.turno) = ?"; params.push(turno); }
    if (transporte && transporte !== 'Todos') { sql += " AND TRIM(a.transporte) = ?"; params.push(transporte); }
  }

  sql += " ORDER BY a.nome ASC";
  const [results] = await pool.query(sql, params);
  res.json(results);
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
  const { data, ignoreFilters, professor } = req.query; // Espera formato YYYY-MM-DD
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

  // `m.data_fim IS NULL` em todo lugar abaixo: uma matrícula com data_fim
  // preenchida está encerrada (soft-delete), independente de qual data seja —
  // não é um intervalo de vigência, é um "isso não vale mais" (mesmo padrão
  // usado em matriculas.js, presenca.js e relatorios.js).
  if (ignoreFilters === 'true') {
    // Modo Relatório: retorna TODOS os alunos ativos com status de presença para a data
    if (professor) {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        JOIN atividades atv ON m.idatividades = atv.idatividades
        JOIN professores prof ON atv.idprofessor = prof.id
        LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
        WHERE a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        AND TRIM(prof.nome) = ?
        AND a.id_instituicao = ?
        ORDER BY a.nome ASC
      `;
      params = [data, professor, req.id_instituicao];
    } else {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
        WHERE a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        AND a.id_instituicao = ?
        ORDER BY a.nome ASC
      `;
      params = [data, req.id_instituicao];
    }
  } else {
    // Modo Chamada: filtra apenas os alunos matriculados no dia da semana informado
    if (professor) {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        JOIN atividades atv ON m.idatividades = atv.idatividades
        JOIN professores prof ON atv.idprofessor = prof.id
        LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
        WHERE TRIM(m.dia_semana) = ?
        AND a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        AND TRIM(prof.nome) = ?
        AND a.id_instituicao = ?
        ORDER BY a.nome ASC
      `;
      params = [data, diaDaSemana, professor, req.id_instituicao];
    } else {
      sql = `
        SELECT DISTINCT a.id, a.nome, a.turno, a.transporte, a.turma, a.status, a.telefone,
               a.acompanhamento, a.ponto,
               ${getDiasMatriculadosSubquery()},
               p.status AS presenca_status, p.observacao AS presenca_obs
        FROM alunos a
        JOIN matricula m ON a.id = m.idaluno
        LEFT JOIN presenca p ON a.id = p.aluno_id AND DATE(p.data) = ? AND p.id_instituicao = a.id_instituicao
        WHERE TRIM(m.dia_semana) = ?
        AND a.status = 'ativo'
        AND TRIM(LOWER(m.status)) = 'matriculado'
        AND m.data_fim IS NULL
        AND a.id_instituicao = ?
        ORDER BY a.nome ASC
      `;
      params = [data, diaDaSemana, req.id_instituicao];
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


// Relatório Frequência Plena (Otimizado): total de presenças de cada aluno num
// período e as datas exatas em que compareceu — usado na tela de "assiduidade".
// Exclui dias marcados como sem aula do total (não deveriam ter presença mesmo,
// mas a checagem é defensiva).
router.get('/frequencia-plena', asyncHandler(async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ error: 'Datas início/fim obrigatórias.' });

  const sql = `
    SELECT a.id, a.nome, a.turno, a.turma, a.transporte,
           COUNT(DISTINCT p.data) as total_presencas,
           GROUP_CONCAT(DISTINCT DATE_FORMAT(p.data, '%d/%m') ORDER BY p.data ASC SEPARATOR ', ') as dias_presente
    FROM alunos a
    INNER JOIN presenca p ON a.id = p.aluno_id AND p.status = 'presente'
      AND p.data BETWEEN ? AND ? AND p.id_instituicao = ?
      AND NOT EXISTS (
        SELECT 1 FROM dias_sem_aula d
        WHERE d.data = DATE(p.data) AND d.id_instituicao = ?
      )
    WHERE a.id_instituicao = ?
    GROUP BY a.id, a.nome, a.turno, a.turma, a.transporte
    ORDER BY a.nome ASC
  `;
  const [results] = await pool.query(sql, [inicio, fim, req.id_instituicao, req.id_instituicao, req.id_instituicao]);
  res.json(results);
}));

// Importação em massa a partir do Excel da grade (aba de alunos + aba opcional de
// atividades). Todo o processamento roda numa única transação: se qualquer etapa
// falhar, nada é gravado. Passos:
//   1. Upsert dos alunos (por nome) — cria quem não existe, atualiza quem já existe.
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
//   6. Qualquer aluno ATIVO que não veio nesta planilha é marcado como INATIVO e
//      suas matrículas são encerradas — a planilha é tratada como a fonte da
//      verdade de "quem está matriculado agora". Um import parcial (faltando
//      alguém que ainda está na escola) vai inativar essa pessoa por engano.
router.post('/upsert-bulk', asyncHandler(async (req, res) => {
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

    const today = new Date().toISOString().split('T')[0];

    // Passo 1: upsert dos alunos. Aceita nome vindo de diferentes cabeçalhos de
    // planilha (nome/ALUNO/Aluno) porque a planilha já mudou de formato antes.
    const values = alunos.map(a => [
      String(a.nome || a.ALUNO || a.Aluno).trim(),
      parseDataNascimento(a.data_nascimento),
      parseDataNascimento(a.data_cadastro) || today,
      a.sexo || null,
      a.telefone || null,
      String(a.turma || '').trim() || null,
      a.turno || null,
      a.transporte || null,
      // O front sempre baixa o cabeçalho da planilha pra minúsculo antes de
      // enviar (ver processImportedData em GerenciarMatriculas.js) — `a.Inf`
      // com I maiúsculo nunca batia com nada e a coluna nunca era importada.
      a.inf || null,
      a.acompanhamento || null,
      a.ponto || null,
      a.informacoes_gerais || null,
      a.escola_atual || null,
      'ativo',
      req.id_instituicao
    ]);

    // `data_cadastro` fica de fora do ON DUPLICATE KEY UPDATE de propósito: é a
    // data do PRIMEIRO cadastro do aluno na instituição — uma vez gravada, uma
    // reimportação da planilha (mesmo sem essa coluna preenchida) nunca deve
    // sobrescrever esse valor histórico. `informacoes_gerais` e `escola_atual`
    // são o oposto por pedido explícito: sobrescritos a cada reimportação, sem
    // guardar histórico (se o aluno mudar de escola, só troca o valor).
    const sql = `
      INSERT INTO alunos (nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, acompanhamento, ponto, informacoes_gerais, escola_atual, status, id_instituicao)
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
      `SELECT id, nome, turno FROM alunos WHERE nome IN (?) AND id_instituicao = ? AND excluido_em IS NULL`,
      [studentNames, req.id_instituicao]
    );
    const studentIdMap = new Map(existingStudents.map(s => [s.nome, { id: s.id, turno: s.turno }]));

    // Passo 3: varre as colunas de cada linha do Excel procurando o padrão de
    // matrícula (dia + horário, ex.: "SEG HR 1", "Segunda-HR2") e monta a lista de
    // matrículas a upsertar, junto com o conjunto de atividades/professores citados.
    // Desde a migração que separou `atividades` por horário (ver
    // migrate-split-atividades-por-horario.js), uma "turma" real é o par
    // nome+dia_semana+horario+turno — o mesmo nome pode ter várias linhas em
    // `atividades`, uma por horário. `slotsToFindOrCreate` guarda essa chave
    // completa; `atividadeNomes` guarda só os nomes (usado para achar as
    // linhas já existentes e sincronizar o professor declarado na planilha).
    const matriculasToUpsert = [];
    const atividadeNomes = new Set();
    const slotsToFindOrCreate = new Map(); // slotKey "nome|dia|horario|turno" -> { nome, dia_semana, horario, turno }
    const excelActivityProfMap = new Map(); // Mapa de atividade -> professor

    // Processa a aba de atividades enviada do Excel (só declara o professor de
    // cada nome de atividade — não cria linha em `atividades` sozinha, porque
    // sem dia/horário/turno não há uma turma específica pra criar).
    for (const atv of atividadesExcel) {
      const atvNomeBruto = String(atv.atividade || atv.nome || atv.atividades || '').trim();
      const atvNome = atvNomeBruto ? normalizarNomeAtividade(atvNomeBruto) : '';
      const profNome = String(atv.professor || atv.professores || atv.prof || '').trim();
      if (atvNome) {
        atividadeNomes.add(atvNome);
        if (profNome) {
          excelActivityProfMap.set(atvNome, profNome);
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
        `SELECT idatividades, nome, idprofessor, dia_semana, horario, turno FROM atividades WHERE nome IN (?) AND id_instituicao = ?`,
        [Array.from(atividadeNomes), req.id_instituicao]
      );
      existingActivities.forEach(act => {
        if (act.dia_semana && act.horario && act.turno) {
          activityIdMap.set(`${act.nome}|${act.dia_semana}|${act.horario}|${act.turno}`, act.idatividades);
        }
      });

      // Cria as turmas (slots) que a planilha pede e que ainda não existem,
      // vinculando ao professor da planilha (ou ao Professor Padrão, se não informado).
      const slotsToCreate = Array.from(slotsToFindOrCreate.entries()).filter(
        ([slotKey]) => !activityIdMap.has(slotKey)
      );

      if (slotsToCreate.length > 0) {
        const newActivitiesValues = slotsToCreate.map(([, slot]) => {
          const profNome = excelActivityProfMap.get(slot.nome);
          const idprof = profNome ? profIdMap.get(profNome) : defaultProfessorId;
          return [slot.nome, idprof, req.id_instituicao, slot.dia_semana, slot.horario, slot.turno];
        });
        const [insertResult] = await connection.query(
          `INSERT INTO atividades (nome, idprofessor, id_instituicao, dia_semana, horario, turno) VALUES ?`,
          [newActivitiesValues]
        );
        // Insert em lote numa única conexão: o MySQL garante ids contíguos a
        // partir de insertId, na mesma ordem dos VALUES — evita reconsultar.
        const primeiroId = insertResult.insertId;
        slotsToCreate.forEach(([slotKey], idx) => {
          activityIdMap.set(slotKey, primeiroId + idx);
        });
      }

      // 4.3 Se uma turma já existia mas a planilha trouxe um professor diferente
      // do cadastrado, atualiza o vínculo em todas as linhas daquele nome (bulk
      // update via CASE WHEN em vez de um UPDATE por linha, para não fazer N idas ao banco).
      const activitiesToUpdate = [];
      for (const existingAct of existingActivities) {
        const profNomeFromExcel = excelActivityProfMap.get(existingAct.nome);
        if (profNomeFromExcel) {
          const mappedProfId = profIdMap.get(profNomeFromExcel);
          if (mappedProfId && existingAct.idprofessor !== mappedProfId) {
            activitiesToUpdate.push([mappedProfId, existingAct.idatividades, req.id_instituicao]);
          }
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
    }

    // Passo 5: compara com as matrículas atuais (por aluno+turno+horario+dia_semana,
    // a "posição" na grade) para decidir upsert vs. encerrar-e-recriar.
    const studentIds = [...new Set(matriculasToUpsert.map(m => m.idaluno))];
    // `idaluno IN ()` é SQL inválido — acontece quando nenhuma linha da
    // planilha trouxe coluna de matrícula (ex.: upload só pra atualizar
    // cadastro/nível, sem mexer em turma).
    const [currentMatriculas] = studentIds.length > 0
      ? await connection.query(
          `SELECT idmatricula, idaluno, idatividades, turno, horario, dia_semana
           FROM matricula
           WHERE idaluno IN (?) AND id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL`,
          [studentIds, req.id_instituicao]
        )
      : [[]];

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
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno) continue;

      const nivelRaw = alunoRaw.nivel;
      if (nivelRaw === undefined || nivelRaw === null || String(nivelRaw).trim() === '') continue;
      const nivel = parseInt(nivelRaw);
      if (isNaN(nivel)) continue;
      const subnivel = alunoRaw.subnivel ? String(alunoRaw.subnivel).trim() : null;

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
    const anoAtual = new Date().getFullYear();
    const situacoesFromExcel = [];
    for (const alunoRaw of alunos) {
      const alunoNome = String(alunoRaw.nome || alunoRaw.ALUNO || alunoRaw.Aluno).trim();
      const idaluno = studentIdMap.get(alunoNome)?.id;
      if (!idaluno) continue;

      const situacaoMatricula = alunoRaw.situacao_matricula_ano ? String(alunoRaw.situacao_matricula_ano).trim() : null;
      const situacaoDivida = alunoRaw.situacao_divida_ano ? String(alunoRaw.situacao_divida_ano).trim() : null;
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
        .map(s => s.trim())
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
        nome: alunoRaw.responsavel_nome ? String(alunoRaw.responsavel_nome).trim() : null,
        cpf: alunoRaw.responsavel_cpf ? String(alunoRaw.responsavel_cpf).trim() : null,
        rg: alunoRaw.responsavel_rg ? String(alunoRaw.responsavel_rg).trim() : null,
        data_nascimento: parseDataNascimento(alunoRaw.responsavel_data_nascimento),
        email: alunoRaw.responsavel_email ? String(alunoRaw.responsavel_email).trim() : null,
        endereco: alunoRaw.responsavel_endereco ? String(alunoRaw.responsavel_endereco).trim() : null,
        bairro: alunoRaw.responsavel_bairro ? String(alunoRaw.responsavel_bairro).trim() : null,
        cep: alunoRaw.responsavel_cep ? String(alunoRaw.responsavel_cep).trim() : null,
        telefone: alunoRaw.responsavel_telefone ? String(alunoRaw.responsavel_telefone).trim() : null
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

    // Passo 6: quem estava ativo mas não veio nesta planilha vira inativo, e suas
    // matrículas correntes são encerradas — a planilha é a fonte da verdade de
    // "quem está matriculado agora".
    let activeStudentsNotInImport = [];
    if (studentNames.length > 0) {
      const placeholders = studentNames.map(() => '?').join(',');
      const [result] = await connection.query(
        `SELECT id FROM alunos WHERE id_instituicao = ? AND status = 'ativo' AND excluido_em IS NULL AND nome NOT IN (${placeholders})`,
        [req.id_instituicao, ...studentNames]
      );
      activeStudentsNotInImport = result;
    }

    const studentsToInactivate = activeStudentsNotInImport.map(s => s.id);
    let inactivatedCount = 0;

    if (studentsToInactivate.length > 0) {
      const idPlaceholders = studentsToInactivate.map(() => '?').join(',');
      const [updateResult] = await connection.query(
        `UPDATE alunos SET status = 'inativo' WHERE id IN (${idPlaceholders}) AND id_instituicao = ?`,
        [...studentsToInactivate, req.id_instituicao]
      );
      inactivatedCount = updateResult.affectedRows;

      await connection.query(
        `UPDATE matricula SET data_fim = ?, status = 'cancelada' WHERE idaluno IN (${idPlaceholders}) AND id_instituicao = ? AND data_fim IS NULL`,
        [today, ...studentsToInactivate, req.id_instituicao]
      );
    }

    // Garante que alunos.status reflita a matrícula real de todo mundo que foi
    // tocado nesta importação (não só os inativados acima).
    const idsParaSincronizar = [...new Set(existingStudents.map(s => s.id))];
    await syncAlunoStatusFromMatriculas(connection, idsParaSincronizar, req.id_instituicao);

    await connection.commit();

    res.json({
      message: 'Processamento concluído',
      resumo: {
        total_recebido: alunos.length,
        alunos_afetados: alunosUpsertResult.affectedRows,
        matriculas_afetadas: matriculasAffected,
        niveis_afetados: niveisAfetados,
        situacoes_anuais_afetadas: situacoesAfetadas,
        observacoes_saude_adicionadas: saudeAfetada,
        responsaveis_afetados: responsaveisAfetados,
        alunos_inativados: inactivatedCount
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

// Criar Aluno com Validação
router.post('/', validate('aluno'), asyncHandler(async (req, res) => {
  const { nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, status, acompanhamento, ponto, informacoes_gerais, escola_atual } = req.body;
  const sql = `
    INSERT INTO alunos (nome, data_nascimento, data_cadastro, sexo, telefone, turma, turno, transporte, Inf, acompanhamento, ponto, informacoes_gerais, escola_atual, status, id_instituicao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const [result] = await pool.query(sql, [
    nome, data_nascimento || null, data_cadastro || new Date().toISOString().split('T')[0], sexo || null, telefone || null,
    turma || null, turno || null, transporte || null, Inf || null,
    acompanhamento || null, ponto || null, informacoes_gerais || null, escola_atual || null,
    status || 'ativo', req.id_instituicao
  ]);

  await logAuditEvent('CRIAR_ALUNO', `Aluno ID: ${result.insertId}, Nome: ${nome}`, req.id_instituicao);
  res.status(201).json({ id: result.insertId, message: 'Aluno criado com sucesso!' });
}));

// Atualização parcial via PATCH: só permite alterar um campo por vez, e apenas os
// campos na whitelist (evita que o cliente altere colunas sensíveis como id_instituicao).
router.patch('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { campo, valor } = req.body;
  const colunasPermitidas = ['data_nascimento', 'data_cadastro', 'sexo', 'telefone', 'turma', 'turno', 'transporte', 'Inf', 'acompanhamento', 'ponto', 'informacoes_gerais', 'escola_atual', 'status'];

  if (!colunasPermitidas.includes(campo)) {
    return res.status(400).json({ error: 'Campo não permitido para atualização.' });
  }

  // Pra "desistência" (ver notificação abaixo), precisa saber o status ANTES
  // de trocar — só é um evento novo se ele não já estava inativo.
  let statusAnterior = null;
  let nomeAluno = null;
  if (campo === 'status' && valor === 'inativo') {
    const [[atual]] = await pool.query('SELECT status, nome FROM alunos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
    statusAnterior = atual?.status;
    nomeAluno = atual?.nome;
  }

  const sql = 'UPDATE alunos SET ?? = ? WHERE id = ? AND id_instituicao = ?';
  const [result] = await pool.query(sql, [campo, valor, id, req.id_instituicao]);

  if (result.affectedRows === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

  await logAuditEvent('ATUALIZAR_ALUNO', `Aluno ID: ${id}, Campo: ${campo}`, req.id_instituicao);

  if (campo === 'status' && valor === 'inativo' && statusAnterior && statusAnterior !== 'inativo') {
    await criarNotificacao({
      tipo: 'desistencia',
      titulo: 'Aluno marcado como desistente',
      mensagem: `${nomeAluno || 'Um aluno'} foi marcado(a) como inativo(a).`,
      id_instituicao: req.id_instituicao,
      id_aluno: Number(id)
    });
  }

  res.json({ message: 'Campo atualizado com sucesso.' });
}));

// Excluir Aluno — soft-delete: marca excluido_em/excluido_por em vez de
// apagar a linha, e encerra (soft-delete também, mesmo padrão de
// status='cancelada'+data_fim usado no resto do sistema) as matrículas ATIVAS
// dele. Matrículas já encerradas antes da exclusão não são tocadas — já
// representam corretamente "isso não vale mais" e continuam no histórico.
// Um aluno excluído nunca mais aparece em nenhuma lista/busca (ver
// `AND excluido_em IS NULL` nas consultas de listagem) até ser restaurado —
// ver GET '/excluidos' e POST '/:id/restaurar' logo abaixo.
router.delete('/:id', asyncHandler(async (req, res) => {
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

// Lista alunos excluídos (soft-delete) da instituição — usado pela tela de
// Gerenciar Matrículas pra achar quem restaurar (esses alunos não aparecem em
// nenhuma outra busca/listagem do sistema, ver `excluido_em IS NULL` em GET
// '/' e no resto do backend).
router.get('/excluidos', asyncHandler(async (req, res) => {
  const [results] = await pool.query(
    `SELECT a.id, a.nome, a.excluido_em, u.nome AS excluido_por_nome
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
router.post('/:id/restaurar', asyncHandler(async (req, res) => {
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
router.post('/:id/gerar-codigo', asyncHandler(async (req, res) => {
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
router.delete('/:alunoId/saude/:saudeId', asyncHandler(async (req, res) => {
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
router.put('/:id/responsavel', asyncHandler(async (req, res) => {
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
