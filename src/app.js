// Monta a aplicação Express. Quem sobe o servidor é server.js (local) ou
// api/index.js (função serverless da Vercel).
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const corsOptions = require('./config/cors');
const noCache = require('./middlewares/noCache');
const auditLog = require('./middlewares/auditLog');
const errorHandler = require('./middlewares/errorHandler');
const routes = require('./routes');

const app = express();

app.use(cors(corsOptions));
app.use(noCache);
app.use(auditLog);
// 50mb por causa da importação da planilha e da foto do aluno (base64).
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use('/api', routes);
app.use(errorHandler);

module.exports = app;
