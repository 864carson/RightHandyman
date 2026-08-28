const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const EstimateTemplateRepository = require('../models/EstimateTemplate');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/** GET /estimate-templates?trade=&includeInactive=true */
router.get('/', requirePermission(PERMISSIONS.CATALOG_READ), (req, res) => {
  const { trade, includeInactive } = req.query;
  const templates = EstimateTemplateRepository.listByTenant(req.tenant.id, {
    trade,
    includeInactive: includeInactive === 'true'
  });
  res.json(templates);
});

router.get('/:id', requirePermission(PERMISSIONS.CATALOG_READ), (req, res) => {
  const template = EstimateTemplateRepository.findById(req.tenant.id, req.params.id);
  if (!template) return res.status(404).json({ error: 'Estimate template not found' });
  res.json(template);
});

router.post('/', requirePermission(PERMISSIONS.CATALOG_MANAGE), (req, res, next) => {
  try {
    const template = EstimateTemplateRepository.create({
      ...req.body,
      tenantId: req.tenant.id,
      createdBy: req.user.userId
    });
    res.status(201).json(template);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

router.patch('/:id', requirePermission(PERMISSIONS.CATALOG_MANAGE), (req, res, next) => {
  try {
    const updated = EstimateTemplateRepository.update(req.tenant.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Estimate template not found' });
    res.json(updated);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

router.delete('/:id', requirePermission(PERMISSIONS.CATALOG_MANAGE), (req, res) => {
  const removed = EstimateTemplateRepository.delete(req.tenant.id, req.params.id);
  if (!removed) return res.status(404).json({ error: 'Estimate template not found' });
  res.status(204).send();
});

module.exports = router;
