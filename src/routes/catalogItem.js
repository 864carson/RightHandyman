const express = require('express');
const tenantResolver = require('../middleware/tenantResolver');
const { requireAuth } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const { PERMISSIONS } = require('../config/permissions');
const CatalogItemRepository = require('../models/CatalogItem');
const { seedDefaultCatalog } = require('../seed/estimateCatalogSeed');

const router = express.Router();

router.use(tenantResolver());
router.use(requireAuth);

/** GET /catalog-items?trade=&category=&includeInactive=true */
router.get('/', requirePermission(PERMISSIONS.CATALOG_READ), (req, res) => {
  const { trade, category, includeInactive } = req.query;
  const items = CatalogItemRepository.listByTenant(req.tenant.id, {
    trade,
    category,
    includeInactive: includeInactive === 'true'
  });
  res.json(items);
});

router.get('/:id', requirePermission(PERMISSIONS.CATALOG_READ), (req, res) => {
  const item = CatalogItemRepository.findById(req.tenant.id, req.params.id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });
  res.json(item);
});

router.post('/', requirePermission(PERMISSIONS.CATALOG_MANAGE), (req, res, next) => {
  try {
    const item = CatalogItemRepository.create({ ...req.body, tenantId: req.tenant.id, createdBy: req.user.userId });
    res.status(201).json(item);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/**
 * POST /catalog-items/seed-defaults
 * Loads the small built-in starter set (~15 items + a couple of packaged
 * templates across landscaping and drainage) into this tenant. Safe to call
 * more than once -- each call adds a fresh copy rather than erroring, so if
 * a tenant wants to start over they can deactivate/delete what they don't
 * want instead of this endpoint needing to guess at "already seeded".
 */
router.post('/seed-defaults', requirePermission(PERMISSIONS.CATALOG_MANAGE), (req, res) => {
  const result = seedDefaultCatalog(req.tenant.id, req.user.userId);
  res.status(201).json(result);
});

router.patch('/:id', requirePermission(PERMISSIONS.CATALOG_MANAGE), (req, res, next) => {
  try {
    const updated = CatalogItemRepository.update(req.tenant.id, req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Catalog item not found' });
    res.json(updated);
  } catch (err) {
    err.status = err.status || 400;
    next(err);
  }
});

/** Soft delete (active: false) -- hides it from default listings without breaking estimates that already copied its values. */
router.delete('/:id', requirePermission(PERMISSIONS.CATALOG_MANAGE), (req, res) => {
  const deactivated = CatalogItemRepository.deactivate(req.tenant.id, req.params.id);
  if (!deactivated) return res.status(404).json({ error: 'Catalog item not found' });
  res.status(204).send();
});

module.exports = router;
