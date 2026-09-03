const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const configurePassport = require('./config/passport');

const authRoutes = require('./routes/auth');
const tenantRoutes = require('./routes/tenant');
const userRoutes = require('./routes/user');
const customerRoutes = require('./routes/customer');
const opportunityRoutes = require('./routes/opportunity');
const jobRoutes = require('./routes/job');
const estimateRoutes = require('./routes/estimate');
const catalogItemRoutes = require('./routes/catalogItem');
const estimateTemplateRoutes = require('./routes/estimateTemplate');
const publicEstimateRoutes = require('./routes/publicEstimate');
const platformAdminRoutes = require('./routes/platformAdmin');

/**
 * Builds and returns the Express app without starting a listener, so tests
 * can import and exercise it directly via supertest.
 */
function createApp() {
  const app = express();
  const passport = configurePassport();

  app.use(helmet());
  app.use(cors());
  app.use(morgan(process.env.NODE_ENV === 'test' ? 'dev' : 'combined', { skip: () => process.env.NODE_ENV === 'test' }));
  app.use(express.json());
  app.use(cookieParser());

  // Session is only needed to support passport's OAuth handshake state;
  // actual API auth after login is stateless JWT (see middleware/auth.js).
  app.use(
    session({
      secret: process.env.SESSION_SECRET || 'dev-session-secret',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: process.env.NODE_ENV === 'production' }
    })
  );
  app.use(passport.initialize());

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.use('/auth', authRoutes);
  app.use('/tenants', tenantRoutes);
  app.use('/users', userRoutes);
  app.use('/customers', customerRoutes);
  app.use('/opportunities', opportunityRoutes);
  app.use('/jobs', jobRoutes);
  app.use('/estimates', estimateRoutes);
  app.use('/catalog-items', catalogItemRoutes);
  app.use('/estimate-templates', estimateTemplateRoutes);
  // Public, unauthenticated customer-facing estimate view/approve/reject --
  // deliberately mounted with no tenantResolver/requireAuth, see
  // routes/publicEstimate.js for why that's safe.
  app.use('/public/estimates', publicEstimateRoutes);
  // Cross-tenant platform-support access -- deliberately NOT under
  // tenantResolver (see routes/platformAdmin.js for why).
  app.use('/platform-admin', platformAdminRoutes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
  });

  return app;
}

module.exports = createApp;
