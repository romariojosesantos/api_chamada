// Lembrete automático de fim de expediente: pra cada instituição, verifica se
// sobrou algum turno de HOJE com aluno esperado sem NENHUM registro de
// presença ainda (a "Finalizar Chamada" resolveria isso, mas ninguém clicou) —
// se sim, cria UMA notificação institucional resumindo quais turnos.
//
// Rota disparada pelo cron da Vercel (ver "crons" em vercel.json), não por
// usuário logado — por isso fica FORA do bloco de authMiddleware/
// x-institution-id de _server.js (mesmo motivo/posição de estatisticas-
// comparativas.js: essa rota olha TODAS as instituições de uma vez). Protegida
// pelo cabeçalho que a própria Vercel envia (`Authorization: Bearer
// $CRON_SECRET`) quando a variável de ambiente CRON_SECRET está configurada.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { criarNotificacao } = require('./notificacoes-service');
const { hojeBrasil } = require('./data-brasil');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CRON_SECRET = process.env.CRON_SECRET;
if (!CRON_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRON_SECRET não configurado. Defina essa variável de ambiente antes de iniciar o servidor em produção.');
  }
  console.warn('[AVISO] CRON_SECRET não definido — rota de lembrete de chamada aberta sem autenticação em desenvolvimento. NÃO faça isso em produção.');
}

const PERIODO_DA_MATRICULA_SQL = `CASE
  WHEN LOWER(m.turno) LIKE '%manh%' THEN 'manha'
  WHEN LOWER(m.turno) LIKE '%tard%' THEN 'tarde'
  WHEN LOWER(m.turno) LIKE '%noit%' THEN 'noite'
END`;

const PERIODO_LABEL = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

router.get('/', asyncHandler(async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
  }

  const hoje = hojeBrasil();
  const dias = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const diaDaSemana = dias[new Date(`${hoje}T12:00:00`).getDay()];

  // Pra cada instituição+período, quantos alunos esperados hoje ainda estão
  // SEM nenhum registro de presença (mesma condição de "já registrado" usada
  // em POST /api/presenca/finalizar — NULL conta como fallback só fora da
  // noite, pelo mesmo motivo documentado lá: chamada da noite separada é
  // recente, registro antigo sem período nunca pode ter sido dela).
  const [pendentesRows] = await pool.query(
    `SELECT m.id_instituicao, ${PERIODO_DA_MATRICULA_SQL} AS periodo, COUNT(DISTINCT a.id) AS pendentes
     FROM matricula m
     JOIN alunos a ON a.id = m.idaluno AND a.status = 'ativo' AND a.excluido_em IS NULL
     WHERE m.status = 'matriculado' AND m.data_fim IS NULL
       AND TRIM(m.dia_semana) = ? AND m.data_inicio <= ?
       AND NOT EXISTS (
         SELECT 1 FROM dias_sem_aula d WHERE d.data = ? AND d.id_instituicao = m.id_instituicao
       )
       AND NOT EXISTS (
         SELECT 1 FROM presenca p
         WHERE p.aluno_id = a.id AND p.id_instituicao = m.id_instituicao AND DATE(p.data) = ?
           AND (
             p.periodo = ${PERIODO_DA_MATRICULA_SQL}
             OR (p.periodo IS NULL AND ${PERIODO_DA_MATRICULA_SQL} <> 'noite')
           )
       )
     GROUP BY m.id_instituicao, periodo
     HAVING periodo IS NOT NULL AND pendentes > 0`,
    [diaDaSemana, hoje, hoje, hoje]
  );

  const porInstituicao = new Map();
  pendentesRows.forEach(r => {
    if (!porInstituicao.has(r.id_instituicao)) porInstituicao.set(r.id_instituicao, []);
    porInstituicao.get(r.id_instituicao).push({ periodo: r.periodo, pendentes: r.pendentes });
  });

  const notificadas = [];
  for (const [idInstituicao, turnos] of porInstituicao.entries()) {
    // Evita duplicar se essa rota for chamada mais de uma vez no mesmo dia.
    // Janela relativa (últimas 20h) usando só o relógio do PRÓPRIO MySQL
    // (NOW()) de propósito — comparar contra uma data calculada no Node
    // (`hoje`, em America/Sao_Paulo) e o `created_at` do banco depende dos
    // dois relógios (Node e servidor MySQL) estarem sincronizados; num
    // ambiente de teste com o relógio local adiantado/atrasado isso diverge e
    // a notificação duplicava. Como esse cron só roda 1x/dia (ver vercel.json),
    // uma janela de 20h é suficiente pra pegar "já notifiquei hoje" sem
    // depender de fuso horário nenhum.
    const [[jaNotificado]] = await pool.query(
      `SELECT id FROM notificacoes
       WHERE id_instituicao = ? AND tipo = 'chamada_pendente'
         AND created_at >= NOW() - INTERVAL 20 HOUR
       LIMIT 1`,
      [idInstituicao]
    );
    if (jaNotificado) continue;

    const resumo = turnos
      .map(t => `${PERIODO_LABEL[t.periodo] || t.periodo} (${t.pendentes})`)
      .join(', ');

    await criarNotificacao({
      tipo: 'chamada_pendente',
      titulo: 'Chamada de hoje não finalizada',
      mensagem: `Ainda tem inscrito sem nenhum registro de presença hoje: ${resumo}. Finalize a chamada em cada turno pendente.`,
      id_instituicao: idInstituicao
    });
    notificadas.push({ id_instituicao: idInstituicao, turnos });
  }

  res.json({ data: hoje, instituicoes_notificadas: notificadas });
}));

module.exports = router;
