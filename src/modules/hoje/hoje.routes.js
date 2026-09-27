const express = require('express');
const controller = require('./hoje.controller');

const router = express.Router();
router.get('/', controller.hoje);

module.exports = router;
