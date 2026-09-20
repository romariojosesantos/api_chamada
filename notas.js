// Lançamento de notas por período avaliativo (bimestre/trimestre) E por
// CATEGORIA pedagógica (Educacional/Esporte/Cultura-Teoria/Cultura-Prática/
// Dança — ver categorias-avaliativas.js), não por turma exata: um aluno com
// duas turmas de instrumento tem uma nota SÓ de "Cultura/Prática", não duas.
// Qualquer professor que dá aula pro aluno naquela categoria pode lançar/
// editar essa nota (sem exclusividade — dois professores de instrumentos
// diferentes do mesmo aluno podem ambos editar a nota de Cultura/Prática).
//
// Média do período = (soma das notas das categorias em que o aluno participa
// + % de frequência) ÷ (quantidade dessas categorias + 1) — só quando TODAS
// as categorias que o aluno participa (não só as que o professor logado vê)
// já têm nota lançada.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { calcularFrequenciaPorAluno } = require('./relatorios');
const { CATEGORIAS_VALIDAS, CATEGORIA_LABEL, categoriaDaTurma } = require('./categorias-avaliativas');
const { exigirRecurso } = require('./permissoes-middleware');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const exigir = (recurso) => exigirRecurso('/notas', recurso);

// Listar períodos avaliativos da instituição (qualquer perfil com acesso à
// tela pode ver a lista, pra escolher qual lançar nota — só master/coordenador
// podem criar/editar/excluir, ver rotas abaixo).
router.get('/periodos', asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, nome, data_inicio, data_fim FROM periodos_avaliativos WHERE id_instituicao = ? ORDER BY data_inicio DESC',
    [req.id_instituicao]
  );
  res.json(rows);
}));

router.post('/periodos', exigir('criar'), asyncHandler(async (req, res) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Só master/coordenador podem criar períodos avaliativos.' });
  }
  const { nome, data_inicio, data_fim } = req.body;
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'Nome do período é obrigatório.' });
  if (!data_inicio || !data_fim) return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórias.' });
  if (data_inicio > data_fim) return res.status(400).json({ error: 'data_inicio deve ser antes ou igual a data_fim.' });

  const [result] = await pool.query(
    'INSERT INTO periodos_avaliativos (id_instituicao, nome, data_inicio, data_fim) VALUES (?, ?, ?, ?)',
    [req.id_instituicao, String(nome).trim(), data_inicio, data_fim]
  );
  res.status(201).json({ id: result.insertId, nome: String(nome).trim(), data_inicio, data_fim });
}));

router.put('/periodos/:id', exigir('editar'), asyncHandler(async (req, res) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Só master/coordenador podem editar períodos avaliativos.' });
  }
  const { id } = req.params;
  const { nome, data_inicio, data_fim } = req.body;
  if (!nome || !String(nome).trim()) return res.status(400).json({ error: 'Nome do período é obrigatório.' });
  if (!data_inicio || !data_fim) return res.status(400).json({ error: 'data_inicio e data_fim são obrigatórias.' });
  if (data_inicio > data_fim) return res.status(400).json({ error: 'data_inicio deve ser antes ou igual a data_fim.' });

  const [result] = await pool.query(
    'UPDATE periodos_avaliativos SET nome = ?, data_inicio = ?, data_fim = ? WHERE id = ? AND id_instituicao = ?',
    [String(nome).trim(), data_inicio, data_fim, id, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Período não encontrado.' });
  res.json({ message: 'Período atualizado com sucesso.' });
}));

router.delete('/periodos/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Só master/coordenador podem excluir períodos avaliativos.' });
  }
  const { id } = req.params;
  // ON DELETE CASCADE em `notas` já apaga as notas lançadas nesse período
  // junto — comportamento esperado: sem o período, a nota não tem contexto.
  const [result] = await pool.query(
    'DELETE FROM periodos_avaliativos WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Período não encontrado.' });
  res.json({ message: 'Período excluído com sucesso.' });
}));

// Pra cada aluno ativo com matrícula, monta o conjunto de categorias
// avaliativas em que ele participa (via categoriaDaTurma de cada turma
// matriculada) — junto com, por categoria, o conjunto de idprofessor que dão
// aula pra ele nela (usado pra decidir o que o professor logado pode ver/
// editar). Uma única query pra toda a instituição; o agrupamento é em JS
// porque categoriaDaTurma depende do nome da turma, não é algo que dê pra
// fazer só em SQL sem duplicar a lógica de detecção em dois lugares.
async function montarParticipacaoPorAluno(inst) {
  // UNION com atividade_professores (co-docência): mesma forma/colunas, só
  // troca `atv.idprofessor` por `ap.idprofessor` — o loop abaixo que monta
  // o Set<idprofessor> por categoria nem precisa saber que existe um segundo
  // professor, só recebe mais uma linha com outro idprofessor pra mesma
  // combinação aluno+turma.
  const [rows] = await pool.query(
    `SELECT m.idaluno AS aluno_id, a.nome AS aluno_nome, atv.nome AS turma_nome, atv.area, atv.idprofessor
     FROM matricula m
     JOIN alunos a ON a.id = m.idaluno AND a.status = 'ativo' AND a.excluido_em IS NULL
     JOIN atividades atv ON atv.idatividades = m.idatividades
     WHERE m.id_instituicao = ? AND m.status = 'matriculado' AND m.data_fim IS NULL
     UNION
     SELECT m.idaluno AS aluno_id, a.nome AS aluno_nome, atv.nome AS turma_nome, atv.area, ap.idprofessor
     FROM matricula m
     JOIN alunos a ON a.id = m.idaluno AND a.status = 'ativo' AND a.excluido_em IS NULL
     JOIN atividades atv ON atv.idatividades = m.idatividades
     JOIN atividade_professores ap ON ap.idatividades = atv.idatividades
     WHERE m.id_instituicao = ? AND m.status = 'matriculado' AND m.data_fim IS NULL`,
    [inst, inst]
  );

  const porAluno = new Map(); // aluno_id -> { nome, categorias: Map<categoria, Set<idprofessor>> }
  for (const row of rows) {
    const categoria = categoriaDaTurma({ area: row.area, nome: row.turma_nome });
    if (!categoria) continue; // tecnologico/capelania/sem área — não avaliado aqui
    if (!porAluno.has(row.aluno_id)) {
      porAluno.set(row.aluno_id, { nome: row.aluno_nome, categorias: new Map() });
    }
    const entry = porAluno.get(row.aluno_id);
    if (!entry.categorias.has(categoria)) entry.categorias.set(categoria, new Set());
    if (row.idprofessor) entry.categorias.get(categoria).add(row.idprofessor);
  }
  return porAluno;
}

// Turmas disponíveis pra escolher antes de lançar nota — pro professor, só
// as DELE (o pedido é que ele veja/lance por turma, não uma lista solta de
// todo aluno que ele dá aula em qualquer lugar); master/coordenador não usa
// esse seletor por padrão (vê todo mundo direto), mas pode passar
// `professor_id` (pedido: "poder selecionar por professores e turmas de cada
// professor") pra ver só as turmas DAQUELE professor escolhido — mesma
// condição de dono-ou-coprofessor usada pro professor logado, só que
// aplicada a um id arbitrário em vez de req.user.id_professor. Só turmas
// cuja categoria é avaliável aqui (TEC/CAP não têm nota nessa tela — ver
// categoriaDaTurma).
router.get('/turmas', asyncHandler(async (req, res) => {
  let sql = `
    SELECT atv.idatividades AS id, atv.nome, atv.area, atv.dia_semana, atv.horario, atv.turno
    FROM atividades atv
    WHERE atv.id_instituicao = ? AND atv.data_fim IS NULL
  `;
  const params = [req.id_instituicao];
  const ehProfessor = req.user.perfil === 'professor';
  const idProfessorFiltro = ehProfessor
    ? req.user.id_professor
    : (['master', 'coordenador'].includes(req.user.perfil) ? req.query.professor_id : null);
  if (ehProfessor && !req.user.id_professor) return res.json([]);
  if (idProfessorFiltro) {
    sql += ' AND (atv.idprofessor = ? OR atv.idatividades IN (SELECT idatividades FROM atividade_professores WHERE idprofessor = ?))';
    params.push(idProfessorFiltro, idProfessorFiltro);
  }
  sql += ' ORDER BY atv.nome ASC, atv.dia_semana ASC, atv.horario ASC';
  const [rows] = await pool.query(sql, params);
  const turmas = rows
    .map(t => ({ ...t, categoria: categoriaDaTurma(t) }))
    .filter(t => t.categoria !== null);
  res.json(turmas);
}));

// Lista de professores ativos da instituição, pra master/coordenador
// escolher "de qual professor" quer ver as turmas (ver GET /turmas acima).
router.get('/professores', asyncHandler(async (req, res) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Só master/coordenador podem listar professores.' });
  }
  const [rows] = await pool.query(
    'SELECT id, nome FROM professores WHERE id_instituicao = ? AND ativo = 1 ORDER BY nome ASC',
    [req.id_instituicao]
  );
  res.json(rows);
}));

// Roster de alunos + notas pra lançar/revisar num período — a unidade é o
// ALUNO, com uma coluna por categoria (só as que ele participa).
//   - master/coordenador: todos os alunos, com TODAS as categorias deles
//     (sem filtro de turma).
//   - professor: só os alunos que ele dá aula, e só a(s) categoria(s) DELE
//     pra cada um — mesmo que o aluno participe de outras categorias com
//     outros professores, essas não aparecem (não é dele, não é da sua conta).
//     Com `id_atividade` informado, filtra pra só os alunos matriculados
//     NAQUELA turma (pedido explícito: professor vê por turma, não todo
//     aluno seu misturado) — a(s) categoria(s) visível(is) continuam sendo
//     só as dele, igual sem o filtro.
router.get('/alunos', asyncHandler(async (req, res) => {
  const { id_periodo, id_atividade } = req.query;
  if (!id_periodo) return res.status(400).json({ error: 'id_periodo é obrigatório.' });

  const [[periodo]] = await pool.query(
    'SELECT id, nome, data_inicio, data_fim FROM periodos_avaliativos WHERE id = ? AND id_instituicao = ?',
    [id_periodo, req.id_instituicao]
  );
  if (!periodo) return res.status(404).json({ error: 'Período avaliativo não encontrado.' });

  const ehProfessor = req.user.perfil === 'professor';
  if (ehProfessor && !req.user.id_professor) return res.json({ periodo, alunos: [] });

  let alunoIdsDaTurma = null;
  if (id_atividade) {
    if (ehProfessor) {
      const [check] = await pool.query(
        `SELECT idatividades FROM atividades
         WHERE idatividades = ? AND id_instituicao = ?
           AND (idprofessor = ? OR idatividades IN (SELECT idatividades FROM atividade_professores WHERE idprofessor = ?))`,
        [id_atividade, req.id_instituicao, req.user.id_professor, req.user.id_professor]
      );
      if (check.length === 0) return res.status(403).json({ error: 'Essa turma não é sua.' });
    }
    const [rosterRows] = await pool.query(
      `SELECT idaluno FROM matricula WHERE idatividades = ? AND id_instituicao = ? AND status = 'matriculado' AND data_fim IS NULL`,
      [id_atividade, req.id_instituicao]
    );
    alunoIdsDaTurma = new Set(rosterRows.map(r => r.idaluno));
  }

  const participacao = await montarParticipacaoPorAluno(req.id_instituicao);

  const [notasExistentes] = await pool.query(
    'SELECT id_aluno, categoria, nota FROM notas WHERE id_periodo = ? AND id_instituicao = ?',
    [id_periodo, req.id_instituicao]
  );
  const notaMap = new Map(notasExistentes.map(n => [`${n.id_aluno}|${n.categoria}`, n.nota !== null ? Number(n.nota) : null]));

  const frequenciaPorAluno = await calcularFrequenciaPorAluno(req.id_instituicao, periodo.data_inicio, periodo.data_fim);
  const frequenciaMap = new Map(frequenciaPorAluno.map(f => [f.aluno_id, f.frequencia_pct]));

  const alunos = [];
  for (const [alunoId, { nome, categorias }] of participacao.entries()) {
    if (alunoIdsDaTurma && !alunoIdsDaTurma.has(alunoId)) continue;
    // Categorias que o usuário logado pode ver/editar pra esse aluno:
    // professor só as suas; master/coordenador, todas as que o aluno tem.
    const categoriasVisiveis = [...categorias.keys()].filter(cat =>
      !ehProfessor || categorias.get(cat).has(req.user.id_professor)
    );
    if (categoriasVisiveis.length === 0) continue; // professor sem nenhuma categoria com esse aluno — não aparece

    const notasPorCategoria = {};
    categoriasVisiveis.forEach(cat => {
      notasPorCategoria[cat] = notaMap.get(`${alunoId}|${cat}`) ?? null;
    });

    // Média fecha com base em TODAS as categorias reais do aluno (não só as
    // visíveis pro professor logado) — senão o professor de uma categoria só
    // fecharia a média sozinho, ignorando as notas de outras categorias que
    // não é dele lançar.
    const frequencia_pct = frequenciaMap.get(alunoId) ?? 0;
    const todasCategorias = [...categorias.keys()];
    const todasNotas = todasCategorias.map(cat => notaMap.get(`${alunoId}|${cat}`) ?? null);
    const completo = todasNotas.length > 0 && todasNotas.every(n => n !== null);
    // frequencia_pct é 0-100; pra entrar na média junto com notas 0-10 precisa
    // estar na mesma escala (69% -> 6.9), senão a média explode (ex.: 29.2).
    const frequencia_escala_10 = frequencia_pct / 10;
    const media = completo
      ? Math.round(((todasNotas.reduce((s, n) => s + n, 0) + frequencia_escala_10) / (todasNotas.length + 1)) * 10) / 10
      : null;

    alunos.push({
      aluno_id: alunoId,
      nome,
      notas: notasPorCategoria,
      frequencia_pct,
      media
    });
  }
  alunos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  res.json({ periodo, categorias: CATEGORIAS_VALIDAS.map(c => ({ chave: c, label: CATEGORIA_LABEL[c] })), alunos });
}));

// Upsert em lote — array de { id_aluno, categoria, nota }, podendo misturar
// alunos e categorias diferentes num POST só (mesmo espírito de "mudanças
// pendentes, salva tudo de uma vez" de AjusteGrade.js). Professor só pode
// enviar item cuja categoria ele realmente ensina pro aluno em questão.
router.post('/', exigir('editar'), asyncHandler(async (req, res) => {
  const { id_periodo, notas } = req.body;
  if (!id_periodo) return res.status(400).json({ error: 'id_periodo é obrigatório.' });
  if (!Array.isArray(notas) || notas.length === 0) return res.status(400).json({ error: 'Nenhuma nota enviada.' });

  const [[periodo]] = await pool.query(
    'SELECT id FROM periodos_avaliativos WHERE id = ? AND id_instituicao = ?',
    [id_periodo, req.id_instituicao]
  );
  if (!periodo) return res.status(404).json({ error: 'Período avaliativo não encontrado.' });

  const ehProfessor = req.user.perfil === 'professor';
  let participacao = null;
  if (ehProfessor) {
    if (!req.user.id_professor) return res.status(403).json({ error: 'Sua conta ainda não está vinculada a um cadastro de educador.' });
    participacao = await montarParticipacaoPorAluno(req.id_instituicao);
  }

  const parseNota = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    // aceita vírgula como decimal (ex.: "3,2") mesmo que o navegador não
    // converta pra ponto sozinho antes de chegar aqui.
    const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
    if (isNaN(n)) return null;
    return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
  };

  const values = [];
  for (const item of notas) {
    if (!CATEGORIAS_VALIDAS.includes(item.categoria)) {
      return res.status(400).json({ error: `Categoria inválida: ${item.categoria}` });
    }
    if (ehProfessor) {
      const entry = participacao.get(item.id_aluno);
      const professoresDaCategoria = entry?.categorias.get(item.categoria);
      if (!professoresDaCategoria || !professoresDaCategoria.has(req.user.id_professor)) {
        return res.status(403).json({ error: `Você não dá aula pra esse inscrito em ${CATEGORIA_LABEL[item.categoria]}.` });
      }
    }
    values.push([req.id_instituicao, id_periodo, item.id_aluno, item.categoria, parseNota(item.nota), req.user.id]);
  }

  await pool.query(
    `INSERT INTO notas (id_instituicao, id_periodo, id_aluno, categoria, nota, lancado_por)
     VALUES ?
     ON DUPLICATE KEY UPDATE nota = VALUES(nota), lancado_por = VALUES(lancado_por)`,
    [values]
  );

  res.json({ message: 'Notas salvas com sucesso.', total: values.length });
}));

module.exports = router;
