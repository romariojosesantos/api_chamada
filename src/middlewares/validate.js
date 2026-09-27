// Middleware de validação: valida req.body contra um schema Joi e responde 400
// com a lista de erros se algo estiver inválido. Os schemas ficam no módulo
// de cada domínio (ex.: src/modules/alunos/alunos.schema.js).
//
// De propósito só usa `error` — o `value` que o Joi devolveria (com os campos
// coagidos pro tipo declarado no schema) é descartado, nunca aplicado de volta
// em `req.body`. Isso importa pro schema de presença, que declara
// `data: Joi.date().iso()`: se um dia alguém "consertar" isso pro jeito
// idiomático do Joi (`const { error, value } = ...; if (!error) req.body = value;`),
// `req.body.data` passaria a chegar na rota de presença como um objeto `Date` (não
// mais a string "YYYY-MM-DD" que os handlers esperam) — reintroduzindo o
// mesmo bug de fuso horário corrigido no frontend (new Date("YYYY-MM-DD") é
// meia-noite UTC), só que agora na GRAVAÇÃO da presença, não só na exibição.
// Antes de mudar isso, reconferir toda rota que usa validate(presencaSchema)/
// validate(alunoSchema) pra garantir que ainda espera strings, não objetos Date.
const validate = (schema) => (req, res, next) => {
  const { error } = schema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      error: 'Falha na validação dos dados',
      details: error.details.map((d) => d.message),
    });
  }
  next();
};

module.exports = { validate };
