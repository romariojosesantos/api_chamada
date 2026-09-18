// Tela "Comparativo" (master/coordenador) — compara dados gerais entre TODAS
// as instituições que o usuário logado tem acesso, não só a que está
// selecionada no momento. Por isso este router é montado em _server.js ANTES
// do middleware de x-institution-id (mesmo motivo/posição de historico-aluno.js
// e permissoes.js): a rota não trabalha "dentro" de uma instituição, ela
// enxerga várias de uma vez.
//
// Acesso: master vê todas as instituições cadastradas; coordenador só as que
// estão vinculadas a ele (usuario_instituicoes, já embutido no token como
// req.user.instituicoes — ver loadUserInstitutions em auth.js). Qualquer outro
// perfil recebe 403 — tela não aparece no menu pra eles (ver perfis={['master',
// 'coordenador']} em App.js/Layout.jsx), isso aqui é o cinto de segurança do
// backend caso alguém tente acessar a rota direto.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { calcularFrequenciaPorAluno } = require('./relatorios');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Mesmo mapeamento turno -> período usado em relatorios.js (CONDICAO_PERIODO_SQL)
// pra decidir "manhã/tarde/noite" a partir do texto livre de `matricula.turno`.
// Duplicado aqui de propósito (é só uma CASE de 5 linhas) — não vale acoplar
// os dois arquivos por isso.
const PERIODO_DA_MATRICULA_SQL = `CASE
  WHEN LOWER(m.turno) LIKE '%manh%' THEN 'manha'
  WHEN LOWER(m.turno) LIKE '%tard%' THEN 'tarde'
  WHEN LOWER(m.turno) LIKE '%noit%' THEN 'noite'
  ELSE 'outro'
END`;

router.get('/', asyncHandler(async (req, res) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Tela restrita a master/coordenador.' });
  }

  const souMaster = req.user.perfil === 'master';
  const idsVinculados = Array.isArray(req.user.instituicoes) ? req.user.instituicoes.map(Number) : [];
  if (!souMaster && idsVinculados.length === 0) {
    return res.json({ instituicoes: [] });
  }

  const [instituicoes] = souMaster
    ? await pool.query('SELECT id, nome FROM instituicoes ORDER BY nome ASC')
    : await pool.query('SELECT id, nome FROM instituicoes WHERE id IN (?) ORDER BY nome ASC', [idsVinculados]);
  if (instituicoes.length === 0) return res.json({ instituicoes: [] });

  const ids = instituicoes.map(i => i.id);

  const [
    [alunosAtivosRows],
    [filaEsperaRows],
    [professoresAtivosRows],
    [turmasAtivasRows],
    [porTurnoRows],
    [porAreaRows],
    [porNivelSexoRows],
    [ocupacaoRows],
    [capacidadeRows],
    [professoresDetalheRows],
  ] = await Promise.all([
    pool.query(
      `SELECT id_instituicao, COUNT(*) AS total FROM alunos
       WHERE id_instituicao IN (?) AND status = 'ativo' AND excluido_em IS NULL
       GROUP BY id_instituicao`,
      [ids]
    ),
    // "espera" = aluno na fila esperando vaga, sem matrícula ainda (ver
    // status-sync.js) — status próprio, não é sinônimo de "inativo".
    pool.query(
      `SELECT id_instituicao, COUNT(*) AS total FROM alunos
       WHERE id_instituicao IN (?) AND status = 'espera' AND excluido_em IS NULL
       GROUP BY id_instituicao`,
      [ids]
    ),
    pool.query(
      `SELECT id_instituicao, COUNT(*) AS total FROM professores
       WHERE id_instituicao IN (?) AND ativo = 1
       GROUP BY id_instituicao`,
      [ids]
    ),
    pool.query(
      `SELECT id_instituicao, COUNT(*) AS total FROM atividades
       WHERE id_instituicao IN (?) AND data_fim IS NULL
       GROUP BY id_instituicao`,
      [ids]
    ),
    // Conta MATRÍCULA (uma turma), não aluno único — mesmo espírito de
    // matriculas-por-area em relatorios.js: um aluno com matrícula de manhã E
    // à noite entra nos dois grupos, de propósito (é "matrículas por turno").
    pool.query(
      `SELECT m.id_instituicao, ${PERIODO_DA_MATRICULA_SQL} AS periodo, COUNT(*) AS total
       FROM matricula m
       WHERE m.id_instituicao IN (?) AND m.status = 'matriculado' AND m.data_fim IS NULL
       GROUP BY m.id_instituicao, periodo`,
      [ids]
    ),
    pool.query(
      `SELECT m.id_instituicao, COALESCE(atv.area, 'sem_area') AS area, COUNT(*) AS total
       FROM matricula m
       JOIN atividades atv ON atv.idatividades = m.idatividades
       WHERE m.id_instituicao IN (?) AND m.status = 'matriculado' AND m.data_fim IS NULL
       GROUP BY m.id_instituicao, area`,
      [ids]
    ),
    // Nível atual de cada aluno (mesma subquery de getNivelAtualSubquery em
    // alunos.js: o registro em aluno_niveis com data_fim IS NULL, o mais
    // recente por data_inicio) cruzado com sexo ('M'/'F'/vazio). Envolvido
    // numa subquery derivada (1 linha por aluno) em vez de um LEFT JOIN direto
    // por segurança — se um dia existir mais de um registro em aberto por
    // engano em aluno_niveis, um JOIN duplicaria o aluno na contagem.
    pool.query(
      `SELECT id_instituicao,
         nivel,
         COALESCE(NULLIF(TRIM(sexo), ''), '?') AS sexo,
         COUNT(*) AS total
       FROM (
         SELECT a.id_instituicao, a.sexo,
           (SELECT an.nivel FROM aluno_niveis an
            WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL
            ORDER BY an.data_inicio DESC LIMIT 1) AS nivel
         FROM alunos a
         WHERE a.id_instituicao IN (?) AND a.status = 'ativo' AND a.excluido_em IS NULL
       ) t
       GROUP BY id_instituicao, nivel, sexo`,
      [ids]
    ),
    // Ocupação atual por nível+turno: quantos alunos ATIVOS, com nível
    // cadastrado, têm matrícula ativa naquele turno — pra comparar com a
    // capacidade fixa (capacidade_niveis) e mostrar % de ocupação. DISTINCT
    // aluno (não matrícula): um aluno com 2 turmas no mesmo turno/nível conta
    // 1 vez só, é "quantas vagas ele ocupa" nesse turno, não "quantas turmas".
    pool.query(
      `SELECT id_instituicao, nivel, periodo, COUNT(DISTINCT id) AS atual
       FROM (
         SELECT DISTINCT a.id, a.id_instituicao,
           (SELECT an.nivel FROM aluno_niveis an
            WHERE an.id_aluno = a.id AND an.id_instituicao = a.id_instituicao AND an.data_fim IS NULL
            ORDER BY an.data_inicio DESC LIMIT 1) AS nivel,
           ${PERIODO_DA_MATRICULA_SQL} AS periodo
         FROM alunos a
         JOIN matricula m ON m.idaluno = a.id AND m.id_instituicao = a.id_instituicao
           AND m.status = 'matriculado' AND m.data_fim IS NULL
         WHERE a.id_instituicao IN (?) AND a.status = 'ativo' AND a.excluido_em IS NULL
       ) t
       WHERE nivel IS NOT NULL
       GROUP BY id_instituicao, nivel, periodo`,
      [ids]
    ),
    pool.query(
      `SELECT id_instituicao, nivel, turno, capacidade FROM capacidade_niveis WHERE id_instituicao IN (?)`,
      [ids]
    ),
    // Mesmo cálculo de "quantos alunos matriculados" de GET /api/professores-admin
    // (professores.js), só que pra várias instituições de uma vez em vez de uma só.
    pool.query(
      `SELECT p.id_instituicao, p.id, p.nome,
         (SELECT COUNT(DISTINCT mm.idaluno)
          FROM matricula mm
          JOIN atividades av ON av.idatividades = mm.idatividades
          WHERE mm.id_instituicao = p.id_instituicao AND mm.status = 'matriculado' AND mm.data_fim IS NULL
            AND (av.idprofessor = p.id OR EXISTS (
              SELECT 1 FROM atividade_professores ap WHERE ap.idatividades = av.idatividades AND ap.idprofessor = p.id
            ))
         ) AS total_alunos
       FROM professores p
       WHERE p.id_instituicao IN (?) AND p.ativo = 1
       ORDER BY p.nome ASC`,
      [ids]
    ),
  ]);

  // Frequência média do mês corrente (dia 1 até hoje), por instituição —
  // reaproveita calcularFrequenciaPorAluno (mesma função usada em Notas e no
  // dashboard de relatórios), fazendo a média simples sobre os alunos ativos.
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const primeiroDiaMes = `${hoje.slice(0, 7)}-01`;
  const frequencias = await Promise.all(
    ids.map(id => calcularFrequenciaPorAluno(id, primeiroDiaMes, hoje))
  );
  const frequenciaMediaPorInst = new Map(
    ids.map((id, i) => {
      const freq = frequencias[i];
      const media = freq.length > 0
        ? Math.round(freq.reduce((s, f) => s + f.frequencia_pct, 0) / freq.length)
        : 0;
      return [id, media];
    })
  );

  const mapaSimples = (rows) => new Map(rows.map(r => [r.id_instituicao, r.total]));
  const alunosAtivosMap = mapaSimples(alunosAtivosRows);
  const filaEsperaMap = mapaSimples(filaEsperaRows);
  const professoresAtivosMap = mapaSimples(professoresAtivosRows);
  const turmasAtivasMap = mapaSimples(turmasAtivasRows);

  const porTurnoMap = new Map(ids.map(id => [id, { manha: 0, tarde: 0, noite: 0, outro: 0 }]));
  porTurnoRows.forEach(r => { porTurnoMap.get(r.id_instituicao)[r.periodo] = r.total; });

  const porAreaMap = new Map(ids.map(id => [id, {}]));
  porAreaRows.forEach(r => { porAreaMap.get(r.id_instituicao)[r.area] = r.total; });

  // por_nivel: { "1": { total, M, F, outro }, ..., "sem_nivel": {...} } —
  // nivel NULL (aluno sem nível cadastrado em aluno_niveis) vira a chave
  // "sem_nivel"; sexo "?" (NULL/vazio em `alunos.sexo`) é "não informado".
  const porNivelMap = new Map(ids.map(id => [id, {}]));
  porNivelSexoRows.forEach(r => {
    const chave = r.nivel === null ? 'sem_nivel' : String(r.nivel);
    const bucket = porNivelMap.get(r.id_instituicao);
    if (!bucket[chave]) bucket[chave] = { total: 0, M: 0, F: 0, outro: 0 };
    const campoSexo = r.sexo === 'M' || r.sexo === 'F' ? r.sexo : 'outro';
    bucket[chave][campoSexo] += r.total;
    bucket[chave].total += r.total;
  });

  // capacidade: { "1": { manha: { capacidade, atual }, tarde: {...}, noite: {...} }, ... }
  // — uma entrada por (nível, turno) que tenha capacidade cadastrada OU
  // alunos ocupando (pra não sumir um turno com gente mas sem capacidade
  // ainda configurada). `capacidade` vem 0 até o master/coordenador digitar
  // um valor pela tela.
  const capacidadeMap = new Map(ids.map(id => [id, {}]));
  const garanteCelula = (idInst, nivel, turno) => {
    const bucket = capacidadeMap.get(idInst);
    if (!bucket[nivel]) bucket[nivel] = {};
    if (!bucket[nivel][turno]) bucket[nivel][turno] = { capacidade: 0, atual: 0 };
    return bucket[nivel][turno];
  };
  ocupacaoRows.forEach(r => {
    garanteCelula(r.id_instituicao, String(r.nivel), r.periodo).atual = r.atual;
  });
  capacidadeRows.forEach(r => {
    garanteCelula(r.id_instituicao, String(r.nivel), r.turno).capacidade = r.capacidade;
  });

  const professoresPorInst = new Map(ids.map(id => [id, []]));
  professoresDetalheRows.forEach(r => {
    professoresPorInst.get(r.id_instituicao).push({ id: r.id, nome: r.nome, total_alunos: r.total_alunos });
  });

  const resultado = instituicoes.map(inst => ({
    id: inst.id,
    nome: inst.nome,
    total_alunos_ativos: alunosAtivosMap.get(inst.id) || 0,
    total_fila_espera: filaEsperaMap.get(inst.id) || 0,
    total_professores_ativos: professoresAtivosMap.get(inst.id) || 0,
    total_turmas_ativas: turmasAtivasMap.get(inst.id) || 0,
    frequencia_media_mes: frequenciaMediaPorInst.get(inst.id) || 0,
    por_turno: porTurnoMap.get(inst.id),
    por_area: porAreaMap.get(inst.id),
    por_nivel: porNivelMap.get(inst.id),
    capacidade: capacidadeMap.get(inst.id),
    professores: professoresPorInst.get(inst.id),
  }));

  res.json({ instituicoes: resultado, gerado_em: hoje, periodo_frequencia: { inicio: primeiroDiaMes, fim: hoje } });
}));

// Grava (upsert) a capacidade fixa de UMA célula (instituição+nível+turno) —
// a tela edita célula a célula, salvando ao sair do campo, então um PUT por
// célula em vez de um lote só (diferente de POST /api/notas, que salva várias
// notas de uma vez porque lá o usuário edita várias antes de clicar Salvar).
const TURNOS_CAPACIDADE = ['manha', 'tarde', 'noite'];
router.put('/capacidade', asyncHandler(async (req, res) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Tela restrita a master/coordenador.' });
  }
  const { id_instituicao, nivel, turno, capacidade } = req.body;
  const idInst = Number(id_instituicao);
  const nivelNum = Number(nivel);
  const capacidadeNum = Number(capacidade);

  if (req.user.perfil !== 'master') {
    const idsVinculados = Array.isArray(req.user.instituicoes) ? req.user.instituicoes.map(Number) : [];
    if (!idsVinculados.includes(idInst)) {
      return res.status(403).json({ error: 'Você não tem acesso a essa instituição.' });
    }
  }
  if (!Number.isInteger(nivelNum) || nivelNum < 1 || nivelNum > 4) {
    return res.status(400).json({ error: 'Nível inválido (deve ser 1 a 4).' });
  }
  if (!TURNOS_CAPACIDADE.includes(turno)) {
    return res.status(400).json({ error: 'Turno inválido.' });
  }
  if (!Number.isInteger(capacidadeNum) || capacidadeNum < 0) {
    return res.status(400).json({ error: 'Capacidade deve ser um número inteiro maior ou igual a 0.' });
  }

  await pool.query(
    `INSERT INTO capacidade_niveis (id_instituicao, nivel, turno, capacidade)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE capacidade = VALUES(capacidade)`,
    [idInst, nivelNum, turno, capacidadeNum]
  );
  res.json({ id_instituicao: idInst, nivel: nivelNum, turno, capacidade: capacidadeNum });
}));

module.exports = router;
