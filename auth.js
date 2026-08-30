// Autenticação e administração de usuários.
//
// O "token" usado aqui NÃO é um JWT de biblioteca — é um formato caseiro parecido:
// base64url(JSON do payload) + "." + HMAC-SHA256 desse base64, assinado com TOKEN_SECRET.
// verifyToken confere a assinatura (comparação em tempo constante) e a expiração (`exp`
// embutido no próprio payload) antes de confiar no conteúdo.
const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const { Resend } = require('resend');

const router = express.Router();
const TOKEN_SECRET = process.env.AUTH_SECRET;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // sessão válida por 7 dias
const PERFIS = ['master', 'coordenador', 'professor', 'monitor'];
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'Atos On <onboarding@resend.dev>';
const FRONTEND_URL = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://atoson.com.br' : 'http://localhost:3000');

// AUTH_SECRET é o que impede qualquer pessoa de forjar um token válido. Sem essa
// variável configurada, o servidor não deve subir em produção usando um segredo
// padrão previsível.
if (!TOKEN_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET não configurado. Defina essa variável de ambiente antes de iniciar o servidor em produção.');
  }
  console.warn('[AVISO] AUTH_SECRET não definido — usando segredo fixo de desenvolvimento. NÃO use isso em produção.');
}
const EFFECTIVE_SECRET = TOKEN_SECRET || 'controle-presenca-secret-local';

// Helper para envolver rotas assíncronas e capturar erros
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Hash de senha: scrypt com salt aleatório por usuário, formato armazenado "salt:hash".
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

// Confere a senha contra o hash salvo. Usa timingSafeEqual para não vazar, pelo
// tempo de resposta, quantos bytes do hash bateram.
const verifyPassword = (password, storedHash) => {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
};

// Assina um token de sessão para `payload`, embutindo a expiração (`exp`).
const signToken = (payload) => {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', EFFECTIVE_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
};

// Valida assinatura e expiração de um token. Retorna o payload decodificado, ou
// null se o token for ausente, malformado, adulterado ou expirado.
const verifyToken = (token) => {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', EFFECTIVE_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
};

// Usuários "master" enxergam todas as instituições (não têm vínculo em usuario_instituicoes).
// Os demais perfis só acessam as instituições explicitamente vinculadas a eles.
const loadUserInstitutions = async (userId, perfil) => {
  if (perfil === 'master') return [];
  const [rows] = await pool.query('SELECT id_instituicao FROM usuario_instituicoes WHERE id_usuario = ?', [userId]);
  return rows.map(row => row.id_instituicao);
};

// Monta o objeto de sessão do usuário (o que vai dentro do token e é devolvido ao front).
// `id_professor` (quando presente) liga essa conta de login a um cadastro em
// `professores` — é o que permite telas como Grade.js saberem "este usuário
// logado É o professor X" sem precisar perguntar (ver PUT /admin/usuarios/:id,
// onde o master faz esse vínculo manualmente).
const buildUserSession = async (userRow) => {
  const instituicoes = await loadUserInstitutions(userRow.id, userRow.perfil);
  return {
    id: userRow.id,
    nome: userRow.nome,
    email: userRow.email,
    perfil: userRow.perfil,
    id_professor: userRow.id_professor || null,
    instituicoes
  };
};

// Middleware: exige um Bearer token válido em Authorization e popula req.user.
// Usado tanto nas rotas de /api/auth quanto (via _server.js) em todas as rotas de /api.
const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
  req.user = payload;
  next();
};

router.get('/instituicoes', asyncHandler(async (req, res) => {
  const [results] = await pool.query('SELECT id, nome FROM instituicoes ORDER BY nome ASC');
  res.json(results);
}));

// Usado pelo front para saber se ainda não existe nenhum usuário master (fluxo de setup inicial).
router.get('/has-master', asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM usuarios WHERE perfil = ? LIMIT 1', ['master']);
  res.json({ hasMaster: rows.length > 0 });
}));

// --- Validação de campos de usuário (compartilhada entre register/admin create/admin update) ---
// Retorna uma mensagem de erro (string) se algo for inválido, ou null se estiver tudo certo.
const validarCamposUsuario = ({ nome, email, senha, perfil, exigirSenha = true }) => {
  if (nome.length < 3) return 'Informe um nome com pelo menos 3 caracteres.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Informe um e-mail válido.';
  if (exigirSenha && senha.length < 6) return 'A senha deve ter pelo menos 6 caracteres.';
  if (!PERFIS.includes(perfil)) return 'Perfil inválido.';
  return null;
};

// Resolve e valida o vínculo usuario<->professor (ver comentário em
// buildUserSession): só se aplica a perfil "professor", e o professor
// escolhido precisa pertencer a uma das instituições selecionadas pro
// usuário — evita vincular por engano a um professor de outra instituição.
// Retorna { idProfessorFinal } em caso de sucesso, ou { erro } se inválido.
const resolverIdProfessor = async (cleanPerfil, id_professor, selectedInstitutions) => {
  if (cleanPerfil !== 'professor' || !id_professor) return { idProfessorFinal: null };

  const [profRows] = await pool.query('SELECT id, id_instituicao FROM professores WHERE id = ?', [id_professor]);
  if (profRows.length === 0) return { erro: 'Professor não encontrado.' };
  if (!selectedInstitutions.includes(profRows[0].id_instituicao)) {
    return { erro: 'Esse professor pertence a uma instituição não vinculada a este usuário.' };
  }
  return { idProfessorFinal: profRows[0].id };
};

// Avisa todo master ativo por e-mail quando um cadastro novo fica pendente de
// aprovação, com um link pra aprovar direto (ver GET/POST
// /aprovar-cadastro/:token abaixo). O token reaproveita signToken/verifyToken
// (mesmo esquema HMAC do token de sessão) com um payload próprio — o `tipo`
// evita que esse token sirva pra qualquer outra coisa além dessa aprovação
// específica. O link abre uma página de confirmação no front (não aprova
// sozinho com um GET) pra não correr risco de scanners de e-mail que pré-
// carregam links dispararem uma aprovação sem ninguém ter clicado de verdade.
const notificarMastersNovoCadastro = async ({ id, nome, email, perfil }) => {
  if (!resend) {
    console.warn(`[AVISO] RESEND_API_KEY não configurada — masters não notificados sobre o cadastro pendente de ${email}.`);
    return;
  }
  const [masters] = await pool.query('SELECT email FROM usuarios WHERE perfil = ? AND status = ?', ['master', 'ativo']);
  if (masters.length === 0) return;

  const token = signToken({ usuarioId: id, tipo: 'aprovacao_cadastro' });
  const link = `${FRONTEND_URL}/aprovar-cadastro/${token}`;

  await resend.emails.send({
    from: RESEND_FROM,
    to: masters.map(m => m.email),
    subject: 'Novo cadastro aguardando aprovação — Atos On',
    html: `<p>Um novo cadastro está aguardando sua aprovação:</p>
      <p><b>Nome:</b> ${nome}<br><b>E-mail:</b> ${email}<br><b>Perfil:</b> ${perfil}</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">Ver e aprovar cadastro</a></p>
      <p>Ou copie e cole este link no navegador: ${link}</p>`
  });
};

// Autocadastro. Usuários não-master entram com status "pendente" e precisam ser
// aprovados por um master antes de conseguir logar (ver /admin/usuarios/:id/aprovar).
// O primeiro master do sistema é a exceção: já entra "ativo" e logado.
router.post('/register', asyncHandler(async (req, res) => {
  const { nome, email, senha, perfil, id_instituicao } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(senha || '');
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const institutionId = parseInt(id_instituicao);

  const erro = validarCamposUsuario({ nome: cleanName, email: cleanEmail, senha: cleanPassword, perfil: cleanPerfil });
  if (erro) return res.status(400).json({ error: erro });
  if (cleanPerfil !== 'master' && isNaN(institutionId)) return res.status(400).json({ error: 'Selecione a instituição vinculada ao usuário.' });

  const [existing] = await pool.query('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [cleanEmail]);
  if (existing.length > 0) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  // Só pode existir um master no sistema — é ele quem aprova todos os outros cadastros.
  if (cleanPerfil === 'master') {
    const [masterCheck] = await pool.query('SELECT id FROM usuarios WHERE perfil = ? LIMIT 1', ['master']);
    if (masterCheck.length > 0) {
      return res.status(403).json({ error: 'Já existe um usuário master no sistema. Contate o administrador.' });
    }
  }

  const senha_hash = hashPassword(cleanPassword);
  const status = cleanPerfil === 'master' ? 'ativo' : 'pendente';
  const [result] = await pool.query('INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?, ?, ?, ?, ?)', [cleanName, cleanEmail, senha_hash, cleanPerfil, status]);
  if (cleanPerfil !== 'master') {
    await pool.query('INSERT IGNORE INTO usuario_instituicoes (id_usuario, id_instituicao) VALUES (?, ?)', [result.insertId, institutionId]);
  }

  if (status === 'pendente') {
    notificarMastersNovoCadastro({ id: result.insertId, nome: cleanName, email: cleanEmail, perfil: cleanPerfil }).catch(e =>
      console.error('Erro ao notificar masters sobre novo cadastro pendente:', e)
    );
    return res.status(201).json({ message: 'Cadastro realizado. Aguarde aprovação do master para acessar o sistema.' });
  }

  const user = { id: result.insertId, nome: cleanName, email: cleanEmail, perfil: cleanPerfil, instituicoes: cleanPerfil === 'master' ? [] : [institutionId] };
  const token = signToken(user);

  res.status(201).json({ message: 'Usuário registrado com sucesso.', token, user });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');

  const [rows] = await pool.query('SELECT id, nome, email, senha_hash, perfil, status, id_professor FROM usuarios WHERE email = ? LIMIT 1', [email]);
  // Mensagem de erro deliberadamente genérica (não diz se foi o e-mail ou a senha
  // que errou) para não ajudar a enumerar quais e-mails estão cadastrados.
  if (rows.length === 0 || !verifyPassword(senha, rows[0].senha_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  if (rows[0].status === 'pendente') {
    return res.status(403).json({ error: 'Cadastro pendente de aprovação. Aguarde liberação do master.', status: 'pendente' });
  }

  if (rows[0].status !== 'ativo') {
    return res.status(403).json({ error: 'Conta inativa. Entre em contato com o administrador.', status: rows[0].status });
  }

  const user = await buildUserSession(rows[0]);
  const token = signToken(user);

  res.json({ message: 'Login realizado com sucesso.', token, user });
}));

// Usado pelo front para revalidar a sessão ao carregar a página (token salvo no localStorage).
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT id, nome, email, perfil, status, id_professor FROM usuarios WHERE id = ? LIMIT 1', [req.user.id]);
  if (rows.length === 0) return res.status(401).json({ error: 'Usuário não encontrado.' });
  const user = await buildUserSession(rows[0]);
  res.json({ user: { ...user, status: rows[0].status } });
}));

router.post('/change-password', authMiddleware, asyncHandler(async (req, res) => {
  const senhaAtual = String(req.body.senhaAtual || '');
  const novaSenha = String(req.body.novaSenha || '');

  if (novaSenha.length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });

  const [rows] = await pool.query('SELECT senha_hash FROM usuarios WHERE id = ? AND status = ? LIMIT 1', [req.user.id, 'ativo']);
  if (rows.length === 0 || !verifyPassword(senhaAtual, rows[0].senha_hash)) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }

  await pool.query('UPDATE usuarios SET senha_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hashPassword(novaSenha), req.user.id]);
  res.json({ message: 'Senha alterada com sucesso.' });
}));

// --- Redefinição de senha por e-mail (usuário deslogado, esqueceu a senha) ---
// Reaproveita hashPassword/verifyPassword (scrypt) pra guardar e conferir o
// código também com hash — não fica em texto puro no banco.
const RESET_CODE_TTL_MS = 15 * 60 * 1000; // código válido por 15 minutos
const RESET_REQUEST_COOLDOWN_MS = 60 * 1000; // evita pedir um código novo a cada poucos segundos

router.post('/forgot-password', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  // Resposta sempre igual, exista ou não o e-mail — não dá pra usar essa rota
  // pra descobrir quais e-mails estão cadastrados no sistema.
  const respostaGenerica = { message: 'Se este e-mail estiver cadastrado, um código de verificação foi enviado.' };
  if (!email) return res.status(400).json({ error: 'Informe o e-mail.' });

  const [rows] = await pool.query('SELECT id, nome, status, reset_codigo_expira FROM usuarios WHERE email = ? LIMIT 1', [email]);
  if (rows.length === 0 || rows[0].status !== 'ativo') return res.json(respostaGenerica);
  const usuario = rows[0];

  if (usuario.reset_codigo_expira) {
    const criadoEm = new Date(usuario.reset_codigo_expira).getTime() - RESET_CODE_TTL_MS;
    if (Date.now() - criadoEm < RESET_REQUEST_COOLDOWN_MS) return res.json(respostaGenerica);
  }

  const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expira = new Date(Date.now() + RESET_CODE_TTL_MS);
  await pool.query('UPDATE usuarios SET reset_codigo_hash = ?, reset_codigo_expira = ? WHERE id = ?', [hashPassword(codigo), expira, usuario.id]);

  if (resend) {
    try {
      await resend.emails.send({
        from: RESEND_FROM,
        to: email,
        subject: 'Código para redefinir sua senha — Atos On',
        html: `<p>Olá, ${usuario.nome}.</p><p>Seu código de verificação é:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;">${codigo}</p><p>Ele expira em 15 minutos. Se você não pediu essa redefinição, ignore este e-mail.</p>`
      });
    } catch (e) {
      console.error('Erro ao enviar e-mail de redefinição de senha:', e);
    }
  } else {
    console.warn(`[AVISO] RESEND_API_KEY não configurada — código gerado mas não enviado por e-mail (${email}): ${codigo}`);
  }

  res.json(respostaGenerica);
}));

router.post('/reset-password', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const codigo = String(req.body.codigo || '').trim();
  const novaSenha = String(req.body.novaSenha || '');
  const erroGenerico = { error: 'Código inválido ou expirado.' };

  if (novaSenha.length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });
  if (!codigo) return res.status(400).json(erroGenerico);

  const [rows] = await pool.query('SELECT id, reset_codigo_hash, reset_codigo_expira FROM usuarios WHERE email = ? AND status = ? LIMIT 1', [email, 'ativo']);
  if (rows.length === 0 || !rows[0].reset_codigo_hash || !rows[0].reset_codigo_expira) return res.status(400).json(erroGenerico);

  const usuario = rows[0];
  if (new Date(usuario.reset_codigo_expira).getTime() < Date.now()) return res.status(400).json(erroGenerico);
  if (!verifyPassword(codigo, usuario.reset_codigo_hash)) return res.status(400).json(erroGenerico);

  await pool.query(
    'UPDATE usuarios SET senha_hash = ?, reset_codigo_hash = NULL, reset_codigo_expira = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [hashPassword(novaSenha), usuario.id]
  );
  res.json({ message: 'Senha redefinida com sucesso.' });
}));

// --- Aprovação de cadastro por link de e-mail (sem precisar estar logado). ---
// Valida o token (ver notificarMastersNovoCadastro) antes de expor ou alterar
// qualquer coisa — GET só lê (pra tela de confirmação no front mostrar quem
// é), POST é quem de fato aprova.
const validarTokenAprovacao = (token) => {
  const payload = verifyToken(token);
  if (!payload || payload.tipo !== 'aprovacao_cadastro' || !payload.usuarioId) return null;
  return payload;
};

router.get('/aprovar-cadastro/:token', asyncHandler(async (req, res) => {
  const payload = validarTokenAprovacao(req.params.token);
  if (!payload) return res.status(400).json({ error: 'Link inválido ou expirado.' });

  const [rows] = await pool.query('SELECT nome, email, perfil, status FROM usuarios WHERE id = ? LIMIT 1', [payload.usuarioId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Cadastro não encontrado.' });

  res.json({ nome: rows[0].nome, email: rows[0].email, perfil: rows[0].perfil, jaAprovado: rows[0].status !== 'pendente' });
}));

router.post('/aprovar-cadastro/:token', asyncHandler(async (req, res) => {
  const payload = validarTokenAprovacao(req.params.token);
  if (!payload) return res.status(400).json({ error: 'Link inválido ou expirado.' });

  const [rows] = await pool.query('SELECT status FROM usuarios WHERE id = ? LIMIT 1', [payload.usuarioId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Cadastro não encontrado.' });
  // Idempotente: se já foi aprovado (por outro master, ou clique duplo no link),
  // responde sucesso do mesmo jeito em vez de erro — o resultado desejado já existe.
  if (rows[0].status === 'pendente') {
    await pool.query('UPDATE usuarios SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['ativo', payload.usuarioId]);
  }

  res.json({ message: 'Cadastro aprovado com sucesso.' });
}));

// Middleware: exige que o usuário autenticado tenha perfil "master".
// Deve vir sempre depois de authMiddleware (depende de req.user já estar populado).
const masterMiddleware = (req, res, next) => {
  if (req.user?.perfil !== 'master') {
    return res.status(403).json({ error: 'Acesso restrito a master.' });
  }
  next();
};

// --- Administração de usuários (todas as rotas abaixo exigem perfil master) ---

// Lista os professores (id + nome) de uma instituição — usado pela tela de
// Admin Usuários pra vincular uma conta de login (perfil "professor") ao
// cadastro de professor correspondente. Diferente de GET /api/professores
// (rota pública de instituição, só devolve nomes): aqui devolve o id de
// verdade, que é o que vai pra usuarios.id_professor.
router.get('/admin/professores', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const idInstituicao = parseInt(req.query.id_instituicao);
  if (isNaN(idInstituicao)) return res.status(400).json({ error: 'id_instituicao é obrigatório.' });

  const [rows] = await pool.query(
    'SELECT id, nome, id_instituicao FROM professores WHERE id_instituicao = ? ORDER BY nome ASC',
    [idInstituicao]
  );
  res.json(rows);
}));

router.get('/admin/usuarios', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const [users] = await pool.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.status, u.created_at, u.id_professor, p.nome AS nome_professor
     FROM usuarios u
     LEFT JOIN professores p ON p.id = u.id_professor
     WHERE u.status != ? ORDER BY u.nome ASC`,
    ['pendente']
  );
  const result = [];
  for (const user of users) {
    const instituicoes = user.perfil === 'master' ? [] : await loadUserInstitutions(user.id, user.perfil);
    result.push({ ...user, instituicoes });
  }
  res.json(result);
}));

router.get('/admin/usuarios/pendentes', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const [users] = await pool.query('SELECT id, nome, email, perfil, status, created_at FROM usuarios WHERE status = ? ORDER BY created_at ASC', ['pendente']);
  const result = [];
  for (const user of users) {
    const instituicoes = user.perfil === 'master' ? [] : await loadUserInstitutions(user.id, user.perfil);
    result.push({ ...user, instituicoes });
  }
  res.json(result);
}));

router.put('/admin/usuarios/:id/aprovar', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });

  const [rows] = await pool.query('SELECT status FROM usuarios WHERE id = ? LIMIT 1', [userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (rows[0].status !== 'pendente') return res.status(400).json({ error: 'Este usuário não está pendente de aprovação.' });

  await pool.query('UPDATE usuarios SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['ativo', userId]);
  res.json({ message: 'Usuário aprovado com sucesso.' });
}));

router.delete('/admin/usuarios/:id/rejeitar', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });

  const [rows] = await pool.query('SELECT status FROM usuarios WHERE id = ? LIMIT 1', [userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (rows[0].status !== 'pendente') return res.status(400).json({ error: 'Este usuário não está pendente de aprovação.' });

  await pool.query('DELETE FROM usuario_instituicoes WHERE id_usuario = ?', [userId]);
  await pool.query('DELETE FROM usuarios WHERE id = ?', [userId]);
  res.json({ message: 'Cadastro rejeitado e removido com sucesso.' });
}));

// Criação direta de usuário pelo master (pula o fluxo de aprovação — já entra ativo,
// pois não recebe status 'pendente' aqui).
router.post('/admin/usuarios', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const { nome, email, senha, perfil, instituicoes, id_professor } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(senha || '');
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const selectedInstitutions = Array.isArray(instituicoes) ? instituicoes.map(Number).filter(Boolean) : [];

  const erro = validarCamposUsuario({ nome: cleanName, email: cleanEmail, senha: cleanPassword, perfil: cleanPerfil });
  if (erro) return res.status(400).json({ error: erro });
  if (cleanPerfil !== 'master' && selectedInstitutions.length === 0) return res.status(400).json({ error: 'Vincule ao menos uma instituição ao usuário.' });

  const [existing] = await pool.query('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [cleanEmail]);
  if (existing.length > 0) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const { idProfessorFinal, erro: erroProfessor } = await resolverIdProfessor(cleanPerfil, id_professor, selectedInstitutions);
  if (erroProfessor) return res.status(400).json({ error: erroProfessor });

  const [result] = await pool.query('INSERT INTO usuarios (nome, email, senha_hash, perfil, id_professor) VALUES (?, ?, ?, ?, ?)', [cleanName, cleanEmail, hashPassword(cleanPassword), cleanPerfil, idProfessorFinal]);
  const userId = result.insertId;

  for (const idInst of selectedInstitutions) {
    await pool.query('INSERT IGNORE INTO usuario_instituicoes (id_usuario, id_instituicao) VALUES (?, ?)', [userId, idInst]);
  }

  res.status(201).json({ message: 'Usuário criado com sucesso.', id: userId });
}));

router.put('/admin/usuarios/:id', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const { nome, email, perfil, instituicoes, status, id_professor } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const selectedInstitutions = Array.isArray(instituicoes) ? instituicoes.map(Number).filter(Boolean) : [];
  const cleanStatus = String(status || '').trim().toLowerCase();

  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });
  const erro = validarCamposUsuario({ nome: cleanName, email: cleanEmail, senha: '', perfil: cleanPerfil, exigirSenha: false });
  if (erro) return res.status(400).json({ error: erro });
  if (cleanPerfil !== 'master' && selectedInstitutions.length === 0) return res.status(400).json({ error: 'Vincule ao menos uma instituição ao usuário.' });
  if (cleanStatus && !['ativo', 'inativo', 'pendente'].includes(cleanStatus)) return res.status(400).json({ error: 'Status inválido.' });

  const [existing] = await pool.query('SELECT id FROM usuarios WHERE email = ? AND id != ? LIMIT 1', [cleanEmail, userId]);
  if (existing.length > 0) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const { idProfessorFinal, erro: erroProfessor } = await resolverIdProfessor(cleanPerfil, id_professor, selectedInstitutions);
  if (erroProfessor) return res.status(400).json({ error: erroProfessor });

  const updates = [cleanName, cleanEmail, cleanPerfil, idProfessorFinal];
  let statusSql = '';
  if (cleanStatus) {
    updates.push(cleanStatus);
    statusSql = ', status = ?';
  }

  await pool.query(`UPDATE usuarios SET nome = ?, email = ?, perfil = ?, id_professor = ?${statusSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...updates, userId]);
  // Vínculos de instituição são substituídos por completo (apaga tudo e recria) em
  // vez de calcular um diff — mais simples e o volume de linhas por usuário é pequeno.
  await pool.query('DELETE FROM usuario_instituicoes WHERE id_usuario = ?', [userId]);
  for (const idInst of selectedInstitutions) {
    await pool.query('INSERT IGNORE INTO usuario_instituicoes (id_usuario, id_instituicao) VALUES (?, ?)', [userId, idInst]);
  }

  res.json({ message: 'Usuário atualizado com sucesso.' });
}));

router.put('/admin/usuarios/:id/senha', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const novaSenha = String(req.body.senha || '');
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });
  if (novaSenha.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  await pool.query('UPDATE usuarios SET senha_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hashPassword(novaSenha), userId]);
  res.json({ message: 'Senha redefinida com sucesso.' });
}));

// Middleware: exige perfil master OU coordenador. Deve vir depois de authMiddleware.
const coordenadorOuMasterMiddleware = (req, res, next) => {
  if (req.user?.perfil !== 'master' && req.user?.perfil !== 'coordenador') {
    return res.status(403).json({ error: 'Acesso restrito a master ou coordenador.' });
  }
  next();
};

// --- Vínculo conta-de-login <-> cadastro de professor, para coordenador. ---
// Versão enxuta de PUT /admin/usuarios/:id: mexe SÓ em id_professor, nunca em
// nome/e-mail/perfil/instituições/status/senha — isso continua exclusivo do
// admin de usuários (master-only). Um coordenador só enxerga/edita contas
// "professor" que compartilham instituição com ele (checado em cada rota
// abaixo via req.user.instituicoes); master vê tudo, sem essa checagem.

router.get('/vincular-professor/usuarios', authMiddleware, coordenadorOuMasterMiddleware, asyncHandler(async (req, res) => {
  const ehMaster = req.user.perfil === 'master';
  if (!ehMaster && req.user.instituicoes.length === 0) return res.json([]);

  const [rows] = await pool.query(
    `SELECT u.id, u.nome, u.email, u.id_professor, p.nome AS nome_professor
     FROM usuarios u
     LEFT JOIN professores p ON p.id = u.id_professor
     WHERE u.perfil = 'professor' AND u.status != 'pendente'
     ORDER BY u.nome ASC`
  );
  const result = [];
  for (const user of rows) {
    const instituicoes = await loadUserInstitutions(user.id, 'professor');
    if (!ehMaster && !instituicoes.some(id => req.user.instituicoes.includes(id))) continue;
    result.push({ ...user, instituicoes });
  }
  res.json(result);
}));

router.get('/vincular-professor/professores', authMiddleware, coordenadorOuMasterMiddleware, asyncHandler(async (req, res) => {
  const idInstituicao = parseInt(req.query.id_instituicao);
  if (isNaN(idInstituicao)) return res.status(400).json({ error: 'id_instituicao é obrigatório.' });
  if (req.user.perfil !== 'master' && !req.user.instituicoes.includes(idInstituicao)) {
    return res.status(403).json({ error: 'Você não tem acesso a essa instituição.' });
  }
  const [rows] = await pool.query('SELECT id, nome, id_instituicao FROM professores WHERE id_instituicao = ? ORDER BY nome ASC', [idInstituicao]);
  res.json(rows);
}));

router.put('/vincular-professor/usuarios/:id', authMiddleware, coordenadorOuMasterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const { id_professor } = req.body;
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });

  const [rows] = await pool.query('SELECT id, perfil FROM usuarios WHERE id = ? LIMIT 1', [userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (rows[0].perfil !== 'professor') return res.status(400).json({ error: 'Esse usuário não tem perfil professor.' });

  const instituicoesDoUsuario = await loadUserInstitutions(userId, 'professor');
  if (req.user.perfil !== 'master' && !instituicoesDoUsuario.some(id => req.user.instituicoes.includes(id))) {
    return res.status(403).json({ error: 'Você não tem acesso a esse usuário.' });
  }

  const { idProfessorFinal, erro: erroProfessor } = await resolverIdProfessor('professor', id_professor, instituicoesDoUsuario);
  if (erroProfessor) return res.status(400).json({ error: erroProfessor });

  await pool.query('UPDATE usuarios SET id_professor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [idProfessorFinal, userId]);
  res.json({ message: 'Vínculo atualizado com sucesso.' });
}));

module.exports = { router, authMiddleware, masterMiddleware };
